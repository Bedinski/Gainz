import { describe, it, expect, beforeEach } from 'vitest';
import { applySchema } from '../src/db/migrate.js';
import { closeDb, getDb, getRawSqlite } from '../src/db/client.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import { runCycle } from '../src/trading/cycle.js';
import type { AlpacaClient } from '../src/alpaca/client.js';
import type { ClaudeClient } from '../src/claude/client.js';

const env = {
  TRADING_MODE: 'paper',
  SAFE_MODE: 'true',
  SYMBOL_ALLOWLIST: 'AAPL',
  MAX_POSITION_USD: '500',
  MAX_ORDER_USD: '500',
  MAX_DAILY_LOSS_USD: '500',
  MIN_SIGNAL_SCORE: '0',
  RISK_PER_TRADE_PCT: '0.5',
  CIRCUIT_BREAKER_ENABLED: 'false', // isolate drain mode
  ALPACA_KEY_ID: 'k',
  ALPACA_SECRET_KEY: 's',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  closeDb();
  clearConfigCacheForTests();
  getDb(':memory:');
  applySchema();
});

function bars() {
  return Array.from({ length: 30 }, (_, i) => ({
    t: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    o: 180,
    h: 185,
    l: 175,
    c: 182,
    v: 1_000_000,
  }));
}

function mockAlpaca(): AlpacaClient {
  const b = bars();
  return {
    getClock: async () => ({ is_open: true, next_open: '', next_close: '' }),
    getAccount: async () => ({ cash: '5000', equity: '5000', portfolio_value: '5000' }),
    getSettledCash: async () => 5000,
    getPositions: async () => [],
    getOrders: async () => [],
    getBars: async () => b,
    getBarsBatch: async (symbols) => Object.fromEntries(symbols.map((s) => [s, b])),
    getLatestQuote: async () => ({ ap: 182, bp: 181.95, t: '' }),
    getLatestQuotesBatch: async (symbols) =>
      Object.fromEntries(symbols.map((s) => [s, { ap: 182, bp: 181.95, t: '' }])),
    submitBracket: async () => ({ id: 'b', status: 'accepted', legs: [] }),
    submitNotionalBracket: async () => ({ parentOrderId: 'p', parentStatus: 'filled' }),
    submitTrailingStop: async () => ({ id: 't', status: 'accepted' }),
    submitMarket: async () => ({ id: 'm', status: 'accepted' }),
    submitStop: async () => ({ id: 's', status: 'accepted' }),
    cancelOrder: async () => undefined,
    getOrder: async () => ({ id: '', status: 'filled', filled_avg_price: '182', filled_qty: '1', filled_at: '' }),
  };
}

function buyClaude(): ClaudeClient {
  let n = 0;
  const proposal = {
    symbol: 'AAPL',
    side: 'buy',
    notional_usd: 200,
    reasoning: 'test',
    signals: {
      technical: { strength: 2, evidence: '' },
      congress: { strength: 1, evidence: '' },
      news: { strength: 1, evidence: '' },
      earnings_proximity: 'clear',
      conflicts: [],
    },
  };
  return {
    complete: async () => {
      n++;
      if (n === 1) return { text: JSON.stringify({ shortlist: ['AAPL'] }), model: 'claude-sonnet-4-6' };
      if (n === 2) return { text: JSON.stringify({ proposals: [proposal] }), model: 'claude-sonnet-4-6' };
      return { text: JSON.stringify({ decision: 'proceed', rationale: '' }), model: 'claude-sonnet-4-6' };
    },
  };
}

describe('iter4 — drain mode E2E', () => {
  it('mode=off short-circuits the cycle entirely', async () => {
    const cfg = loadConfig(env);
    getRawSqlite()
      .prepare(`INSERT INTO bot_state (id, enabled, updated_at, mode) VALUES (1, 1, ?, 'off')`)
      .run(Date.now());
    const result = await runCycle({ cfg, alpaca: mockAlpaca(), claude: buyClaude() });
    expect(result.skippedReason).toBe('bot mode=off');
  });

  it('mode=drain runs the cycle but rejects every buy', async () => {
    const cfg = loadConfig(env);
    getRawSqlite()
      .prepare(`INSERT INTO bot_state (id, enabled, updated_at, mode) VALUES (1, 1, ?, 'drain')`)
      .run(Date.now());
    const result = await runCycle({ cfg, alpaca: mockAlpaca(), claude: buyClaude() });
    expect(result.skippedReason).toBeUndefined();
    expect(result.drainMode).toBe(true);
    expect(result.proposals).toBeGreaterThan(0);
    expect(result.approved).toBe(0);
    expect(result.rejected).toBeGreaterThan(0);
    // no orders submitted in drain mode
    expect(result.ordersSubmitted).toBe(0);
  });

  it('mode=normal trades as usual', async () => {
    const cfg = loadConfig(env);
    getRawSqlite()
      .prepare(`INSERT INTO bot_state (id, enabled, updated_at, mode) VALUES (1, 1, ?, 'normal')`)
      .run(Date.now());
    const result = await runCycle({ cfg, alpaca: mockAlpaca(), claude: buyClaude() });
    expect(result.drainMode).toBe(false);
    expect(result.approved).toBeGreaterThan(0);
  });
});
