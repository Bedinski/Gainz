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
  MAX_POSITION_USD: '2000',
  MAX_ORDER_USD: '1000',
  MAX_DAILY_LOSS_USD: '500',
  MAX_TRADES_PER_DAY: '10',
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
    getPositions: async () => [],
    getBars: async () => bars,
    getLatestQuote: async () => ({ ap: 182, bp: 181.95, t: '' }),
    submitBracket: async () => ({ id: 'b1', status: 'accepted', legs: [{ id: 'sl1', order_class: 'bracket' }] }),
    submitTrailingStop: async () => ({ id: 't1', status: 'accepted' }),
    submitMarket: async () => ({ id: 'm1', status: 'accepted' }),
    cancelOrder: async () => undefined,
    getOrder: async () => ({ id: 'm1', status: 'filled', filled_avg_price: '180', filled_at: '' }),
  };
}

const claudeProposingBuy: ClaudeClient = {
  complete: async () => ({
    text: JSON.stringify({
      proposals: [{ symbol: 'AAPL', side: 'buy', notional_usd: 500, reasoning: 'momentum' }],
    }),
    model: 'claude-sonnet-4-6',
    promptTokens: 100,
    completionTokens: 50,
  }),
};

beforeEach(() => {
  closeDb();
  clearConfigCacheForTests();
});

describe('runCycle', () => {
  it('skips when market closed', async () => {
    const cfg = loadConfig(env);
    getDb(':memory:');
    applySchema();
    const result = await runCycle({ cfg, alpaca: mockAlpaca(false), claude: claudeProposingBuy });
    expect(result.skippedReason).toBe('market closed');
  });

  it('runs through analyze + guardrails + dry-run order', async () => {
    const cfg = loadConfig(env);
    getDb(':memory:');
    applySchema();
    const result = await runCycle({ cfg, alpaca: mockAlpaca(true), claude: claudeProposingBuy });
    expect(result.skippedReason).toBeUndefined();
    expect(result.proposals).toBe(1);
    expect(result.approved).toBe(1);
    expect(result.ordersSubmitted).toBe(1); // dry-run still counts as submitted

    const db = getRawSqlite();
    const decision = db.prepare('SELECT * FROM decisions').get() as { id: number };
    expect(decision.id).toBeDefined();
    const proposal = db.prepare('SELECT * FROM proposals').get() as { guardrail_status: string };
    // missing stops → injected defaults → clamped
    expect(proposal.guardrail_status).toBe('clamped');
    const order = db.prepare('SELECT * FROM orders').get() as { status: string };
    expect(order.status).toBe('dry_run');
  });

  it('records a parse error when Claude returns garbage', async () => {
    const cfg = loadConfig(env);
    getDb(':memory:');
    applySchema();
    const garbageClaude: ClaudeClient = {
      complete: async () => ({ text: 'not json at all', model: cfg.CLAUDE_MODEL }),
    };
    const result = await runCycle({ cfg, alpaca: mockAlpaca(true), claude: garbageClaude });
    expect(result.proposals).toBe(0);
    const db = getRawSqlite();
    const decision = db.prepare('SELECT error_message FROM decisions').get() as { error_message: string | null };
    expect(decision.error_message).toBeTruthy();
  });
});
