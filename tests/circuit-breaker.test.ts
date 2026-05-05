import { describe, it, expect, beforeEach } from 'vitest';
import { applySchema } from '../src/db/migrate.js';
import { closeDb, getDb, getRawSqlite } from '../src/db/client.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import {
  checkDrawdownCircuitBreaker,
  loadEquityHistory,
  recordEquity,
  type EquityPoint,
} from '../src/trading/circuit-breaker.js';

const env = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'AAPL',
  CIRCUIT_BREAKER_ENABLED: 'true',
  CIRCUIT_BREAKER_DD_PCT: '5',
  CIRCUIT_BREAKER_WINDOW_DAYS: '30',
  CIRCUIT_BREAKER_COOLDOWN_DAYS: '5',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  closeDb();
  clearConfigCacheForTests();
  getDb(':memory:');
  applySchema();
});

function points(equities: number[], startMs: number): EquityPoint[] {
  return equities.map((e, i) => ({
    recordedAt: startMs + i * 24 * 60 * 60 * 1000,
    date: new Date(startMs + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    equityUsd: e,
    cashUsd: e * 0.5,
  }));
}

describe('checkDrawdownCircuitBreaker', () => {
  it('does not trigger when DD is below threshold', () => {
    const cfg = loadConfig(env);
    const now = new Date();
    const history = points(
      // 4% drawdown — under 5% threshold
      [10_000, 10_100, 10_200, 10_300, 9_888],
      now.getTime() - 4 * 24 * 60 * 60 * 1000,
    );
    const v = checkDrawdownCircuitBreaker(history, cfg, now);
    expect(v.triggered).toBe(false);
    expect(v.drawdownPct).toBeCloseTo(4, 1);
  });

  it('triggers when DD exceeds threshold', () => {
    const cfg = loadConfig(env);
    const now = new Date();
    const history = points(
      // 6% drawdown — over 5% threshold
      [10_000, 10_500, 10_800, 10_500, 10_152],
      now.getTime() - 4 * 24 * 60 * 60 * 1000,
    );
    const v = checkDrawdownCircuitBreaker(history, cfg, now);
    expect(v.triggered).toBe(true);
    expect(v.drawdownPct).toBeGreaterThanOrEqual(5);
    expect(v.cooldownUntilMs).toBeGreaterThan(now.getTime());
  });

  it('respects the rolling window — old peaks outside window are ignored', () => {
    const cfg = loadConfig(env);
    const now = new Date();
    // Peak from 60 days ago should be excluded by the 30-day window.
    const old = {
      recordedAt: now.getTime() - 60 * 24 * 60 * 60 * 1000,
      date: '2025-01-01',
      equityUsd: 20_000,
      cashUsd: 0,
    };
    const recent = points(
      [10_000, 10_100, 10_200],
      now.getTime() - 2 * 24 * 60 * 60 * 1000,
    );
    const v = checkDrawdownCircuitBreaker([old, ...recent], cfg, now);
    expect(v.triggered).toBe(false);
    expect(v.peakEquityUsd).toBe(10_200); // not 20_000
  });

  it('returns disabled verdict when CIRCUIT_BREAKER_ENABLED=false', () => {
    const cfg = loadConfig({ ...env, CIRCUIT_BREAKER_ENABLED: 'false' } as unknown as NodeJS.ProcessEnv);
    const v = checkDrawdownCircuitBreaker(points([10_000, 5_000], Date.now()), cfg, new Date());
    expect(v.triggered).toBe(false);
  });
});

describe('recordEquity + loadEquityHistory', () => {
  it('round-trips equity points through SQLite', () => {
    recordEquity(new Date(1000), 10_000, 5_000);
    recordEquity(new Date(2000), 10_100, 5_050);
    const rows = loadEquityHistory();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.equityUsd).toBe(10_000);
    expect(rows[1]!.equityUsd).toBe(10_100);
    // ordered ascending
    expect(rows[0]!.recordedAt).toBeLessThan(rows[1]!.recordedAt);
  });

  it('rewriting the same recordedAt is idempotent (REPLACE)', () => {
    recordEquity(new Date(1000), 10_000, 5_000);
    recordEquity(new Date(1000), 12_000, 6_000);
    const rows = loadEquityHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.equityUsd).toBe(12_000);
  });
});
