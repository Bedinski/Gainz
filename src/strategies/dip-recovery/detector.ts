import type { Config } from '../../trading/config.js';
import type { DipEvent, MarketSnapshotEntry, NewsSignals } from '../../trading/types.js';
import { getRawSqlite } from '../../db/client.js';
import { logger } from '../../lib/logger.js';

export interface DrawdownReading {
  /** Highest close in the window. */
  peakPrice: number;
  /** Date (YYYY-MM-DD) of peakPrice. */
  peakDate: string;
  /** Lowest close at-or-after the peak in the window. */
  troughPrice: number;
  /** Date (YYYY-MM-DD) of troughPrice. */
  troughDate: string;
  /** Most recent close in the window — what we'd transact off if entering now. */
  currentPrice: number;
  /**
   * (peak - trough) / peak as a positive percentage. 7.1 means peak fell to
   * 92.9% of its value. 0 means no drawdown observed in the window.
   */
  drawdownPct: number;
  /** Trading days between peakDate and the latest bar (>=1 if a drawdown exists). */
  daysFromPeak: number;
  /** Trading days since the trough printed (the recovery clock). */
  daysSinceTrough: number;
  /** Number of consecutive higher-close bars since the trough. */
  reboundBars: number;
}

export interface ComputeDrawdownOpts {
  /** Trailing window in trading days. The function looks at the last N bars. */
  windowDays: number;
}

/**
 * Pure function: compute peak-to-trough drawdown over the trailing N bars.
 * The peak is the highest close in the window; the trough is the lowest close
 * AT OR AFTER that peak. This avoids the degenerate case of "lowest in window
 * then highest right after = call it a recovery" — we only count drawdown
 * that actually came after the peak.
 *
 * Returns null if there are too few bars.
 *
 * Bars must be in ascending chronological order (oldest first), which is how
 * Alpaca returns them and how MarketSnapshotEntry stores them.
 */
export function computeDrawdown(
  bars: MarketSnapshotEntry['bars'],
  { windowDays }: ComputeDrawdownOpts,
): DrawdownReading | null {
  if (bars.length < 2) return null;
  const slice = bars.slice(-windowDays);
  if (slice.length < 2) return null;

  // Find peak first.
  let peakIdx = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i]!.close > slice[peakIdx]!.close) peakIdx = i;
  }
  const peakBar = slice[peakIdx]!;

  // Find trough at or after the peak.
  let troughIdx = peakIdx;
  for (let i = peakIdx + 1; i < slice.length; i++) {
    if (slice[i]!.close < slice[troughIdx]!.close) troughIdx = i;
  }
  const troughBar = slice[troughIdx]!;

  const currentBar = slice[slice.length - 1]!;
  const drawdownPct =
    peakBar.close > 0
      ? ((peakBar.close - troughBar.close) / peakBar.close) * 100
      : 0;

  const daysFromPeak = slice.length - 1 - peakIdx;
  const daysSinceTrough = slice.length - 1 - troughIdx;

  // Rebound bars: count consecutive higher-close bars after the trough,
  // starting from troughIdx+1.
  let reboundBars = 0;
  for (let i = troughIdx + 1; i < slice.length; i++) {
    if (slice[i]!.close > slice[i - 1]!.close) reboundBars++;
    else break;
  }

  return {
    peakPrice: peakBar.close,
    peakDate: peakBar.t.slice(0, 10),
    troughPrice: troughBar.close,
    troughDate: troughBar.t.slice(0, 10),
    currentPrice: currentBar.close,
    drawdownPct,
    daysFromPeak,
    daysSinceTrough,
    reboundBars,
  };
}

/**
 * Compute the recovery target price for a given peak/trough pair.
 *   recoveryFraction = 0.8 → exit when 80% of the drawdown is reclaimed.
 *   target = peak - (peak - trough) * (1 - recoveryFraction)
 */
export function recoveryTargetPrice(
  peakPrice: number,
  troughPrice: number,
  recoveryFraction: number,
): number {
  return peakPrice - (peakPrice - troughPrice) * (1 - recoveryFraction);
}

interface DipEventRow {
  id: number;
  symbol: string;
  detected_at: number;
  peak_price: number;
  peak_date: string;
  trough_price: number;
  trough_date: string;
  drawdown_pct: number;
  recovery_target_price: number;
  status: DipEvent['status'];
  expires_at: number;
  associated_news_ids: string | null;
  position_symbol: string | null;
  notes: string | null;
}

function rowToDipEvent(r: DipEventRow): DipEvent {
  return {
    id: r.id,
    symbol: r.symbol,
    detectedAt: r.detected_at,
    peakPrice: r.peak_price,
    peakDate: r.peak_date,
    troughPrice: r.trough_price,
    troughDate: r.trough_date,
    drawdownPct: r.drawdown_pct,
    recoveryTargetPrice: r.recovery_target_price,
    status: r.status,
    expiresAt: r.expires_at,
    associatedNewsIds: r.associated_news_ids ? safeParseIds(r.associated_news_ids) : undefined,
    positionSymbol: r.position_symbol ?? undefined,
    notes: r.notes ?? undefined,
  };
}

