import type { Config } from '../trading/config.js';
import type { MarketSnapshot, MarketSnapshotEntry, Regime } from '../trading/types.js';

export interface RegimeReading {
  regime: Regime;
  /** Symbol used for the macro classification (typically 'SPY'). */
  proxySymbol: string;
  /** SPY 50-day SMA value. */
  sma50: number | null;
  /** SPY 200-day SMA value. */
  sma200: number | null;
  /** 20-day annualized realized volatility, percent. */
  realizedVol20Pct: number | null;
  /** Drawdown from 60-day rolling high, percent. */
  drawdownFromHighPct: number | null;
  /** Latest close used. */
  latestPrice: number;
  /** Human-readable single-line summary (good for prompt rendering). */
  reason: string;
}

/**
 * Pure function: classify the macro regime using a single-symbol proxy
 * (default 'SPY') from the per-cycle market snapshot. No new market data feed
 * — uses bars already pulled by `fetchMarketSnapshot`.
 *
 * Heuristics (tunable later, deliberately simple for iter4):
 *   - risk_off: drawdown from 60d high > 10%, OR SPY 50d < 200d AND realized vol > 25%
 *   - risk_on:  SPY 50d > 200d AND drawdown from high < 5% AND realized vol < 18%
 *   - chop:     everything else
 *
 * Returns a default 'risk_on' classification if there's not enough history
 * (e.g. fresh test fixtures) so we never block trading on missing macro data.
 */
export function classifyRegime(
  market: MarketSnapshot,
  cfg: Config,
  proxySymbol = 'SPY',
): RegimeReading {
  const snap: MarketSnapshotEntry | undefined = market[proxySymbol];
  if (!snap || snap.bars.length < 20) {
    return {
      regime: 'risk_on',
      proxySymbol,
      sma50: null,
      sma200: null,
      realizedVol20Pct: null,
      drawdownFromHighPct: null,
      latestPrice: snap?.latestPrice ?? 0,
      reason: 'insufficient history; defaulting to risk_on',
    };
  }

  const closes = snap.bars.map((b) => b.close);
  const latestPrice = snap.latestPrice || closes.at(-1) || 0;
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const realizedVol20Pct = annualizedVol(closes.slice(-21), 20);
  const drawdownFromHighPct = drawdownFromTrailingHigh(closes, 60);

  // Defaults when individual signals can't be computed (short history).
  const trendPositive = sma50 !== null && sma200 !== null ? sma50 > sma200 : true;
  const dd = drawdownFromHighPct ?? 0;
  const vol = realizedVol20Pct ?? 0;

  let regime: Regime;
  let reason: string;
  if (dd > 10 || (!trendPositive && vol > 25)) {
    regime = 'risk_off';
    reason = `risk_off: dd=${dd.toFixed(1)}% trend50>200=${trendPositive} vol20=${vol.toFixed(1)}%`;
  } else if (trendPositive && dd < 5 && vol < 18) {
    regime = 'risk_on';
    reason = `risk_on: dd=${dd.toFixed(1)}% trend50>200=true vol20=${vol.toFixed(1)}%`;
  } else {
    regime = 'chop';
    reason = `chop: dd=${dd.toFixed(1)}% trend50>200=${trendPositive} vol20=${vol.toFixed(1)}%`;
  }

  return {
    regime,
    proxySymbol,
    sma50,
    sma200,
    realizedVol20Pct,
    drawdownFromHighPct,
    latestPrice,
    reason,
  };
}

/** Returns a one-line "Macro regime" summary suitable for the user prompt. */
export function formatRegimeLine(r: RegimeReading): string {
  return `Macro regime (${r.proxySymbol}): ${r.regime.toUpperCase()} — ${r.reason}`;
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  let sum = 0;
  for (const v of slice) sum += v;
  return sum / period;
}

/**
 * Annualized realized volatility from log returns over `period` days.
 * Returns null if fewer than `period + 1` closes are available. The 252
 * trading-day convention is used.
 */
function annualizedVol(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  const returns: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const a = slice[i - 1]!;
    const b = slice[i]!;
    if (a > 0 && b > 0) returns.push(Math.log(b / a));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

/** Peak-to-current drawdown over the trailing `windowDays` closes, as a positive %. */
function drawdownFromTrailingHigh(closes: number[], windowDays: number): number | null {
  if (closes.length < 2) return null;
  const slice = closes.slice(-windowDays);
  let peak = slice[0]!;
  for (const c of slice) if (c > peak) peak = c;
  const last = slice.at(-1)!;
  if (peak <= 0) return null;
  return ((peak - last) / peak) * 100;
}
