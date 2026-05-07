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
  STOP_LOSS_PCT: '2.5',
  ATR_MULT: '1.5',
  TRAILING_STOP_PCT: '3',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

// 30 daily bars with steady volatility — ATR(14) computes cleanly.
const fakeBars = Array.from({ length: 30 }, (_, i) => ({
  t: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
  o: 150 + i,
  h: 153 + i,
  l: 148 + i,
  c: 151 + i,
  v: 1_000_000,
}));

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

  describe('autoCorrect: missing_in_db', () => {
    it('imports broker position into positions_meta + submits a protective stop', async () => {
      const cfg = loadConfig(env);
      let stopArgs: { symbol: string; side: string; qty: number; stopPrice: number } | undefined;
      const alpaca: AlpacaClient = {
        ...fakeAlpaca([]),
        getPositions: async () => [
          {
            symbol: 'AAPL',
            qty: '10', // integer qty so submitStop is exercised
            avg_entry_price: '180.00',
            current_price: '185.00',
            unrealized_plpc: '0',
          },
        ],
        getBars: async () => fakeBars,
        getOrders: async () => [], // no existing stop
        submitStop: async (args) => {
          stopArgs = args;
          return { id: 'stop-new', status: 'accepted' };
        },
      };
      const result = await reconcilePositions(alpaca, cfg, new Date(), { autoCorrect: true });

      // Mismatch resolved → empty list, severity ok, autoCorrected populated
      expect(result.mismatches).toHaveLength(0);
      expect(result.severity).toBe('ok');
      expect(result.autoCorrected).toEqual(['AAPL']);

      // Stop submitted with correct args
      expect(stopArgs).toBeDefined();
      expect(stopArgs!.symbol).toBe('AAPL');
      expect(stopArgs!.side).toBe('sell');
      expect(stopArgs!.qty).toBe(10);
      // Stop price is the wider of (entry × (1 - 2.5%)) and (entry - 1.5 × ATR)
      // = min(175.50, 180 - 1.5*ATR). Just assert it's below entry, above zero.
      expect(stopArgs!.stopPrice).toBeGreaterThan(0);
      expect(stopArgs!.stopPrice).toBeLessThan(180);

      // positions_meta row inserted with broker entry + stop order id
      const row = getRawSqlite()
        .prepare('SELECT * FROM positions_meta WHERE symbol = ?')
        .get('AAPL') as {
          symbol: string;
          entry_price: number;
          qty: number;
          current_stop_alpaca_order_id: string | null;
          current_stop_type: string;
          strategy_tag: string;
        };
      expect(row.symbol).toBe('AAPL');
      expect(row.entry_price).toBeCloseTo(180);
      expect(row.qty).toBe(10);
      expect(row.current_stop_alpaca_order_id).toBe('stop-new');
      expect(row.current_stop_type).toBe('fixed');
      expect(row.strategy_tag).toBe('momentum');
    });

    it('reuses an existing open stop at the broker instead of double-submitting', async () => {
      const cfg = loadConfig(env);
      let submitCalled = false;
      const alpaca: AlpacaClient = {
        ...fakeAlpaca([]),
        getPositions: async () => [
          {
            symbol: 'AAPL',
            qty: '5',
            avg_entry_price: '180',
            current_price: '185',
            unrealized_plpc: '0',
          },
        ],
        getBars: async () => fakeBars,
        getOrders: async () => [
          {
            id: 'stop-existing',
            symbol: 'AAPL',
            side: 'sell',
            status: 'new',
            type: 'stop',
            filled_avg_price: null,
            filled_qty: null,
            filled_at: null,
            submitted_at: '',
            qty: '5',
            notional: null,
          },
        ],
        submitStop: async () => {
          submitCalled = true;
          return { id: 'should-not-be-called', status: '' };
        },
      };
      const result = await reconcilePositions(alpaca, cfg, new Date(), { autoCorrect: true });
      expect(result.autoCorrected).toEqual(['AAPL']);
      expect(submitCalled).toBe(false);
      const row = getRawSqlite()
        .prepare('SELECT current_stop_alpaca_order_id FROM positions_meta WHERE symbol = ?')
        .get('AAPL') as { current_stop_alpaca_order_id: string };
      expect(row.current_stop_alpaca_order_id).toBe('stop-existing');
    });

    it('still inserts positions_meta when submitStop throws (best-effort)', async () => {
      const cfg = loadConfig(env);
      const alpaca: AlpacaClient = {
        ...fakeAlpaca([]),
        getPositions: async () => [
          {
            symbol: 'AAPL',
            qty: '7',
            avg_entry_price: '180',
            current_price: '185',
            unrealized_plpc: '0',
          },
        ],
        getBars: async () => fakeBars,
        getOrders: async () => [],
        submitStop: async () => {
          throw new Error('alpaca: stop orders not supported for this asset');
        },
      };
      const result = await reconcilePositions(alpaca, cfg, new Date(), { autoCorrect: true });
      expect(result.autoCorrected).toEqual(['AAPL']);
      const row = getRawSqlite()
        .prepare('SELECT current_stop_alpaca_order_id, qty FROM positions_meta WHERE symbol = ?')
        .get('AAPL') as { current_stop_alpaca_order_id: string | null; qty: number };
      expect(row.qty).toBe(7);
      // Stop submission failed — row inserted with null stop id; operator must
      // place a stop manually. Logged as a warning by the implementation.
      expect(row.current_stop_alpaca_order_id).toBeNull();
    });

    it('autoCorrect=false (default) leaves missing_in_db as a drift mismatch', async () => {
      const cfg = loadConfig(env);
      const alpaca: AlpacaClient = {
        ...fakeAlpaca([]),
        getPositions: async () => [
          {
            symbol: 'AAPL',
            qty: '10',
            avg_entry_price: '180',
            current_price: '185',
            unrealized_plpc: '0',
          },
        ],
      };
      const result = await reconcilePositions(alpaca, cfg);
      expect(result.severity).toBe('critical');
      expect(result.mismatches[0]!.kind).toBe('missing_in_db');
      expect(result.autoCorrected).toBeUndefined();
      // No row written
      const row = getRawSqlite()
        .prepare('SELECT * FROM positions_meta WHERE symbol = ?')
        .get('AAPL');
      expect(row).toBeUndefined();
    });

    it('falls back to floor(qty) for fractional positions when submitting the stop', async () => {
      const cfg = loadConfig(env);
      let stopQty = -1;
      const alpaca: AlpacaClient = {
        ...fakeAlpaca([]),
        getPositions: async () => [
          {
            symbol: 'AAPL',
            qty: '2.06411696', // fractional — Alpaca rejects fractional stops
            avg_entry_price: '180',
            current_price: '185',
            unrealized_plpc: '0',
          },
        ],
        getBars: async () => fakeBars,
        getOrders: async () => [],
        submitStop: async (args) => {
          stopQty = args.qty;
          return { id: 'stop-int', status: 'accepted' };
        },
      };
      const result = await reconcilePositions(alpaca, cfg, new Date(), { autoCorrect: true });
      expect(result.autoCorrected).toEqual(['AAPL']);
      expect(stopQty).toBe(2); // floor(2.06...) = 2 whole shares for the stop
      // positions_meta tracks the full fractional qty — only the protective
      // stop covers the integer slice. Operator notification handled via log.
      const row = getRawSqlite()
        .prepare('SELECT qty FROM positions_meta WHERE symbol = ?')
        .get('AAPL') as { qty: number };
      expect(row.qty).toBeCloseTo(2.06411696);
    });
  });
});
