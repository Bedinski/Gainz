import { describe, it, expect } from 'vitest';
import { computeATR, type Bar } from '../src/trading/atr.js';

describe('computeATR', () => {
  it('returns NaN with too few bars', () => {
    const bars: Bar[] = Array.from({ length: 5 }, () => ({ high: 10, low: 9, close: 9.5 }));
    expect(Number.isNaN(computeATR(bars, 14))).toBe(true);
  });

  it('returns the simple TR average for exactly period+1 bars', () => {
    // 15 bars: each TR = high-low = 2 (no gap → high/close prev = same).
    const bars: Bar[] = Array.from({ length: 15 }, (_, i) => ({
      high: 12 + i * 0,
      low: 10 + i * 0,
      close: 11 + i * 0,
    }));
    const atr = computeATR(bars, 14);
    expect(atr).toBeCloseTo(2, 5);
  });

  it('Wilder-smooths with a gap', () => {
    // 16 bars: first 14 TRs = 2, the 15th TR involves a gap up of 5 → max(2, 5) = 5.
    const bars: Bar[] = [];
    for (let i = 0; i < 15; i++) bars.push({ high: 12, low: 10, close: 11 });
    bars.push({ high: 17, low: 15, close: 16 }); // gap up: TR = max(2, |17-11|, |15-11|) = 6
    const atr = computeATR(bars, 14);
    // Seed = 2 (avg of first 14 TRs). Then smooth: (2*13 + 6)/14 = 32/14 ≈ 2.2857
    expect(atr).toBeCloseTo(2.2857, 3);
  });
});
