import { describe, it, expect, beforeEach } from 'vitest';
import { applySchema } from '../src/db/migrate.js';
import { closeDb, getDb, getRawSqlite } from '../src/db/client.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import { runDipExits } from '../src/strategies/dip-recovery/exit.js';
import type { AlpacaClient } from '../src/alpaca/client.js';
import type { MarketSnapshot } from '../src/trading/types.js';

const env = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'SPY',
  DIP_STRATEGY_ENABLED: 'true',
  DIP_BUDGET_USD: '800',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

function mockAlpaca(): { client: AlpacaClient; sells: Array<{ symbol: string; qty: number }> } {
  const sells: Array<{ symbol: string; qty: number }> = [];
  const client: AlpacaClient = {
    getClock: async () => ({ is_open: true, next_open: '', next_close: '' }),
    getAccount: async () => ({ cash: '2500', equity: '2500', portfolio_value: '2500' }),
    getSettledCash: async () => 2500,
    getPositions: async () => [],
    getOrders: async () => [],
    getBars: async () => [],
    getBarsBatch: async (symbols) => Object.fromEntries(symbols.map((s) => [s, []])),
    getLatestQuote: async () => ({ ap: 0, bp: 0, t: '' }),
    getLatestQuotesBatch: async (symbols) =>
      Object.fromEntries(symbols.map((s) => [s, { ap: 0, bp: 0, t: '' }])),
    submitBracket: async () => ({ id: 'b', status: 'accepted', legs: [] }),
    submitNotionalBracket: async () => ({ parentOrderId: 'p', parentStatus: 'filled' }),
    submitTrailingStop: async () => ({ id: 't', status: 'accepted' }),
    submitMarket: async ({ symbol, qty }) => {
      sells.push({ symbol, qty });
      return { id: 'm', status: 'accepted' };
    },
    submitStop: async () => ({ id: 's', status: 'accepted' }),
    cancelOrder: async () => undefined,
    getOrder: async () => ({ id: 'p', status: 'filled', filled_avg_price: '0', filled_qty: '0', filled_at: '' }),
  };
  return { client, sells };
}

function seed(opts: {
  symbol: string;
  entryPrice: number;
  qty: number;
  targetPrice: number;
  timeExitAt: number;
  dipEventId: number;
}) {
  const db = getRawSqlite();
  db.prepare(
    `INSERT INTO daily_state (date, realized_pnl, dip_realized_pnl, trade_count, halted) VALUES (?, 0, 0, 0, 0)`,
  ).run(new Date().toISOString().slice(0, 10));
  db.prepare(
    `INSERT INTO dip_events (
       id, symbol, detected_at, peak_price, peak_date, trough_price, trough_date,
       drawdown_pct, recovery_target_price, status, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'entered', ?)`,
  ).run(opts.dipEventId, opts.symbol, Date.now(), 110, '2025-04-01', 95, '2025-04-05', 13.6, opts.targetPrice, opts.timeExitAt);
  db.prepare(
    `INSERT INTO positions_meta (
       symbol, opened_at, entry_price, qty, atr_at_entry,
       current_stop_alpaca_order_id, current_stop_type, current_stop_price,
       trailing_stop_pct, highest_price_seen,
       strategy_tag, target_price, time_exit_at, dip_event_id
     ) VALUES (?, ?, ?, ?, ?, NULL, 'fixed', NULL, NULL, ?, 'dip_recovery', ?, ?, ?)`,
  ).run(
    opts.symbol,
    Date.now(),
    opts.entryPrice,
    opts.qty,
    2,
    opts.entryPrice,
    opts.targetPrice,
    opts.timeExitAt,
    opts.dipEventId,
  );
}

beforeEach(() => {
  closeDb();
  clearConfigCacheForTests();
  getDb(':memory:');
  applySchema();
});

