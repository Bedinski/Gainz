import { describe, it, expect, beforeEach } from 'vitest';
import { applySchema } from '../src/db/migrate.js';
import { closeDb, getDb, getRawSqlite } from '../src/db/client.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import {
  computeDrawdown,
  formatDrawdownLine,
  recoveryTargetPrice,
  loadActiveDipEvents,
  updateDipEvents,
} from '../src/strategies/dip-recovery/detector.js';
import type { MarketSnapshot, NewsSignals } from '../src/trading/types.js';

const env = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'SPY,QQQ',
  DIP_STRATEGY_ENABLED: 'true',
  DIP_DRAWDOWN_THRESHOLD_PCT: '4',
  DIP_DETECTION_WINDOW_DAYS: '5',
  DIP_RECOVERY_WINDOW_DAYS: '14',
  DIP_TARGET_RECOVERY_PCT: '0.8',
  DIP_REQUIRES_POLITICAL_NEWS: 'true',
  DIP_BUDGET_USD: '800',
  DIP_REBOUND_CONFIRMATION_BARS: '2',
  DIP_SYMBOLS: 'SPY,QQQ',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

function bar(date: string, close: number, vol = 1_000_000) {
  return { t: `${date}T00:00:00Z`, open: close, high: close + 1, low: close - 1, close, volume: vol };
}

beforeEach(() => {
  closeDb();
  clearConfigCacheForTests();
  getDb(':memory:');
  applySchema();
});

describe('computeDrawdown', () => {
  it('returns null on too-few bars', () => {
    expect(computeDrawdown([], { windowDays: 5 })).toBeNull();
    expect(computeDrawdown([bar('2025-04-01', 100)], { windowDays: 5 })).toBeNull();
  });

  it('finds peak then trough at-or-after peak', () => {
    const bars = [
      bar('2025-04-01', 100),
      bar('2025-04-02', 105),
      bar('2025-04-03', 110), // peak
      bar('2025-04-04', 100),
      bar('2025-04-05', 96), // trough
    ];
    const r = computeDrawdown(bars, { windowDays: 5 });
    expect(r).not.toBeNull();
    expect(r!.peakPrice).toBe(110);
    expect(r!.peakDate).toBe('2025-04-03');
    expect(r!.troughPrice).toBe(96);
    expect(r!.drawdownPct).toBeCloseTo(((110 - 96) / 110) * 100, 4);
  });

  it('does not pick a trough that is before the peak', () => {
    // 90 is the lowest close, but it's before the 105 peak — it should NOT be the trough.
    const bars = [
      bar('2025-04-01', 90),
      bar('2025-04-02', 95),
      bar('2025-04-03', 105), // peak
      bar('2025-04-04', 102), // trough at-or-after peak (this one)
      bar('2025-04-05', 103),
    ];
    const r = computeDrawdown(bars, { windowDays: 5 });
    expect(r!.troughPrice).toBe(102);
  });

  it('counts consecutive higher closes since the trough', () => {
    const bars = [
      bar('2025-04-01', 110), // peak
      bar('2025-04-02', 100), // trough
      bar('2025-04-03', 102),
      bar('2025-04-04', 104),
      bar('2025-04-05', 106),
    ];
    const r = computeDrawdown(bars, { windowDays: 5 });
    expect(r!.reboundBars).toBe(3);
  });

  it('rebound bars stops at the first non-higher close', () => {
    const bars = [
      bar('2025-04-01', 110),
      bar('2025-04-02', 100),
      bar('2025-04-03', 102), // higher
      bar('2025-04-04', 102), // not higher → break
      bar('2025-04-05', 105),
    ];
    const r = computeDrawdown(bars, { windowDays: 5 });
    expect(r!.reboundBars).toBe(1);
  });

  it('formats a friendly summary line', () => {
    const r = computeDrawdown(
      [bar('2025-04-01', 110), bar('2025-04-02', 95)],
      { windowDays: 5 },
    );
    const line = formatDrawdownLine('SPY', r);
    expect(line).toContain('SPY drawdown');
    expect(line).toContain('-13.6%');
  });
});