function safeParseIds(s: string): number[] | undefined {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Active dip events for the configured symbols. */
export function loadActiveDipEvents(symbols: string[]): DipEvent[] {
  if (symbols.length === 0) return [];
  const db = getRawSqlite();
  const placeholders = symbols.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM dip_events
       WHERE symbol IN (${placeholders})
         AND status IN ('active','entered')
       ORDER BY detected_at DESC`,
    )
    .all(...symbols.map((s) => s.toUpperCase())) as DipEventRow[];
  return rows.map(rowToDipEvent);
}

export interface UpdateDipEventsArgs {
  cfg: Config;
  market: Record<string, MarketSnapshotEntry>;
  news?: NewsSignals;
  now: Date;
}

export interface UpdateDipEventsResult {
  inserted: DipEvent[];
  updated: DipEvent[];
  recovered: DipEvent[];
  expired: DipEvent[];
}

/**
 * Run the per-cycle dip-event lifecycle for each configured DIP_SYMBOL:
 *   - update trough_price on existing 'active' rows when a new low prints
 *   - mark 'recovered' when currentPrice >= recovery_target_price (and no open position)
 *   - mark 'expired' when now > expires_at
 *   - insert a new 'active' row when drawdown threshold is met (and political-news gate passes if required)
 *
 * Pure DB side-effects only (no orders, no Claude). Returns a summary of state
 * transitions for logging / dashboard.
 */
export function updateDipEvents({ cfg, market, news, now }: UpdateDipEventsArgs): UpdateDipEventsResult {
  const db = getRawSqlite();
  const result: UpdateDipEventsResult = { inserted: [], updated: [], recovered: [], expired: [] };
  const nowMs = now.getTime();

  for (const symbol of cfg.DIP_SYMBOLS) {
    const snap = market[symbol];
    if (!snap) {
      logger.warn({ symbol }, 'dip detector: no market snapshot for symbol; skipping');
      continue;
    }
    const reading = computeDrawdown(snap.bars, { windowDays: cfg.DIP_DETECTION_WINDOW_DAYS });
    if (!reading) continue;

    // 1. Existing active row?
    const existing = db
      .prepare(
        `SELECT * FROM dip_events WHERE symbol = ? AND status IN ('active','entered') ORDER BY detected_at DESC LIMIT 1`,
      )
      .get(symbol) as DipEventRow | undefined;

    if (existing) {
      // Update trough if a new low printed.
      if (reading.troughPrice < existing.trough_price) {
        db.prepare(
          `UPDATE dip_events SET trough_price = ?, trough_date = ?, drawdown_pct = ? WHERE id = ?`,
        ).run(reading.troughPrice, reading.troughDate, reading.drawdownPct, existing.id);
      }

      // Time-based expiry takes precedence over recovery (a non-recovery
      // sitting in the book past its deadline is an expired event regardless
      // of whether it briefly tagged the target intraday).
      if (nowMs > existing.expires_at) {
        db.prepare(`UPDATE dip_events SET status = 'expired' WHERE id = ?`).run(existing.id);
        result.expired.push(rowToDipEvent({ ...existing, status: 'expired' }));
        continue;
      }

      // Recovery: currentPrice (close of latest bar) >= target. Only mark
      // 'recovered' if there's no open position; if a position is open,
      // exit.ts handles the realized P&L and status flip.
      if (
        existing.status === 'active' &&
        snap.latestPrice >= existing.recovery_target_price &&
        !existing.position_symbol
      ) {
        db.prepare(`UPDATE dip_events SET status = 'recovered' WHERE id = ?`).run(existing.id);
        result.recovered.push(rowToDipEvent({ ...existing, status: 'recovered' }));
        continue;
      }

      // Otherwise just refresh trough side-effects logged above.
      result.updated.push(rowToDipEvent({ ...existing, trough_price: Math.min(existing.trough_price, reading.troughPrice) }));
      continue;
    }

    // 2. No active row → consider opening one.
    if (reading.drawdownPct < cfg.DIP_DRAWDOWN_THRESHOLD_PCT) continue;

    // Political-news gate.
    if (cfg.DIP_REQUIRES_POLITICAL_NEWS) {
      const hasShock = !!news && Object.values(news).some((list) =>
        list.some((n) => n.category === 'political_shock'),
      );
      if (!hasShock) continue;
    }

    const expiresAt = nowMs + cfg.DIP_RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const target = recoveryTargetPrice(reading.peakPrice, reading.troughPrice, cfg.DIP_TARGET_RECOVERY_PCT);
    const newsIds: number[] | undefined = news
      ? Object.values(news)
          .flat()
          .filter((n) => n.category === 'political_shock')
          .map(() => 0) // we don't have id here; left as a placeholder for now
          .filter(Boolean)
      : undefined;

    const ins = db
      .prepare(
        `INSERT INTO dip_events (
           symbol, detected_at, peak_price, peak_date, trough_price, trough_date, drawdown_pct,
           recovery_target_price, status, expires_at, associated_news_ids
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        symbol,
        nowMs,
        reading.peakPrice,
        reading.peakDate,
        reading.troughPrice,
        reading.troughDate,
        reading.drawdownPct,
        target,
        expiresAt,
        newsIds && newsIds.length ? JSON.stringify(newsIds) : null,
      );
    const inserted = db
      .prepare('SELECT * FROM dip_events WHERE id = ?')
      .get(Number(ins.lastInsertRowid)) as DipEventRow;
    result.inserted.push(rowToDipEvent(inserted));
  }

  return result;
}

/**
 * Returns a one-line summary suitable for the prompt's "Market state" block.
 */
export function formatDrawdownLine(symbol: string, r: DrawdownReading | null): string {
  if (!r) return `${symbol} drawdown: insufficient history`;
  if (r.drawdownPct < 0.5) return `${symbol} drawdown: none (within last window)  current=$${r.currentPrice.toFixed(2)}`;
  return (
    `${symbol} drawdown (peak ${r.peakDate} → trough ${r.troughDate}): ` +
    `peak=$${r.peakPrice.toFixed(2)} → trough=$${r.troughPrice.toFixed(2)} = -${r.drawdownPct.toFixed(1)}%, ` +
    `current=$${r.currentPrice.toFixed(2)}, ${r.daysSinceTrough}d since trough, rebound bars=${r.reboundBars}`
  );
}
