import { loadConfig, isLiveAllowed, type Config } from '../trading/config.js';
import { logger } from '../lib/logger.js';

export interface AlpacaCredentials {
  keyId: string;
  secretKey: string;
  paper: boolean;
  baseUrl: string;
  dataBaseUrl: string;
}

export function resolveCredentials(cfg: Config = loadConfig()): AlpacaCredentials {
  if (!cfg.ALPACA_KEY_ID || !cfg.ALPACA_SECRET_KEY) {
    throw new Error('ALPACA_KEY_ID and ALPACA_SECRET_KEY must be set');
  }
  const paper = !isLiveAllowed(cfg);
  if (cfg.TRADING_MODE === 'live' && paper) {
    logger.warn(
      'TRADING_MODE=live but LIVE_TRADING_CONFIRMED is not "yes-i-mean-it" — falling back to paper trading',
    );
  }
  const baseUrl = paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
  const dataBaseUrl = 'https://data.alpaca.markets';
  return {
    keyId: cfg.ALPACA_KEY_ID,
    secretKey: cfg.ALPACA_SECRET_KEY,
    paper,
    baseUrl,
    dataBaseUrl,
  };
}

export interface AlpacaClient {
  // Account + market info
  getClock(): Promise<{ is_open: boolean; next_open: string; next_close: string }>;
  getAccount(): Promise<{
    cash: string;
    equity: string;
    portfolio_value: string;
    // Cash account additions (paper accounts return these too):
    cash_withdrawable?: string;
    pending_transfer_in?: string;
  }>;
  /**
   * Returns USD cash that is settled (T+1) and available to commit to new buys
   * on a cash account. Excludes proceeds from sells filled today (still
   * unsettled until next session).
   */
  getSettledCash(): Promise<number>;
  getPositions(): Promise<
    Array<{
      symbol: string;
      qty: string;
      avg_entry_price: string;
      current_price: string;
      unrealized_plpc: string;
    }>
  >;
  /**
   * Returns sell orders filled today; their proceeds are not settled until
   * next session under T+1 (cash-account constraint).
   */
  getOrders(opts: { status: 'closed' | 'open' | 'all'; after?: string; until?: string; limit?: number }): Promise<
    Array<{
      id: string;
      symbol: string;
      side: 'buy' | 'sell';
      status: string;
      filled_avg_price: string | null;
      filled_qty: string | null;
      filled_at: string | null;
      submitted_at: string;
      type: string;
      qty: string | null;
      notional: string | null;
    }>
  >;

  // Bars
  getBars(symbol: string, opts: { timeframe: string; start: string; end?: string; limit?: number }): Promise<
    Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>
  >;
  getLatestQuote(symbol: string): Promise<{ ap: number; bp: number; t: string }>;

  // Orders
  submitBracket(args: {
    symbol: string;
    side: 'buy' | 'sell';
    qty: number;
    entryType: 'market' | 'stop' | 'limit';
    entryTriggerPrice?: number;
    stopLossPrice: number;
    timeInForce: 'day' | 'gtc';
    extendedHours?: boolean;
  }): Promise<{ id: string; status: string; legs: Array<{ id: string; order_class: string }> }>;
  /**
   * Notional buy with deferred protective stop. Cash-account / fractional friendly.
   * Submits the parent buy as `notional` (USD), then on fill attaches a stop-loss
   * order with the actual filled fractional qty. Returns both order ids.
   */
  submitNotionalBracket(args: {
    symbol: string;
    side: 'buy';
    notionalUsd: number;
    entryType: 'market' | 'stop' | 'limit';
    entryTriggerPrice?: number;
    stopLossPrice: number;
    timeInForce: 'day' | 'gtc';
    extendedHours?: boolean;
    waitForFillMs?: number; // poll budget for fill confirmation
  }): Promise<{
    parentOrderId: string;
    parentStatus: string;
    filledQty?: number;
    filledAvgPrice?: number;
    stopOrderId?: string;
    stopStatus?: string;
    stopError?: string;
  }>;
  submitTrailingStop(args: {
    symbol: string;
    side: 'sell';
    qty: number;
    trailPercent: number;
  }): Promise<{ id: string; status: string }>;
  submitMarket(args: { symbol: string; side: 'buy' | 'sell'; qty: number }): Promise<{ id: string; status: string }>;
  submitStop(args: {
    symbol: string;
    side: 'buy' | 'sell';
    qty: number;
    stopPrice: number;
    timeInForce: 'day' | 'gtc';
  }): Promise<{ id: string; status: string }>;
  cancelOrder(orderId: string): Promise<void>;
  getOrder(orderId: string): Promise<{
    id: string;
    status: string;
    filled_avg_price: string | null;
    filled_qty: string | null;
    filled_at: string | null;
  }>;
}

