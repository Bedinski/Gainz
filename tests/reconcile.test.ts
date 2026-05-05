import { describe, it, expect, beforeEach } from 'vitest';
import { applySchema } from '../src/db/migrate.js';
import { closeDb, getDb, getRawSqlite } from '../src/db/client.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import { reconcilePositions } from '../src/trading/reconcile.js';
import type { AlpacaClient } from '../src/alpaca/client.js';

const env = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'AAPL,NVDA',
  RECONCILE_QTY_TOLERANCE: '0.001',
  RECONCILE_NOTIONAL_TOLERANCE_USD: '1',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  closeDb();
  clearConfigCacheForTests();
  getDb(':memory:');
  applySchema();
});

function seedPosition(symbol: string, qty: number, entryPrice: number) {
  const db = getRawSqlite();
  db.prepare(
    `INSERT INTO positions_meta (
       symbol, opened_at, entry_price, qty, atr_at_entry,
       current_stop_alpaca_order_id, current_stop_type, current_stop_price,
       trailing_stop_pct, highest_price_seen, strategy_tag
     ) VALUES (?, ?, ?, ?, 1, NULL, 'fixed', NULL, NULL, ?, 'momentum')`,
  ).run(symbol, Date.now(), entryPrice, qty, entryPrice);
}

function fakeAlpaca(positions: Array<{ symbol: string; qty: number; current_price: number }>): AlpacaClient {
  return {
    getClock: async () => ({ is_open: true, next_open: '', next_close: '' }),
    getAccount: async () => ({ cash: '0', equity: '0', portfolio_value: '0' }),
    getSettledCash: async () => 0,
    getPositions: async () =>
      positions.map((p) => ({
        symbol: p.symbol,
        qty: String(p.qty),
        avg_entry_price: '0',
        current_price: String(p.current_price),
        unrealized_plpc: '0',
      })),
    getOrders: async () => [],
    getBars: async () => [],
    getBarsBatch: async () => ({}),
    getLatestQuote: async () => ({ ap: 0, bp: 0, t: '' }),
    getLatestQuotesBatch: async () => ({}),
    submitBracket: async () => ({ id: '', status: '', legs: [] }),
    submitNotionalBracket: async () => ({ parentOrderId: '', parentStatus: '' }),
    submitTrailingStop: async () => ({ id: '', status: '' }),
    submitMarket: async () => ({ id: '', status: '' }),
    submitStop: async () => ({ id: '', status: '' }),
    cancelOrder: async () => undefined,
    getOrder: async () => ({ id: '', status: '', filled_avg_price: null, filled_qty: null, filled_at: null }),
  };
}

describe('reconcilePositions', () => {
  it('returns severity=ok when DB and broker match', async () => {
    const cfg = loadConfig(env);
    seedPosition('AAPL', 10, 150);
    const result = await reconcilePositions(
      fakeAlpaca([{ symbol: 'AAPL', qty: 10, current_price: 155 }]),
      cfg,
    );
    expect(result.severity).toBe('ok');
    expect(result.mismatches).toHaveLength(0);
  });

  it('flags missing_in_broker as critical (DB has, broker does not)', async () => {
    const cfg = loadConfig(env);
    seedPosition('AAPL', 10, 150);
    const result = await reconcilePositions(fakeAlpaca([]), cfg);
    expect(result.severity).toBe('critical');
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]!.kind).toBe('missing_in_broker');
  });

  it('flags missing_in_db as critical (broker has, DB does not)', async () => {
    const cfg = loadConfig(env);
    const result = await reconcilePositions(
      fakeAlpaca([{ symbol: 'AAPL', qty: 10, current_price: 150 }]),
      cfg,
    );
    expect(result.severity).toBe('critical');
    expect(result.mismatches[0]!.kind).toBe('missing_in_db');
  });

  it('flags qty_drift outside tolerance', async () => {
    const cfg = loadConfig(env);
    seedPosition('AAPL', 10, 150);
    const result = await reconcilePositions(
      fakeAlpaca([{ symbol: 'AAPL', qty: 9.5, current_price: 150 }]),
      cfg,
    );
    expect(result.severity).toBe('critical');
    expect(result.mismatches[0]!.kind).toBe('qty_drift');
  });

  it('persists a reconciliation_runs row each call', async () => {
    const cfg = loadConfig(env);
    seedPosition('AAPL', 10, 150);
    await reconcilePositions(fakeAlpaca([{ symbol: 'AAPL', qty: 10, current_price: 150 }]), cfg);
    const rows = getRawSqlite().prepare('SELECT * FROM reconciliation_runs').all();
    expect(rows).toHaveLength(1);
  });
});
