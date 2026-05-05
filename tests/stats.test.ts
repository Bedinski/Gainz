import { describe, it, expect } from 'vitest';
import {
  LOW_SAMPLE_THRESHOLD,
  formatMeanSummary,
  formatRateSummary,
  isLowSample,
  normalCiMean,
  summarizeRate,
  wilsonScoreCi,
} from '../src/lib/stats.js';

describe('LOW_SAMPLE_THRESHOLD + isLowSample', () => {
  it('matches the Stonks pattern_stats.py threshold (n < 6)', () => {
    expect(LOW_SAMPLE_THRESHOLD).toBe(6);
    expect(isLowSample(0)).toBe(true);
    expect(isLowSample(5)).toBe(true);
    expect(isLowSample(6)).toBe(false);
    expect(isLowSample(20)).toBe(false);
  });
});

describe('wilsonScoreCi', () => {
  it('returns the full [0,1] interval when n=0 (no information)', () => {
    expect(wilsonScoreCi(0, 0)).toEqual({ lo: 0, hi: 1 });
  });

  it('produces a wide interval at small n (5/6) — directional only', () => {
    // Reference: Wilson 95% on 5/6 ≈ [42%, 99%].
    const ci = wilsonScoreCi(5, 6);
    expect(ci.lo).toBeGreaterThan(0.4);
    expect(ci.lo).toBeLessThan(0.5);
    expect(ci.hi).toBeGreaterThan(0.95);
    expect(ci.hi).toBeLessThanOrEqual(1);
  });

  it('produces a tight interval at large n (60/100)', () => {
    // Reference: Wilson 95% on 60/100 ≈ [50.1%, 69.1%].
    const ci = wilsonScoreCi(60, 100);
    expect(ci.lo).toBeGreaterThan(0.49);
    expect(ci.lo).toBeLessThan(0.52);
    expect(ci.hi).toBeGreaterThan(0.68);
    expect(ci.hi).toBeLessThan(0.71);
  });

  it('clamps to [0, 1] at the extremes', () => {
    const allWins = wilsonScoreCi(10, 10);
    expect(allWins.hi).toBeLessThanOrEqual(1);
    expect(allWins.lo).toBeGreaterThanOrEqual(0);
    const allLoss = wilsonScoreCi(0, 10);
    expect(allLoss.lo).toBe(0);
    expect(allLoss.hi).toBeGreaterThan(0);
  });
});

describe('summarizeRate', () => {
  it('flags low-sample rates and renders rounded percentages', () => {
    const s = summarizeRate(3, 5);
    expect(s.wins).toBe(3);
    expect(s.n).toBe(5);
    expect(s.pct).toBeCloseTo(60, 0);
    expect(s.lowSample).toBe(true);
    expect(s.ci95Pct.lo).toBeLessThan(s.pct);
    expect(s.ci95Pct.hi).toBeGreaterThan(s.pct);
  });

  it('clears lowSample at n>=6', () => {
    expect(summarizeRate(4, 6).lowSample).toBe(false);
  });

  it('clamps wins to [0, n] and floors fractional inputs', () => {
    const s = summarizeRate(99, 5); // capped to 5
    expect(s.wins).toBe(5);
    expect(s.pct).toBe(100);
    const neg = summarizeRate(-3, 5); // floored to 0
    expect(neg.wins).toBe(0);
    expect(neg.pct).toBe(0);
  });

  it('handles n=0 without throwing', () => {
    const s = summarizeRate(0, 0);
    expect(s.n).toBe(0);
    expect(s.rate).toBe(0);
    expect(s.lowSample).toBe(true);
  });
});

describe('normalCiMean', () => {
  it('returns null on empty input', () => {
    expect(normalCiMean([])).toBeNull();
  });

  it('returns a degenerate (lo=hi=mean) interval at n=1 with lowSample=true', () => {
    const s = normalCiMean([2.5])!;
    expect(s.mean).toBe(2.5);
    expect(s.n).toBe(1);
    expect(s.ci95.lo).toBe(2.5);
    expect(s.ci95.hi).toBe(2.5);
    expect(s.lowSample).toBe(true);
  });

  it('produces a narrowing interval as n grows', () => {
    const small = normalCiMean([0.5, 1.5, -0.5, 1.0, 2.0])!; // n=5
    const large = normalCiMean(Array.from({ length: 50 }, (_, i) => (i % 3) - 1))!; // n=50
    const smallWidth = small.ci95.hi - small.ci95.lo;
    const largeWidth = large.ci95.hi - large.ci95.lo;
    expect(largeWidth).toBeLessThan(smallWidth);
    expect(small.lowSample).toBe(true);
    expect(large.lowSample).toBe(false);
  });

  it('drops non-finite values defensively', () => {
    const s = normalCiMean([1, 2, Number.NaN, Number.POSITIVE_INFINITY, 3])!;
    expect(s.n).toBe(3);
    expect(s.mean).toBe(2);
  });
});

describe('format helpers', () => {
  it('appends LOW_SAMPLE only when the sample is below threshold', () => {
    const small = formatRateSummary(summarizeRate(3, 5));
    const large = formatRateSummary(summarizeRate(60, 100));
    expect(small).toContain('LOW_SAMPLE');
    expect(large).not.toContain('LOW_SAMPLE');
  });

  it('renders mean summary with the supplied unit', () => {
    const s = normalCiMean([0.5, 1.5, -0.5, 1.0, 2.0])!;
    const line = formatMeanSummary(s, '%');
    expect(line).toContain('mean');
    expect(line).toContain('%');
    expect(line).toContain('n=5');
  });
});
