import { describe, it, expect, beforeEach } from 'vitest';
import { applySchema } from '../src/db/migrate.js';
import { closeDb, getDb } from '../src/db/client.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import { computeDrawdown, updateDipEvents } from '../src/strategies/dip-recovery/detector.js';
import type { MarketSnapshot } from '../src/trading/types.js';

const env = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'SPY,QQQ',
  DIP_STRATEGY_ENABLED: 'true',
  DIP_DRAWDOWN_THRESHOLD_PCT: '4',
  DIP_DETECTION_WINDOW_DAYS: '5',
  DIP_RECOVERY_WINDOW_DAYS: '14',
  DIP_TARGET_RECOVERY_PCT: '0.8',
  DIP_REQUIRES_POLITICAL_NEWS: 'false',
  DIP_BUDGET_USD: '800',
  DIP_REBOUND_CONFIRMATION_BARS: '2',
  DIP_SYMBOLS: 'SPY,QQQ',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

function bar(date: string, close: number) {
  return { t: `${date}T00:00:00Z`, open: close, high: close + 1, low: close - 1, close, volume: 1_000_000 };
}

function dipBars() {
  // Peak at 100 → trough at 90 = -10% drawdown, then 2 higher closes (rebound).
  return [
    bar('2025-04-01', 100),
    bar('2025-04-02', 98),
    bar('2025-04-03', 90),
    bar('2025-04-04', 92),
    bar('2025-04-05', 94),
  ];
}

beforeEach(() => {
  closeDb();
  clearConfigCacheForTests();
  getDb(':memory:');
  applySchema();
});

describe('updateDipEvents drawdown dedupe', () => {
  it('uses caller-provided drawdown reading instead of computing internally', () => {
    const cfg = loadConfig(env);
    const market: MarketSnapshot = {
      SPY: { symbol: 'SPY', latestPrice: 94, atr14: 2, bars: dipBars() },
      QQQ: { symbol: 'QQQ', latestPrice: 94, atr14: 2, bars: dipBars() },
    };

    // Sentinel: an extreme reading the detector would never compute itself.
    // If the precomputed map is honored, the inserted dip_events row carries
    // these sentinel values; if it's ignored, real values land instead.
    const sentinelSpy = {
      peakPrice: 999,
      peakDate: '2025-04-01',
      troughPrice: 1,
      troughDate: '2025-04-03',
      currentPrice: 94,
      drawdownPct: 99.9,
      daysFromPeak: 4,
      daysSinceTrough: 2,
      reboundBars: 2,
    };
    const drawdowns = { SPY: sentinelSpy, QQQ: sentinelSpy };

    const r = updateDipEvents({ cfg, market, now: new Date(), drawdowns });
    expect(r.inserted).toHaveLength(2);
    for (const evt of r.inserted) {
      expect(evt.peakPrice).toBe(999);
      expect(evt.troughPrice).toBe(1);
      expect(evt.drawdownPct).toBeCloseTo(99.9);
    }
  });

  it('falls back to internal computeDrawdown when no map is supplied (parity with old behavior)', () => {
    const cfg = loadConfig(env);
    const market: MarketSnapshot = {
      SPY: { symbol: 'SPY', latestPrice: 94, atr14: 2, bars: dipBars() },
      QQQ: { symbol: 'QQQ', latestPrice: 94, atr14: 2, bars: dipBars() },
    };
    const expected = computeDrawdown(dipBars(), { windowDays: cfg.DIP_DETECTION_WINDOW_DAYS })!;

    const r = updateDipEvents({ cfg, market, now: new Date() });
    expect(r.inserted).toHaveLength(2);
    for (const evt of r.inserted) {
      expect(evt.peakPrice).toBe(expected.peakPrice);
      expect(evt.troughPrice).toBe(expected.troughPrice);
      expect(evt.drawdownPct).toBeCloseTo(expected.drawdownPct);
    }
  });

  it('treats null reading as "no drawdown" and inserts nothing (gracefully)', () => {
    const cfg = loadConfig(env);
    const market: MarketSnapshot = {
      SPY: { symbol: 'SPY', latestPrice: 94, atr14: 2, bars: dipBars() },
    };
    const r = updateDipEvents({
      cfg,
      market,
      now: new Date(),
      drawdowns: { SPY: null, QQQ: null },
    });
    expect(r.inserted).toHaveLength(0);
  });
});
