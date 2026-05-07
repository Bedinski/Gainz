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
    getBarsBatch: async (symbols) => Object.fromEntries(symbols.map((s) => [s, bars])),
    getLatestQuote: async () => ({ ap: 182, bp: 181.95, t: '' }),
    getLatestQuotesBatch: async (symbols) =>
      Object.fromEntries(symbols.map((s) => [s, { ap: 182, bp: 181.95, t: '' }])),
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
  it('runs the full cycle even when the market is closed (analysis + queuing)', async () => {
    // After-hours mode: cycle still produces a decision row, runs Claude
    // analysis, and submits orders (Alpaca queues them for the next session).
    // Manage step + dip exits also run — operators want to adjust trailing
    // stops while looking at the close. The result.marketOpen flag tells
    // operators whether the cycle ran live or after-hours.
    const cfg = loadConfig(env);
    getDb(':memory:');
    applySchema();
    const result = await runCycle({ cfg, alpaca: mockAlpaca(false), claude: twoStageClaude() });
    expect(result.skippedReason).toBeUndefined();
    expect(result.marketOpen).toBe(false);
    expect(result.shortlistSize).toBe(1);
    expect(result.proposals).toBe(1);
    expect(result.approved).toBe(1);
    expect(result.ordersSubmitted).toBe(1); // dry-run still counts
    const decisionId = (getRawSqlite().prepare('SELECT id FROM decisions').get() as { id: number }).id;
    expect(decisionId).toBeGreaterThan(0);
  });

  it('still skips on bot-disabled / halted / clock-unavailable (those are real halts)', async () => {
    const cfg = loadConfig(env);
    getDb(':memory:');
    applySchema();
    // Force the bot disabled.
    getRawSqlite()
      .prepare("INSERT INTO bot_state (id, enabled, updated_at, mode) VALUES (1, 0, ?, 'normal')")
      .run(Date.now());
    const result = await runCycle({ cfg, alpaca: mockAlpaca(true), claude: twoStageClaude() });
    expect(result.skippedReason).toBe('bot disabled');
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

  it('DEBATE_ENABLED=false bypasses debate even when bear would have skipped', async () => {
    const cfg = loadConfig({ ...env, DEBATE_ENABLED: 'false' });
    getDb(':memory:');
    applySchema();
    let calls = 0;
    const claude: ClaudeClient = {
      complete: async () => {
        calls++;
        if (calls === 1) {
          return { text: JSON.stringify({ shortlist: ['AAPL'] }), model: 'claude-sonnet-4-6' };
        }
        if (calls === 2) {
          return { text: JSON.stringify({ proposals: [proposalWithSignals] }), model: 'claude-sonnet-4-6' };
        }
        // Would force a debate-skip if debate ran. Test asserts these calls
        // never happen when DEBATE_ENABLED=false.
        return { text: JSON.stringify({ decision: 'skip', rationale: 'noisy' }), model: 'claude-sonnet-4-6' };
      },
    };
    const result = await runCycle({ cfg, alpaca: mockAlpaca(true), claude });
    expect(calls).toBe(2); // shortlist + deep analysis only — no bull/bear calls
    expect(result.debateSkipped).toBe(0);
    expect(result.approved).toBe(1);
    expect(result.ordersSubmitted).toBe(1); // dry-run still counts
  });

  it('pending stop-buy (not filled) does NOT write a positions_meta row', async () => {
    // Reproduces the orphan-trailing-stop bug: previously the cycle wrote a
    // positions_meta row on order acceptance, even though the stop-buy hadn't
    // triggered. A subsequent cycle then upgraded the protective stop to a
    // trailing stop for shares the operator never owned.
    const cfg = loadConfig({
      ...env,
      SAFE_MODE: 'false',
      DEBATE_ENABLED: 'false',
    });
    getDb(':memory:');
    applySchema();
    const alpaca = mockAlpaca(true);
    // Override the bracket submission so the parent appears accepted-but-not-
    // filled — what real stop-buys look like in Alpaca's response.
    alpaca.submitNotionalBracket = async () => ({
      parentOrderId: 'p-pending',
      parentStatus: 'accepted',
      filledQty: undefined as unknown as number,
      filledAvgPrice: undefined as unknown as number,
      stopOrderId: 's-pending',
      stopStatus: 'held',
    });
    let calls = 0;
    const claude: ClaudeClient = {
      complete: async () => {
        calls++;
        if (calls === 1) return { text: JSON.stringify({ shortlist: ['AAPL'] }), model: 'm' };
        if (calls === 2) return { text: JSON.stringify({ proposals: [proposalWithSignals] }), model: 'm' };
        return { text: JSON.stringify({ decision: 'proceed', rationale: 'ok' }), model: 'm' };
      },
    };
    const result = await runCycle({ cfg, alpaca, claude });
    expect(result.ordersSubmitted).toBe(1);
    const db = getRawSqlite();
    const rowCount = (db.prepare('SELECT COUNT(*) AS c FROM positions_meta WHERE symbol = ?').get('AAPL') as { c: number }).c;
    expect(rowCount).toBe(0); // critical: no phantom row
    const orderRow = db.prepare('SELECT status FROM orders WHERE symbol = ?').get('AAPL') as { status: string };
    expect(orderRow.status).toBe('accepted'); // the order itself is still recorded
  });

  it('manage step prunes phantom positions_meta rows + cancels their tracked stop', async () => {
    const cfg = loadConfig({ ...env, SAFE_MODE: 'false', DEBATE_ENABLED: 'false' });
    getDb(':memory:');
    applySchema();

    // Pre-seed a phantom row exactly like the GOOGL bug in production.
    const db = getRawSqlite();
    db.prepare(
      `INSERT INTO positions_meta (
         symbol, opened_at, entry_price, qty, atr_at_entry,
         current_stop_alpaca_order_id, current_stop_type, current_stop_price,
         trailing_stop_pct, highest_price_seen, strategy_tag, sector
       ) VALUES (?, ?, ?, ?, ?, ?, 'trailing', ?, ?, ?, ?, ?)`,
    ).run('AAPL', Date.now(), 180, 1, 5, 'orphan-stop-id', null, 3, 180, 'momentum', 'tech');

    const alpaca = mockAlpaca(true);
    let canceledOrderId: string | undefined;
    alpaca.cancelOrder = async (id: string) => {
      canceledOrderId = id;
    };
    // getPositions returns [] (default) → phantom should be pruned + stop canceled.

    // Empty shortlist so no new proposal interferes; the manage step still runs.
    const claude: ClaudeClient = {
      complete: async () => ({
        text: JSON.stringify({ shortlist: [], notes: 'nothing today' }),
        model: 'claude-sonnet-4-6',
      }),
    };

    await runCycle({ cfg, alpaca, claude });

    expect(canceledOrderId).toBe('orphan-stop-id');
    const remaining = (db.prepare('SELECT COUNT(*) AS c FROM positions_meta WHERE symbol = ?').get('AAPL') as { c: number }).c;
    expect(remaining).toBe(0);
  });

  it('manage step does NOT prune when getPositions fails (failure-mode safety)', async () => {
    const cfg = loadConfig({ ...env, SAFE_MODE: 'false', DEBATE_ENABLED: 'false' });
    getDb(':memory:');
    applySchema();
    const db = getRawSqlite();
    db.prepare(
      `INSERT INTO positions_meta (
         symbol, opened_at, entry_price, qty, atr_at_entry,
         current_stop_alpaca_order_id, current_stop_type, current_stop_price,
         trailing_stop_pct, highest_price_seen, strategy_tag, sector
       ) VALUES (?, ?, ?, ?, ?, ?, 'trailing', ?, ?, ?, ?, ?)`,
    ).run('AAPL', Date.now(), 180, 1, 5, 'real-stop-id', null, 3, 180, 'momentum', 'tech');

    const alpaca = mockAlpaca(true);
    // First getPositions() call is fetchPortfolioSnapshot — return []. Second
    // is the new prune step — fail. The prune must catch and continue.
    let getPositionsCalls = 0;
    alpaca.getPositions = async () => {
      getPositionsCalls++;
      if (getPositionsCalls === 1) return [];
      throw new Error('alpaca down');
    };
    let canceled = false;
    alpaca.cancelOrder = async () => {
      canceled = true;
    };
    const claude: ClaudeClient = {
      complete: async () => ({
        text: JSON.stringify({ shortlist: [] }),
        model: 'claude-sonnet-4-6',
      }),
    };
    await runCycle({ cfg, alpaca, claude });
    // Row preserved, stop NOT canceled — broker outage shouldn't nuke local state.
    const stillThere = (db.prepare('SELECT COUNT(*) AS c FROM positions_meta WHERE symbol = ?').get('AAPL') as { c: number }).c;
    expect(stillThere).toBe(1);
    expect(canceled).toBe(false);
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
