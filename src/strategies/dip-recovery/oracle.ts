import type { Config } from '../../trading/config.js';
import { computeDrawdown, recoveryTargetPrice } from './detector.js';

/**
 * Deterministic strategy oracle used by the backtest harness. Mirrors the
 * gates the live detector applies (rebound confirmation, drawdown threshold,
 * political-shock gate) but doesn't talk to Claude — so the backtest is
 * reproducible and free.
 *
 * In production a real Claude call layers judgment ON TOP of these gates. The
 * oracle's job in backtest is to validate the surrounding plumbing
 * (detection, sizing, exits, budget thresholds) — not Claude's contribution.
 */

export interface OracleBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface OracleEvent {
  symbol: string;
  detectedAt: string;
  peakPrice: number;
  peakDate: string;
  troughPrice: number;
  troughDate: string;
  drawdownPct: number;
  targetPrice: number;
  expiresAt: number;
  status: 'active' | 'entered' | 'recovered' | 'expired';
  position?: { entryDate: string; entryPrice: number; qty: number; notional: number };
}

export interface OracleTrade {
  symbol: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  notional: number;
  pnlUsd: number;
  pnlPct: number;
  exitReason: 'target_hit' | 'time_expiry';
  drawdownPct: number;
  daysHeld: number;
  dipEventDetectedAt: string;
}

export interface OracleOpts {
  detectorOnly?: boolean;
}

export function runStrategyOracle(
  symbol: string,
  bars: OracleBar[],
  newsByDay: Map<string, Array<{ category: string }>>,
  cfg: Config,
  opts: OracleOpts = {},
): { events: OracleEvent[]; trades: OracleTrade[] } {
  const events: OracleEvent[] = [];
  const trades: OracleTrade[] = [];
  let active: OracleEvent | null = null;

  for (let i = cfg.DIP_DETECTION_WINDOW_DAYS; i < bars.length; i++) {
    const today = bars[i]!;
    const todayDate = today.t.slice(0, 10);
    const window = bars.slice(0, i + 1).map((b) => ({
      t: b.t,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
    const dd = computeDrawdown(window, { windowDays: cfg.DIP_DETECTION_WINDOW_DAYS });
    if (!dd) continue;

    if (active) {
      if (dd.troughPrice < active.troughPrice) {
        active.troughPrice = dd.troughPrice;
        active.troughDate = dd.troughDate;
        active.drawdownPct = dd.drawdownPct;
        active.targetPrice = recoveryTargetPrice(active.peakPrice, active.troughPrice, cfg.DIP_TARGET_RECOVERY_PCT);
      }
      const todayMs = Date.parse(today.t);

      if (active.position) {
        const targetHit = today.h >= active.targetPrice;
        const expired = todayMs >= active.expiresAt;
        if (targetHit || expired) {
          const exitPrice = targetHit ? active.targetPrice : today.o;
          const reason: 'target_hit' | 'time_expiry' = targetHit ? 'target_hit' : 'time_expiry';
          const pnlUsd = (exitPrice - active.position.entryPrice) * active.position.qty;
          const pnlPct = ((exitPrice - active.position.entryPrice) / active.position.entryPrice) * 100;
          const daysHeld = (Date.parse(todayDate) - Date.parse(active.position.entryDate)) / 86_400_000;
          trades.push({
            symbol,
            entryDate: active.position.entryDate,
            exitDate: todayDate,
            entryPrice: active.position.entryPrice,
            exitPrice,
            qty: active.position.qty,
            notional: active.position.notional,
            pnlUsd,
            pnlPct,
            exitReason: reason,
            drawdownPct: active.drawdownPct,
            daysHeld,
            dipEventDetectedAt: active.detectedAt,
          });
          active.status = reason === 'target_hit' ? 'recovered' : 'expired';
          events.push(active);
          active = null;
          continue;
        }
      } else {
        if (Date.parse(today.t) >= active.expiresAt) {
          active.status = 'expired';
          events.push(active);
          active = null;
          continue;
        }
        const rebound = dd.reboundBars >= cfg.DIP_REBOUND_CONFIRMATION_BARS;
        if (rebound && !opts.detectorOnly) {
          const inLookback = lookbackHasShock(newsByDay, todayDate, cfg.NEWS_LOOKBACK_HOURS);
          if (!cfg.DIP_REQUIRES_POLITICAL_NEWS || inLookback) {
            const next = bars[i + 1];
            if (next) {
              const entryPrice = next.o;
              const notional = cfg.DIP_BUDGET_USD;
              const qty = notional / entryPrice;
              active.position = {
                entryDate: next.t.slice(0, 10),
                entryPrice,
                qty,
                notional,
              };
              active.status = 'entered';
            }
          }
        }
      }
      continue;
    }

    if (dd.drawdownPct < cfg.DIP_DRAWDOWN_THRESHOLD_PCT) continue;
    if (cfg.DIP_REQUIRES_POLITICAL_NEWS) {
      const inLookback = lookbackHasShock(newsByDay, todayDate, cfg.NEWS_LOOKBACK_HOURS);
      if (!inLookback) continue;
    }
    active = {
      symbol,
      detectedAt: todayDate,
      peakPrice: dd.peakPrice,
      peakDate: dd.peakDate,
      troughPrice: dd.troughPrice,
      troughDate: dd.troughDate,
      drawdownPct: dd.drawdownPct,
      targetPrice: recoveryTargetPrice(dd.peakPrice, dd.troughPrice, cfg.DIP_TARGET_RECOVERY_PCT),
      expiresAt: Date.parse(today.t) + cfg.DIP_RECOVERY_WINDOW_DAYS * 86_400_000,
      status: 'active',
    };
  }
  if (active) events.push(active);
  return { events, trades };
}

function lookbackHasShock(
  newsByDay: Map<string, Array<{ category: string }>>,
  date: string,
  hours: number,
): boolean {
  // Day-level granularity: a 24-hour lookback from "today" overlaps two
  // calendar days (today + yesterday), so we always include today and the
  // ceil(hours/24) days before it.
  const days = Math.ceil(hours / 24) + 1;
  const d = new Date(`${date}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const key = d.toISOString().slice(0, 10);
    const items = newsByDay.get(key);
    if (items?.some((n) => n.category === 'political_shock')) return true;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return false;
}