describe('runDipExits', () => {
  it('exits at target_hit when current price >= target', async () => {
    const cfg = loadConfig(env);
    seed({
      symbol: 'SPY',
      entryPrice: 100,
      qty: 8,
      targetPrice: 107,
      timeExitAt: Date.now() + 14 * 86_400_000,
      dipEventId: 42,
    });
    const market: MarketSnapshot = {
      SPY: { symbol: 'SPY', latestPrice: 108, atr14: 2, bars: [] },
    };
    const { client, sells } = mockAlpaca();
    const exits = await runDipExits(client, cfg, market, new Date());
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).toBe('target_hit');
    expect(exits[0]!.pnlUsd).toBeCloseTo(8 * 8); // (108-100)*8
    expect(sells).toEqual([{ symbol: 'SPY', qty: 8 }]);

    const db = getRawSqlite();
    const evt = db.prepare('SELECT status FROM dip_events WHERE id = 42').get() as { status: string };
    expect(evt.status).toBe('recovered');
    const pos = db.prepare('SELECT * FROM positions_meta WHERE symbol = ?').get('SPY');
    expect(pos).toBeUndefined();
  });

  it('exits at time_expiry when deadline elapsed and target not hit', async () => {
    const cfg = loadConfig(env);
    seed({
      symbol: 'SPY',
      entryPrice: 100,
      qty: 8,
      targetPrice: 107,
      timeExitAt: Date.now() - 1000, // already past
      dipEventId: 43,
    });
    const market: MarketSnapshot = {
      SPY: { symbol: 'SPY', latestPrice: 99, atr14: 2, bars: [] },
    };
    const { client, sells } = mockAlpaca();
    const exits = await runDipExits(client, cfg, market, new Date());
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).toBe('time_expiry');
    expect(exits[0]!.pnlUsd).toBeCloseTo(-1 * 8);
    expect(sells).toEqual([{ symbol: 'SPY', qty: 8 }]);

    const db = getRawSqlite();
    const evt = db.prepare('SELECT status FROM dip_events WHERE id = 43').get() as { status: string };
    expect(evt.status).toBe('expired');
  });

  it('does NOT exit while target unmet and deadline not expired', async () => {
    const cfg = loadConfig(env);
    seed({
      symbol: 'SPY',
      entryPrice: 100,
      qty: 8,
      targetPrice: 107,
      timeExitAt: Date.now() + 14 * 86_400_000,
      dipEventId: 44,
    });
    const market: MarketSnapshot = {
      SPY: { symbol: 'SPY', latestPrice: 102, atr14: 2, bars: [] },
    };
    const { client, sells } = mockAlpaca();
    const exits = await runDipExits(client, cfg, market, new Date());
    expect(exits).toHaveLength(0);
    expect(sells).toEqual([]);
  });

  it('skips momentum positions (different strategy_tag)', async () => {
    const cfg = loadConfig(env);
    const db = getRawSqlite();
    db.prepare(
      `INSERT INTO daily_state (date, realized_pnl, dip_realized_pnl, trade_count, halted) VALUES (?, 0, 0, 0, 0)`,
    ).run(new Date().toISOString().slice(0, 10));
    db.prepare(
      `INSERT INTO positions_meta (
         symbol, opened_at, entry_price, qty, atr_at_entry,
         current_stop_alpaca_order_id, current_stop_type, current_stop_price,
         trailing_stop_pct, highest_price_seen, strategy_tag
       ) VALUES (?, ?, ?, ?, ?, NULL, 'fixed', NULL, 3, ?, 'momentum')`,
    ).run('AAPL', Date.now(), 100, 5, 2, 105);
    const market: MarketSnapshot = {
      AAPL: { symbol: 'AAPL', latestPrice: 200, atr14: 2, bars: [] },
    };
    const { client, sells } = mockAlpaca();
    const exits = await runDipExits(client, cfg, market, new Date());
    expect(exits).toHaveLength(0);
    expect(sells).toEqual([]);
  });
});
