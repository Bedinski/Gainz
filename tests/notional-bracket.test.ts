import { describe, it, expect } from 'vitest';
import { executeOrder } from '../src/alpaca/orders.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import type { AlpacaClient } from '../src/alpaca/client.js';
import type { TradeProposal } from '../src/trading/types.js';

const env = {
  TRADING_MODE: 'paper',
  SAFE_MODE: 'false',
  SYMBOL_ALLOWLIST: 'NVDA',
  STOP_LOSS_PCT: '2.5',
  STOP_LOSS_MIN_PCT: '1.5',
  STOP_LOSS_MAX_PCT: '8',
  ATR_MULT: '1.5',
  TRAILING_STOP_PCT: '3',
  TRAILING_MIN_PCT: '2',
  TRAILING_MAX_PCT: '8',
  ENTRY_TRIGGER_PCT: '0.3',
  MAX_POSITION_USD: '400',
  MAX_ORDER_USD: '400',
  MAX_DAILY_LOSS_USD: '60',
  MAX_TRADES_PER_DAY: '4',
  EARNINGS_BLACKOUT_DAYS: '3',
  ALPACA_KEY_ID: 'k',
  ALPACA_SECRET_KEY: 's',
} as unknown as NodeJS.ProcessEnv;

function mockClient(): { client: AlpacaClient; calls: { notionalBracket?: unknown; bracket?: unknown } } {
  const calls: { notionalBracket?: unknown; bracket?: unknown } = {};
  const client: AlpacaClient = {
    getClock: async () => ({ is_open: true, next_open: '', next_close: '' }),
    getAccount: async () => ({ cash: '2500', equity: '2500', portfolio_value: '2500' }),
    getSettledCash: async () => 2500,
    getPositions: async () => [],
    getOrders: async () => [],
    getBars: async () => [],
    getLatestQuote: async () => ({ ap: 920, bp: 919.95, t: '' }),
    submitBracket: async (args) => {
      calls.bracket = args;
      return { id: 'parent', status: 'accepted', legs: [{ id: 'stop', order_class: 'bracket' }] };
    },
    submitNotionalBracket: async (args) => {
      calls.notionalBracket = args;
      return {
        parentOrderId: 'p1',
        parentStatus: 'filled',
        filledQty: 0.434,
        filledAvgPrice: 921.42,
        stopOrderId: 's1',
        stopStatus: 'accepted',
      };
    },
    submitTrailingStop: async () => ({ id: 't1', status: 'accepted' }),
    submitMarket: async () => ({ id: 'm1', status: 'accepted' }),
    submitStop: async () => ({ id: 'st1', status: 'accepted' }),
    cancelOrder: async () => undefined,
    getOrder: async () => ({ id: 'p1', status: 'filled', filled_avg_price: '921.42', filled_qty: '0.434', filled_at: '' }),
  };
  return { client, calls };
}

describe('executeOrder — notional bracket path', () => {
  it('routes notional buys through submitNotionalBracket', async () => {
    clearConfigCacheForTests();
    const cfg = loadConfig(env);
    const { client, calls } = mockClient();
    const proposal: TradeProposal = {
      symbol: 'NVDA',
      side: 'buy',
      notionalUsd: 400,
      entryType: 'stop',
      stopLossPct: 2.5,
      trailingStopPct: 3,
    };
    const result = await executeOrder(client, proposal, {
      cfg,
      currentPrice: 920,
      atr14: 15,
      qty: 0, // notional path doesn't need qty
    });
    expect(calls.notionalBracket).toBeDefined();
    expect(calls.bracket).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.filledQty).toBeCloseTo(0.434);
    expect(result.alpacaOrderId).toBe('p1');
    expect(result.parentAlpacaOrderId).toBe('s1'); // stop child id
  });

  it('uses whole-share bracket when qty is supplied without notional', async () => {
    clearConfigCacheForTests();
    const cfg = loadConfig(env);
    const { client, calls } = mockClient();
    const proposal: TradeProposal = {
      symbol: 'NVDA',
      side: 'buy',
      qty: 1,
      entryType: 'stop',
      stopLossPct: 2.5,
      trailingStopPct: 3,
    };
    const result = await executeOrder(client, proposal, {
      cfg,
      currentPrice: 920,
      atr14: 15,
      qty: 1,
    });
    expect(calls.bracket).toBeDefined();
    expect(calls.notionalBracket).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});
