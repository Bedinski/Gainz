import { getRawSqlite } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import type { Config } from '../../trading/config.js';
import type { AlpacaClient } from '../../alpaca/client.js';
import type { MarketSnapshot } from '../../trading/types.js';

export interface DipExitDecision {
  symbol: string;
  reason: 'target_hit' | 'time_expiry';
  qty: number;
  entryPrice: number;
  exitPrice: number;
  pnlUsd: number;
  pnlPct: number;
  dipEventId: number;
}

interface DipPositionRow {
  symbol: string;
  entry_price: number;
  qty: number;
  target_price: number | null;
  time_exit_at: number | null;
  dip_event_id: number | null;
  current_stop_alpaca_order_id: string | null;
}

/**
 * Per-cycle: scan dip-recovery positions, fire deterministic exits.
 *   - target_price hit (currentPrice >= target)
 *   - time_exit_at expired (now >= deadline)
 *
 * Pure deterministic logic — no Claude reasoning, no debate. Returns the list
 * of exits actually fired so the caller can log/aggregate.
 */
export async function runDipExits(
  alpaca: AlpacaClient,
  cfg: Config,
  market: MarketSnapshot,
  now: Date,
): Promise<DipExitDecision[]> {
  const db = getRawSqlite();
  const rows = db
    .prepare(
      `SELECT symbol, entry_price, qty, target_price, time_exit_at, dip_event_id, current_stop_alpaca_order_id
       FROM positions_meta
       WHERE strategy_tag = 'dip_recovery'`,
    )
    .all() as DipPositionRow[];

  const decisions: DipExitDecision[] = [];
  const today = now.toISOString().slice(0, 10);

  for (const r of rows) {
    if (r.qty <= 0 || r.dip_event_id === null) continue;
    const snap = market[r.symbol];
    if (!snap) continue;

    const targetHit = r.target_price !== null && snap.latestPrice >= r.target_price;
    const timeExpired = r.time_exit_at !== null && now.getTime() >= r.time_exit_at;
    if (!targetHit && !timeExpired) continue;

    const reason: DipExitDecision['reason'] = targetHit ? 'target_hit' : 'time_expiry';
    const exitPrice = snap.latestPrice;
    const pnlUsd = (exitPrice - r.entry_price) * r.qty;
    const pnlPct = r.entry_price > 0 ? ((exitPrice - r.entry_price) / r.entry_price) * 100 : 0;

    if (cfg.SAFE_MODE) {
      logger.info(
        { symbol: r.symbol, reason, exitPrice, pnlUsd: pnlUsd.toFixed(2) },
        'SAFE_MODE: would exit dip position',
      );
    } else {
      try {
        if (r.current_stop_alpaca_order_id) {
          await alpaca.cancelOrder(r.current_stop_alpaca_order_id).catch((e) =>
            logger.warn({ err: String(e) }, 'cancel stop on dip exit failed'),
          );
        }
        await alpaca.submitMarket({ symbol: r.symbol, side: 'sell', qty: r.qty });
      } catch (err) {
        logger.error({ err: String(err), symbol: r.symbol }, 'dip exit market sell failed');
        continue;
      }
    }

    // Update DB state. Even in SAFE_MODE we update the dip_event row so the
    // dashboard reflects what would have happened; positions_meta stays so
    // the simulator can re-run. In live mode we delete positions_meta.
    db.prepare(
      `UPDATE dip_events SET status = ?, notes = ? WHERE id = ?`,
    ).run(
      reason === 'target_hit' ? 'recovered' : 'expired',
      `exit ${reason} @ $${exitPrice.toFixed(2)}, pnl=$${pnlUsd.toFixed(2)} (${pnlPct.toFixed(2)}%)`,
      r.dip_event_id,
    );

    if (!cfg.SAFE_MODE) {
      db.prepare('DELETE FROM positions_meta WHERE symbol = ?').run(r.symbol);
    }

    db.prepare(
      `UPDATE daily_state
       SET dip_realized_pnl = dip_realized_pnl + ?,
           realized_pnl     = realized_pnl     + ?
       WHERE date = ?`,
    ).run(pnlUsd, pnlUsd, today);

    decisions.push({
      symbol: r.symbol,
      reason,
      qty: r.qty,
      entryPrice: r.entry_price,
      exitPrice,
      pnlUsd,
      pnlPct,
      dipEventId: r.dip_event_id,
    });
  }

  return decisions;
}