/**
 * Real REST client. Uses fetch (undici under the hood). Kept thin so we can
 * swap to the official SDK if we ever want streaming.
 */
export function createRestClient(cfg: Config = loadConfig()): AlpacaClient {
  const creds = resolveCredentials(cfg);
  const headers = {
    'APCA-API-KEY-ID': creds.keyId,
    'APCA-API-SECRET-KEY': creds.secretKey,
    'Content-Type': 'application/json',
  };

  async function tradingFetch(path: string, init?: RequestInit) {
    const res = await fetch(`${creds.baseUrl}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Alpaca ${init?.method ?? 'GET'} ${path} ${res.status}: ${body}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async function dataFetch(path: string) {
    const res = await fetch(`${creds.dataBaseUrl}${path}`, { headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Alpaca data GET ${path} ${res.status}: ${body}`);
    }
    return res.json();
  }

  return {
    async getClock() {
      return tradingFetch('/v2/clock');
    },
    async getAccount() {
      return tradingFetch('/v2/account');
    },
    async getSettledCash() {
      // Strategy: account.cash on a cash account is total cash, including unsettled
      // proceeds from today's sells. Subtract today's filled-sell notional to get
      // settled, available-for-buys cash.
      const account = await tradingFetch('/v2/account');
      const cash = parseFloat(account.cash);
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const sells = (await tradingFetch(
        `/v2/orders?status=closed&after=${encodeURIComponent(todayStart.toISOString())}&limit=200`,
      )) as Array<{
        side: 'buy' | 'sell';
        status: string;
        filled_qty: string | null;
        filled_avg_price: string | null;
        notional: string | null;
      }> | null;
      let unsettled = 0;
      for (const o of sells ?? []) {
        if (o.side !== 'sell' || o.status !== 'filled') continue;
        const qty = o.filled_qty ? parseFloat(o.filled_qty) : 0;
        const price = o.filled_avg_price ? parseFloat(o.filled_avg_price) : 0;
        const proceeds = qty && price ? qty * price : o.notional ? parseFloat(o.notional) : 0;
        unsettled += proceeds;
      }
      return Math.max(0, cash - unsettled);
    },
    async getPositions() {
      return (await tradingFetch('/v2/positions')) ?? [];
    },
    async getOrders({ status, after, until, limit }) {
      const params = new URLSearchParams({ status });
      if (after) params.set('after', after);
      if (until) params.set('until', until);
      if (limit) params.set('limit', String(limit));
      return (await tradingFetch(`/v2/orders?${params}`)) ?? [];
    },
    async getBars(symbol, { timeframe, start, end, limit }) {
      const params = new URLSearchParams({ timeframe, start });
      if (end) params.set('end', end);
      if (limit) params.set('limit', String(limit));
      const data = await dataFetch(`/v2/stocks/${encodeURIComponent(symbol)}/bars?${params}`);
      return data.bars ?? [];
    },
    async getLatestQuote(symbol) {
      const data = await dataFetch(`/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`);
      return data.quote;
    },
    async submitBracket({
      symbol,
      side,
      qty,
      entryType,
      entryTriggerPrice,
      stopLossPrice,
      timeInForce,
      extendedHours,
    }) {
      const body: Record<string, unknown> = {
        symbol,
        qty,
        side,
        time_in_force: timeInForce,
        order_class: 'bracket',
        stop_loss: { stop_price: round2(stopLossPrice) },
      };
      if (entryType === 'market') {
        body.type = 'market';
      } else if (entryType === 'stop') {
        if (entryTriggerPrice === undefined) throw new Error('stop entry requires entryTriggerPrice');
        body.type = 'stop';
        body.stop_price = round2(entryTriggerPrice);
      } else if (entryType === 'limit') {
        if (entryTriggerPrice === undefined) throw new Error('limit entry requires entryTriggerPrice');
        body.type = 'limit';
        body.limit_price = round2(entryTriggerPrice);
      }
      if (extendedHours) body.extended_hours = true;
      return tradingFetch('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
    },
    async submitNotionalBracket({
      symbol,
      side,
      notionalUsd,
      entryType,
      entryTriggerPrice,
      stopLossPrice,
      timeInForce,
      extendedHours,
      waitForFillMs = 30_000,
    }) {
      // Step 1: notional parent buy. Alpaca's bracket order_class doesn't accept
      // notional on the stop child leg, so we submit the parent alone first.
      const parentBody: Record<string, unknown> = {
        symbol,
        notional: round2(notionalUsd),
        side,
        time_in_force: timeInForce,
      };
      if (entryType === 'market') {
        parentBody.type = 'market';
      } else if (entryType === 'stop') {
        if (entryTriggerPrice === undefined) throw new Error('stop entry requires entryTriggerPrice');
        parentBody.type = 'stop';
        parentBody.stop_price = round2(entryTriggerPrice);
      } else if (entryType === 'limit') {
        if (entryTriggerPrice === undefined) throw new Error('limit entry requires entryTriggerPrice');
        parentBody.type = 'limit';
        parentBody.limit_price = round2(entryTriggerPrice);
      }
      if (extendedHours) parentBody.extended_hours = true;

      const parent = (await tradingFetch('/v2/orders', {
        method: 'POST',
        body: JSON.stringify(parentBody),
      })) as { id: string; status: string };

      // Step 2: poll for fill so we know the actual fractional qty.
      const start = Date.now();
      let filledQty: number | undefined;
      let filledAvgPrice: number | undefined;
      let lastStatus = parent.status;
      while (Date.now() - start < waitForFillMs) {
        const o = (await tradingFetch(
          `/v2/orders/${encodeURIComponent(parent.id)}`,
        )) as {
          status: string;
          filled_qty: string | null;
          filled_avg_price: string | null;
        };
        lastStatus = o.status;
        if (o.status === 'filled' && o.filled_qty) {
          filledQty = parseFloat(o.filled_qty);
          filledAvgPrice = o.filled_avg_price ? parseFloat(o.filled_avg_price) : undefined;
          break;
        }
        if (o.status === 'canceled' || o.status === 'expired' || o.status === 'rejected') break;
        await sleep(1500);
      }

      if (filledQty === undefined || filledQty <= 0) {
        return { parentOrderId: parent.id, parentStatus: lastStatus };
      }

      // Step 3: attach the protective stop with the now-known fractional qty.
      try {
        const stop = (await tradingFetch('/v2/orders', {
          method: 'POST',
          body: JSON.stringify({
            symbol,
            qty: filledQty,
            side: 'sell',
            type: 'stop',
            stop_price: round2(stopLossPrice),
            time_in_force: 'gtc',
          }),
        })) as { id: string; status: string };
        return {
          parentOrderId: parent.id,
          parentStatus: lastStatus,
          filledQty,
          filledAvgPrice,
          stopOrderId: stop.id,
          stopStatus: stop.status,
        };
      } catch (err) {
        return {
          parentOrderId: parent.id,
          parentStatus: lastStatus,
          filledQty,
          filledAvgPrice,
          stopError: String(err),
        };
      }
    },
    async submitTrailingStop({ symbol, side, qty, trailPercent }) {
      return tradingFetch('/v2/orders', {
        method: 'POST',
        body: JSON.stringify({
          symbol,
          qty,
          side,
          type: 'trailing_stop',
          time_in_force: 'gtc',
          trail_percent: trailPercent,
        }),
      });
    },
    async submitMarket({ symbol, side, qty }) {
      return tradingFetch('/v2/orders', {
        method: 'POST',
        body: JSON.stringify({ symbol, qty, side, type: 'market', time_in_force: 'day' }),
      });
    },
    async submitStop({ symbol, side, qty, stopPrice, timeInForce }) {
      return tradingFetch('/v2/orders', {
        method: 'POST',
        body: JSON.stringify({
          symbol,
          qty,
          side,
          type: 'stop',
          stop_price: round2(stopPrice),
          time_in_force: timeInForce,
        }),
      });
    },
    async cancelOrder(orderId) {
      await tradingFetch(`/v2/orders/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
    },
    async getOrder(orderId) {
      return tradingFetch(`/v2/orders/${encodeURIComponent(orderId)}`);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
