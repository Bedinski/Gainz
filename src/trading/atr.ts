export interface Bar {
  high: number;
  low: number;
  close: number;
}

/**
 * Wilder's ATR. Returns NaN if fewer than `period + 1` bars are provided
 * (need a previous close for the first true range).
 */
export function computeATR(bars: Bar[], period = 14): number {
  if (bars.length < period + 1) return Number.NaN;

  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    trueRanges.push(tr);
  }

  // Seed with simple average of first `period` TRs, then Wilder-smooth the rest.
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]!) / period;
  }
  return atr;
}
