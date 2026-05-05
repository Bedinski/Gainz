/**
 * Sample-size + confidence-interval helpers, ported from Stonks's risk_metrics.py
 * + pattern_stats.py.
 *
 * Two patterns we adopt:
 *   1. LOW_SAMPLE_THRESHOLD (n < 6 ≈ 1.5 years of quarterly data) — flagged so
 *      consumers can render "low_sample" tags rather than silently treating a
 *      3-sample win rate the same as a 30-sample win rate.
 *   2. Wilson score interval for binomial rates + normal approximation for the
 *      mean of a small sample. Both intervals widen sharply at small n; use the
 *      `lowSample` flag in the returned summary as the trigger to caveat downstream.
 *
 * NB: the normal-CI is a normal approximation, not a t-distribution interval —
 * for n < 30 the true t-interval is wider. Consumers should treat `lowSample`
 * results as directional rather than precise.
 */

export const LOW_SAMPLE_THRESHOLD = 6;

/** Two-sided 95% z-critical value. */
const Z_95 = 1.959963984540054;

export interface ConfidenceInterval {
  /** Lower bound (inclusive). */
  lo: number;
  /** Upper bound (inclusive). */
  hi: number;
}

export interface RateSummary {
  /** Wins / n as a 0-1 fraction. */
  rate: number;
  /** Wins / n as a 0-100 percentage (rounded to 1dp). */
  pct: number;
  /** Successes. */
  wins: number;
  /** Trials. */
  n: number;
  /** Wilson 95% interval expressed as 0-100 percentages. */
  ci95Pct: ConfidenceInterval;
  /** True when n < LOW_SAMPLE_THRESHOLD. */
  lowSample: boolean;
}

export interface MeanSummary {
  mean: number;
  n: number;
  /** Normal-approximation 95% interval on the mean. */
  ci95: ConfidenceInterval;
  /** True when n < LOW_SAMPLE_THRESHOLD. */
  lowSample: boolean;
}

export function isLowSample(n: number): boolean {
  return n < LOW_SAMPLE_THRESHOLD;
}

/**
 * Wilson score interval for a binomial proportion. Returns 0-1 fractions.
 * Stable at small n (unlike the normal approximation which can produce
 * intervals outside [0,1]).
 */
export function wilsonScoreCi(wins: number, n: number, z: number = Z_95): ConfidenceInterval {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    lo: Math.max(0, center - margin),
    hi: Math.min(1, center + margin),
  };
}

/**
 * Summary of a binomial rate: pct + Wilson 95% CI + lowSample flag.
 * `wins` and `n` are clamped to non-negative integers in callers.
 */
export function summarizeRate(wins: number, n: number): RateSummary {
  const safeN = Math.max(0, Math.floor(n));
  const safeWins = Math.max(0, Math.min(safeN, Math.floor(wins)));
  const rate = safeN === 0 ? 0 : safeWins / safeN;
  const ci = wilsonScoreCi(safeWins, safeN);
  return {
    rate,
    pct: round1(rate * 100),
    wins: safeWins,
    n: safeN,
    ci95Pct: { lo: round1(ci.lo * 100), hi: round1(ci.hi * 100) },
    lowSample: isLowSample(safeN),
  };
}

/**
 * Normal-approximation 95% CI on the mean of a sample. Returns null when
 * the sample is empty or has only one observation (no defined sample stddev).
 */
export function normalCiMean(values: number[], z: number = Z_95): MeanSummary | null {
  const xs = values.filter((v) => Number.isFinite(v));
  const n = xs.length;
  if (n === 0) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) {
    return {
      mean: round2(mean),
      n,
      ci95: { lo: mean, hi: mean },
      lowSample: true,
    };
  }
  let sumSq = 0;
  for (const x of xs) sumSq += (x - mean) ** 2;
  const sd = Math.sqrt(sumSq / (n - 1));
  const se = sd / Math.sqrt(n);
  const margin = z * se;
  return {
    mean: round2(mean),
    n,
    ci95: { lo: round2(mean - margin), hi: round2(mean + margin) },
    lowSample: isLowSample(n),
  };
}

/**
 * Render a RateSummary as a one-liner suitable for a prompt block.
 * Example: "3/5 = 60.0% (95% CI [22.4%, 88.2%]) — LOW_SAMPLE"
 */
export function formatRateSummary(s: RateSummary): string {
  const tag = s.lowSample ? ' — LOW_SAMPLE' : '';
  return `${s.wins}/${s.n} = ${s.pct.toFixed(1)}% (95% CI [${s.ci95Pct.lo.toFixed(1)}%, ${s.ci95Pct.hi.toFixed(1)}%])${tag}`;
}

/**
 * Render a MeanSummary as a one-liner. Caller supplies the unit suffix
 * (e.g. "%" for returns).
 */
export function formatMeanSummary(s: MeanSummary, unit: string = ''): string {
  const tag = s.lowSample ? ' — LOW_SAMPLE' : '';
  const u = unit;
  return `mean ${s.mean.toFixed(2)}${u} (95% CI [${s.ci95.lo.toFixed(2)}${u}, ${s.ci95.hi.toFixed(2)}${u}], n=${s.n})${tag}`;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
