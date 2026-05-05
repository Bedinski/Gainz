import { describe, it, expect, beforeEach } from 'vitest';
import { classifyRegime, formatRegimeLine } from '../src/strategies/regime.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import type { MarketSnapshot } from '../src/trading/types.js';

const env = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'SPY',
  REGIME_RISK_OFF_REJECTS_BUYS: 'true',
  REGIME_CHOP_RISK_SCALE: '0.5',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => clearConfigCacheForTests());

function bars(closes: number[]) {
  return closes.map((c, i) => ({
    t: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    open: c,
    high: c + 0.5,
    low: c - 0.5,
    close: c,
    volume: 1_000_000,
  }));
}

function snapshot(closes: number[]): MarketSnapshot {
  const lastClose = closes.at(-1) ?? 0;
  return {
    SPY: { symbol: 'SPY', latestPrice: lastClose, atr14: 1, bars: bars(closes) },
  };
}

describe('classifyRegime', () => {
  it('returns risk_on default when history is too short', () => {
    const cfg = loadConfig(env);
    const r = classifyRegime(snapshot([100, 101]), cfg);
    expect(r.regime).toBe('risk_on');
    expect(r.reason).toContain('insufficient history');
  });

  it('classifies a steady uptrend with low vol as risk_on', () => {
    const cfg = loadConfig(env);
    // 250 days of 0.05% per day uptrend, very low realized vol, no drawdown.
    const closes = Array.from({ length: 250 }, (_, i) => 100 * Math.pow(1.0005, i));
    const r = classifyRegime(snapshot(closes), cfg);
    expect(r.regime).toBe('risk_on');
    expect(r.drawdownFromHighPct ?? 0).toBeLessThan(5);
  });

  it('classifies a deep drawdown as risk_off', () => {
    const cfg = loadConfig(env);
    // Climb to 100 then crash to 80 = 20% drawdown — well past 10% threshold.
    const up = Array.from({ length: 200 }, (_, i) => 80 + i * 0.1); // 80→100
    const down = Array.from({ length: 50 }, (_, i) => 100 - i * 0.4); // 100→80
    const r = classifyRegime(snapshot([...up, ...down]), cfg);
    expect(r.regime).toBe('risk_off');
    expect(r.drawdownFromHighPct ?? 0).toBeGreaterThan(10);
  });

  it('formatRegimeLine produces a single descriptive line', () => {
    const cfg = loadConfig(env);
    const r = classifyRegime(snapshot([100, 101, 102, 103, 104]), cfg);
    const line = formatRegimeLine(r);
    expect(line).toContain('Macro regime');
    expect(line).toContain('SPY');
    expect(line.split('\n')).toHaveLength(1);
  });
});
