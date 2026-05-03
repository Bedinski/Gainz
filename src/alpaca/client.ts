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
  getAccount(): Promise<{ cash: string; equity: string; portfolio_value: string }>;
  getPositions(): Promise<
    Array<{
      symbol: string;
      qty: string;
      avg_entry_price: string;
      current_price: string;
      unrealized_plpc: string;
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
  submitTrailingStop(args: {
    symbol: string;
    side: 'sell';
    qty: number;
    trailPercent: number;
  }): Promise<{ id: string; status: string }>;
  submitMarket(args: { symbol: string; side: 'buy' | 'sell'; qty: number }): Promise<{ id: string; status: string }>;
  cancelOrder(orderId: string): Promise<void>;
  getOrder(orderId: string): Promise<{ id: string; status: string; filled_avg_price: string | null; filled_at: string | null }>;
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
    async getPositions() {
      return (await tradingFetch('/v2/positions')) ?? [];
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
    async cancelOrder(orderId) {
      await tradingFetch(`/v2/orders/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
    },
    async getOrder(orderId) {
      return tradingFetch(`/v2/orders/${encodeURIComponent(orderId)}`);
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