describe('recoveryTargetPrice', () => {
  it('80% retrace is 20% of the gap below peak', () => {
    expect(recoveryTargetPrice(100, 90, 0.8)).toBe(98);
  });
  it('100% retrace is the peak', () => {
    expect(recoveryTargetPrice(100, 90, 1.0)).toBe(100);
  });
  it('0% retrace is the trough', () => {
    expect(recoveryTargetPrice(100, 90, 0)).toBe(90);
  });
});

describe('updateDipEvents lifecycle', () => {
  function buildMarket(spyBars: ReturnType<typeof bar>[]): MarketSnapshot {
    return {
      SPY: { symbol: 'SPY', latestPrice: spyBars.at(-1)!.close, atr14: 2, bars: spyBars },
      QQQ: { symbol: 'QQQ', latestPrice: spyBars.at(-1)!.close, atr14: 2, bars: spyBars },
    };
  }
  function newsWith(category: string): NewsSignals {
    return {
      SPY: [
        {
          symbol: 'SPY',
          headline: 'tariff news',
          source: 'Benzinga',
          category: category as never,
          publishedAt: Date.now(),
        },
      ],
      QQQ: [],
    };
  }

  it('inserts an active row when drawdown threshold met AND political_shock present', () => {
    const cfg = loadConfig(env);
    const bars = [
      bar('2025-04-01', 100),
      bar('2025-04-02', 105),
      bar('2025-04-03', 110), // peak
      bar('2025-04-04', 100),
      bar('2025-04-05', 95), // trough → -13.6%
    ];
    const r = updateDipEvents({
      cfg,
      market: buildMarket(bars),
      news: newsWith('political_shock'),
      now: new Date('2025-04-05T16:00:00Z'),
    });
    expect(r.inserted.length).toBeGreaterThanOrEqual(1);
    const spy = r.inserted.find((e) => e.symbol === 'SPY');
    expect(spy?.drawdownPct).toBeGreaterThan(13);
    expect(spy?.status).toBe('active');
  });

  it('does NOT insert when DIP_REQUIRES_POLITICAL_NEWS=true and no shock present', () => {
    const cfg = loadConfig(env);
    const bars = [
      bar('2025-04-01', 100),
      bar('2025-04-02', 110),
      bar('2025-04-03', 95),
    ];
    const r = updateDipEvents({
      cfg,
      market: buildMarket(bars),
      news: newsWith('earnings'),
      now: new Date('2025-04-03T16:00:00Z'),
    });
    expect(r.inserted.length).toBe(0);
  });

  it('marks recovered when currentPrice >= target on next pass', () => {
    const cfg = loadConfig(env);
    const dropBars = [
      bar('2025-04-01', 100),
      bar('2025-04-02', 110),
      bar('2025-04-03', 95),
    ];
    updateDipEvents({
      cfg,
      market: buildMarket(dropBars),
      news: newsWith('political_shock'),
      now: new Date('2025-04-03T16:00:00Z'),
    });
    // recovery: target = 110 - (110-95)*0.2 = 107. Push current to 108.
    const recoveryBars = [...dropBars, bar('2025-04-04', 108)];
    const r = updateDipEvents({
      cfg,
      market: buildMarket(recoveryBars),
      news: newsWith('political_shock'),
      now: new Date('2025-04-04T16:00:00Z'),
    });
    expect(r.recovered.length).toBeGreaterThanOrEqual(1);
  });

  it('marks expired when now > expires_at', () => {
    const cfg = loadConfig(env);
    const dropBars = [
      bar('2025-04-01', 100),
      bar('2025-04-02', 110),
      bar('2025-04-03', 95),
    ];
    updateDipEvents({
      cfg,
      market: buildMarket(dropBars),
      news: newsWith('political_shock'),
      now: new Date('2025-04-03T16:00:00Z'),
    });
    // jump 30 days into the future without recovery
    const r = updateDipEvents({
      cfg,
      market: buildMarket(dropBars),
      news: newsWith('political_shock'),
      now: new Date('2025-05-05T16:00:00Z'),
    });
    expect(r.expired.length).toBeGreaterThanOrEqual(1);
    const stillActive = loadActiveDipEvents(['SPY', 'QQQ']);
    expect(stillActive.find((e) => e.status === 'active')).toBeUndefined();
  });
});
