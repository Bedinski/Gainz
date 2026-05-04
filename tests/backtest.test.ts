import { describe, it, expect, beforeEach } from 'vitest';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import { runStrategyOracle, type OracleBar } from '../src/strategies/dip-recovery/oracle.js';

const env = {
  TRADING_MODE: 'paper',
  DIP_STRATEGY_ENABLED: 'true',
  DIP_DRAWDOWN_THRESHOLD_PCT: '4',
  DIP_DETECTION_WINDOW_DAYS: '5',
  DIP_RECOVERY_WINDOW_DAYS: '14',
  DIP_TARGET_RECOVERY_PCT: '0.8',
  DIP_REQUIRES_POLITICAL_NEWS: 'true',
  DIP_BUDGET_USD: '800',
  DIP_REBOUND_CONFIRMATION_BARS: '2',
  DIP_SYMBOLS: 'SPY',
  NEWS_LOOKBACK_HOURS: '24',
} as unknown as NodeJS.ProcessEnv;

function bar(date: string, o: number, h: number, l: number, c: number): OracleBar {
  return { t: `${date}T00:00:00Z`, o, h, l, c, v: 1_000_000 };
}

beforeEach(() => clearConfigCacheForTests());

describe('runStrategyOracle (backtest core)', () => {
  // Fixture: a simple TACO cycle.
  //   day 1-3: rising (peak day 3 @ 110)
  //   day 4-7: tariff news + drop to 95 (-13.6%)
  //   day 8-9: rebound bars (98, 102)
  //   day 10+: keep recovering through target
  function tacoCycleBars(): OracleBar[] {
    return [
      bar('2025-04-01', 100, 102, 99, 100),
      bar('2025-04-02', 100, 106, 100, 105),
      bar('2025-04-03', 105, 111, 105, 110), // peak
      bar('2025-04-04', 110, 110, 100, 102), // drop starts
      bar('2025-04-05', 102, 102, 95, 96),
      bar('2025-04-06', 96, 96, 93, 95), // trough
      bar('2025-04-07', 95, 100, 95, 98), // rebound bar 1
      bar('2025-04-08', 98, 103, 98, 102), // rebound bar 2 → confirmation met
      bar('2025-04-09', 102, 105, 102, 104), // entry happens at this open ($102)
      bar('2025-04-10', 104, 109, 104, 108), // target $107 hit intraday (high=109)
      bar('2025-04-11', 108, 110, 108, 109),
    ];
  }

  it('detects, enters, and exits a TACO-style dip with positive P&L', () => {
    const cfg = loadConfig(env);
    const bars = tacoCycleBars();
    const news = new Map<string, Array<{ category: string }>>();
    // Tariff news streams across the dip; with a 24h lookback the detector
    // only sees today + yesterday, so news must be present on / near detection
    // (04-06) AND at the entry-decision day (04-08).
    for (const d of ['2025-04-04', '2025-04-05', '2025-04-06', '2025-04-07', '2025-04-08']) {
      news.set(d, [{ category: 'political_shock' }]);
    }

    const { events, trades } = runStrategyOracle('SPY', bars, news, cfg);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(trades.length).toBe(1);
    const t = trades[0]!;
    expect(t.exitReason).toBe('target_hit');
    // target = 110 - (110-95)*0.2 = 107
    expect(t.exitPrice).toBeCloseTo(107, 2);
    expect(t.pnlUsd).toBeGreaterThan(0);
  });

  it('does not enter when DIP_REQUIRES_POLITICAL_NEWS=true and no shock present', () => {
    const cfg = loadConfig(env);
    const bars = tacoCycleBars();
    const news = new Map<string, Array<{ category: string }>>();
    // Only earnings news — no political shock at all
    news.set('2025-04-04', [{ category: 'earnings' }]);
    const { events, trades } = runStrategyOracle('SPY', bars, news, cfg);
    expect(events.length).toBe(0);
    expect(trades.length).toBe(0);
  });

  it('detector-only mode never enters a position', () => {
    const cfg = loadConfig(env);
    const bars = tacoCycleBars();
    const news = new Map<string, Array<{ category: string }>>();
    for (const d of ['2025-04-04', '2025-04-05', '2025-04-06', '2025-04-07', '2025-04-08']) {
      news.set(d, [{ category: 'political_shock' }]);
    }
    const { events, trades } = runStrategyOracle('SPY', bars, news, cfg, { detectorOnly: true });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(trades.length).toBe(0);
  });

  it('produces deterministic output: same input → same trades', () => {
    const cfg = loadConfig(env);
    const bars = tacoCycleBars();
    const news = new Map<string, Array<{ category: string }>>();
    for (const d of ['2025-04-04', '2025-04-05', '2025-04-06', '2025-04-07', '2025-04-08']) {
      news.set(d, [{ category: 'political_shock' }]);
    }
    const a = runStrategyOracle('SPY', bars, news, cfg);
    const b = runStrategyOracle('SPY', bars, news, cfg);
    expect(JSON.stringify(a.trades)).toBe(JSON.stringify(b.trades));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });

  it('time_expiry exit when recovery never materializes', () => {
    const cfg = loadConfig(env);
    // peak then drop, rebound 2 bars (confirms entry), then flat for >14 days
    const flatBars = [
      bar('2025-04-01', 100, 110, 100, 110),
      bar('2025-04-02', 110, 110, 100, 110),
      bar('2025-04-03', 110, 110, 110, 110),
      bar('2025-04-04', 110, 110, 100, 100),
      bar('2025-04-05', 100, 100, 95, 95),
      bar('2025-04-06', 95, 96, 95, 96),
      bar('2025-04-07', 96, 97, 96, 97),
    ];
    const flat = [...flatBars];
    for (let d = 8; d <= 35; d++) {
      const date = `2025-04-${String(d).padStart(2, '0')}`;
      flat.push(bar(date, 99, 100, 98, 99)); // never hits target $107
    }
    const news = new Map<string, Array<{ category: string }>>();
    for (const d of ['2025-04-04', '2025-04-05', '2025-04-06', '2025-04-07']) {
      news.set(d, [{ category: 'political_shock' }]);
    }

    const { trades } = runStrategyOracle('SPY', flat, news, cfg);
    expect(trades.length).toBe(1);
    expect(trades[0]!.exitReason).toBe('time_expiry');
    // Bailout is from detection, not entry. With a 2-bar rebound lag,
    // daysHeld = RECOVERY_WINDOW_DAYS - rebound-lag ≈ 12.
    expect(trades[0]!.daysHeld).toBeGreaterThanOrEqual(10);
    expect(trades[0]!.daysHeld).toBeLessThanOrEqual(cfg.DIP_RECOVERY_WINDOW_DAYS);
  });
});
