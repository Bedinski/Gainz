import { getRawSqlite } from '../db/client.js';
import type { Config } from './config.js';

export interface EquityPoint {
  recordedAt: number;
  date: string;
  equityUsd: number;
  cashUsd: number;
}

export interface CircuitBreakerVerdict {
  triggered: boolean;
  /** Drawdown from rolling-window peak, percent (positive). */
  drawdownPct: number;
  peakEquityUsd: number;
  currentEquityUsd: number;
  /** Human-readable reason for `daily_state.halt_reason`. */
  reason: string;
  /** When triggered, the cooldown end timestamp (ms). */
  cooldownUntilMs?: number;
}

/**
 * Append a new equity datapoint. One row per cycle. Cheap upsert keyed by
 * `recorded_at` (ms epoch) so retries within the same millisecond don't
 * double-count. Uses ISO-day for cheap day-aggregation queries.
 */
export function recordEquity(now: Date, equityUsd: number, cashUsd: number): void {
  const db = getRawSqlite();
  db.prepare(
    `INSERT OR REPLACE INTO equity_history (recorded_at, date, equity_usd, cash_usd)
     VALUES (?, ?, ?, ?)`,
  ).run(now.getTime(), now.toISOString().slice(0, 10), equityUsd, cashUsd);
}

/**
 * Pure function: given the equity history (sorted ascending by `recordedAt`)
 * and the config, decide whether the rolling-window drawdown circuit breaker
 * should fire. Returns a verdict; the caller is responsible for setting
 * `daily_state.halted = 1` and dispatching an alert.
 */
export function checkDrawdownCircuitBreaker(
  history: EquityPoint[],
  cfg: Config,
  now: Date,
): CircuitBreakerVerdict {
  if (!cfg.CIRCUIT_BREAKER_ENABLED || history.length < 2) {
    return {
      triggered: false,
      drawdownPct: 0,
      peakEquityUsd: history.at(-1)?.equityUsd ?? 0,
      currentEquityUsd: history.at(-1)?.equityUsd ?? 0,
      reason: 'circuit breaker disabled or insufficient history',
    };
  }

  const cutoffMs = now.getTime() - cfg.CIRCUIT_BREAKER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const window = history.filter((p) => p.recordedAt >= cutoffMs);
  if (window.length < 2) {
    return {
      triggered: false,
      drawdownPct: 0,
      peakEquityUsd: history.at(-1)!.equityUsd,
      currentEquityUsd: history.at(-1)!.equityUsd,
      reason: 'window has < 2 datapoints',
    };
  }

  let peak = window[0]!.equityUsd;
  for (const p of window) if (p.equityUsd > peak) peak = p.equityUsd;
  const current = window.at(-1)!.equityUsd;
  const drawdownPct = peak > 0 ? ((peak - current) / peak) * 100 : 0;

  if (drawdownPct >= cfg.CIRCUIT_BREAKER_DD_PCT) {
    const cooldownUntilMs = now.getTime() + cfg.CIRCUIT_BREAKER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    return {
      triggered: true,
      drawdownPct,
      peakEquityUsd: peak,
      currentEquityUsd: current,
      reason: `circuit-breaker: ${cfg.CIRCUIT_BREAKER_WINDOW_DAYS}d DD = ${drawdownPct.toFixed(2)}% (peak=${peak.toFixed(0)} → current=${current.toFixed(0)}); cooldown ${cfg.CIRCUIT_BREAKER_COOLDOWN_DAYS}d`,
      cooldownUntilMs,
    };
  }

  return {
    triggered: false,
    drawdownPct,
    peakEquityUsd: peak,
    currentEquityUsd: current,
    reason: `dd=${drawdownPct.toFixed(2)}% < threshold ${cfg.CIRCUIT_BREAKER_DD_PCT}%`,
  };
}

/** Convenience: load the equity history from the DB ordered by recordedAt asc. */
export function loadEquityHistory(): EquityPoint[] {
  const db = getRawSqlite();
  const rows = db
    .prepare(
      `SELECT recorded_at AS recordedAt, date, equity_usd AS equityUsd, cash_usd AS cashUsd
       FROM equity_history
       ORDER BY recorded_at ASC`,
    )
    .all() as EquityPoint[];
  return rows;
}
