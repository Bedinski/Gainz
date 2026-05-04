import { describe, it, expect, beforeEach } from 'vitest';
import { runCycle } from '../src/trading/cycle.js';
import { applySchema } from '../src/db/migrate.js';
import { closeDb, getDb, getRawSqlite } from '../src/db/client.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import type { AlpacaClient } from '../src/alpaca/client.js';
import type { ClaudeClient } from '../src/claude/client.js';

const env = {
  TRADING_MODE: 'paper',
  SAFE_MODE: 'true', // dry-run orders so we don't mutate real broker state
  SYMBOL_ALLOWLIST: 'AAPL',
  MAX_POSITION_USD: '400',
  MAX_ORDER_USD: '400',
  MAX_DAILY_LOSS_USD: '60',
  MAX_TRADES_PER_DAY: '4',
  STOP_LOSS_PCT: '2.5',
  STOP_LOSS_MIN_PCT: '1.5',
  STOP_LOSS_MAX_PCT: '8',
  ATR_MULT: '1.5',
  TRAILING_STOP_PCT: '3',
  TRAILING_MIN_PCT: '2',
  TRAILING_MAX_PCT: '8',
  ENTRY_TRIGGER_PCT: '0.3',
  ENTRY_MAX_OFFSET_PCT: '1',
  ENTRY_ORDER_TTL_MIN: '30',
  EARNINGS_BLACKOUT_DAYS: '3',
  RESERVE_SETTLED_CASH_USD: '50',
  MIN_SIGNAL_SCORE: '3',
  MAX_CONFLICTS: '0',
  ALPACA_NEWS_ENABLED: 'false',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

function mockAlpaca(open = true): AlpacaClient {
  const bars = Array.from({ length: 30 }, (_, i) => ({
    t: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    o: 180,
    h: 185,
    l: 175,
    c: 182,
    v: 1_000_000,
  }));
  return {
    getClock: async () => ({ is_open: open, next_open: '', next_close: '' }),
    getAccount: async () => ({ cash: '5000', equity: '5000', portfolio_value: '5000' }),
    getSettledCash: async () => 5000,
    getPositions: async () => [],
    getOrders: async () => [],
    getBars: async () => bars,
    getLatestQuote: async () => ({ ap: 182, bp: 181.95, t: '' }),
    submitBracket: async () => ({ id: 'b1', status: 'accepted', legs: [{ id: 'sl1', order_class: 'bracket' }] }),
    submitNotionalBracket: async () => ({
      parentOrderId: 'p1',
      parentStatus: 'filled',
      filledQty: 1.65,
      filledAvgPrice: 182,
      stopOrderId: 's1',
      stopStatus: 'accepted',
    }),
    submitTrailingStop: async () => ({ id: 't1', status: 'accepted' }),
    submitMarket: async () => ({ id: 'm1', status: 'accepted' }),
    submitStop: async () => ({ id: 'st1', status: 'accepted' }),
    cancelOrder: async () => undefined,
    getOrder: async () => ({ id: 'm1', status: 'filled', filled_avg_price: '180', filled_qty: '1', filled_at: '' }),
  };
}

const proposalWithSignals = {
  symbol: 'AAPL',
  side: 'buy',
  notional_usd: 300,
  reasoning: 'momentum + cluster + earnings beat',
  signals: {
    technical: { strength: 2, evidence: 'breakout above 50d, vol up' },
    congress: { strength: 1, evidence: 'one cluster filing' },
    news: { strength: 1, evidence: 'earnings beat 2d ago' },
    earnings_proximity: 'clear',
    conflicts: [],
  },
};

/**
 * Two-stage Claude mock: first call returns shortlist, deep calls return the
 * proposal, debate calls return JSON with decision=proceed.
 */
function twoStageClaude(): ClaudeClient {
  let n = 0;
  return {
    complete: async () => {
      n++;
      if (n === 1) {
        // shortlist
        return {
          text: JSON.stringify({ shortlist: ['AAPL'], notes: 'one signal-rich ticker' }),
          model: 'claude-sonnet-4-6',
          promptTokens: 200,
          completionTokens: 30,
        };
      }
      if (n === 2) {
        // deep analysis
        return {
          text: JSON.stringify({ proposals: [proposalWithSignals] }),
          model: 'claude-sonnet-4-6',
          promptTokens: 500,
          completionTokens: 200,
        };
      }
      // debate calls (bull/bear) — both proceed
      return {
        text: JSON.stringify({ decision: 'proceed', rationale: 'evidence holds' }),
        model: 'claude-sonnet-4-6',
      };
    },
  };
}

const garbageClaude: ClaudeClient = {
  complete: async () => ({ text: 'not json at all', model: 'claude-sonnet-4-6' }),
};

beforeEach(() => {
  closeDb();
  clearConfigCacheForTests();
});

describe('runCycle (two-stage)', () => {
  it('skips when market closed', async () => {
    const cfg = loadConfig(env);
    getDb(':memory:');
    applySchema();
    const result = await runCycle({ cfg, alpaca: mockAlpaca(false), claude: twoStageClaude() });
    expect(result.skippedReason).toBe('market closed');
  });

  it('runs shortlist -> deep -> debate -> guardrails -> dry-run order', async () => {
    const cfg = loadConfig(env);
    getDb(':memory:');
    applySchema();
    const result = await runCycle({ cfg, alpaca: mockAlpaca(true), claude: twoStageClaude() });
    expect(result.skippedReason).toBeUndefined();
    expect(result.shortlistSize).toBe(1);
    expect(result.proposals).toBe(1);
    expect(result.approved).toBe(1);
    expect(result.ordersSubmitted).toBe(1); // dry-run still counts as submitted
    expect(result.debateSkipped).toBe(0);

    const db = getRawSqlite();
    const order = db.prepare('SELECT * FROM orders').get() as { status: string; decision_audit: string };
    expect(order.status).toBe('dry_run');
    expect(order.decision_audit).toContain('AAPL:');
    expect(order.decision_audit).toContain('score=4');
  });

  it('records a parse error when shortlist returns garbage', async () => {
    const cfg = loadConfig(env);
    getDb(':memory:');
    applySchema();
    const result = await runCycle({ cfg, alpaca: mockAlpaca(true), claude: garbageClaude });
    expect(result.proposals).toBe(0);
    const db = getRawSqlite();
    const decision = db.prepare('SELECT error_message FROM decisions').get() as { error_message: string | null };
    expect(decision.error_message).toBeTruthy();
  });

  it('debate skip path rejects an otherwise-passing proposal', async () => {
    const cfg = loadConfig(env);
    getDb(':memory:');
    applySchema();
    let n = 0;
    const claude: ClaudeClient = {
      complete: async () => {
        n++;
        if (n === 1) {
          return {
            text: JSON.stringify({ shortlist: ['AAPL'] }),
            model: 'claude-sonnet-4-6',
          };
        }
        if (n === 2) {
          return {
            text: JSON.stringify({ proposals: [proposalWithSignals] }),
            model: 'claude-sonnet-4-6',
          };
        }
        // bull proceed, bear skip → bear wins
        if (n === 3) {
          return {
            text: JSON.stringify({ decision: 'proceed', rationale: 'looks fine' }),
            model: 'claude-sonnet-4-6',
          };
        }
        return {
          text: JSON.stringify({ decision: 'skip', rationale: 'macro headwinds' }),
          model: 'claude-sonnet-4-6',
        };
      },
    };
    const result = await runCycle({ cfg, alpaca: mockAlpaca(true), claude });
    expect(result.debateSkipped).toBe(1);
    expect(result.ordersSubmitted).toBe(0);
  });
});
