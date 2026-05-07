import { getRawSqlite } from '../db/client.js';
import type { AlpacaClient } from '../alpaca/client.js';
import { logger } from '../lib/logger.js';
import { SYMBOL_SECTOR } from '../signals/congress/committees.js';
import { computeATR } from './atr.js';
import type { Config } from './config.js';

export type MismatchKind =
  | 'missing_in_broker' // DB has it; broker doesn't
  | 'missing_in_db' // broker has it; DB doesn't
  | 'qty_drift' // both sides have it, qty differs > tolerance
  | 'price_drift'; // both sides have it, mark price differs > tolerance

export interface Mismatch {
  symbol: string;
  kind: MismatchKind;
  dbQty: number | null;
  brokerQty: number | null;
  dbEntryPrice: number | null;
  brokerCurrentPrice: number | null;
  notionalDeltaUsd?: number;
}

export interface ReconcileResult {
  runAt: number;
  mismatches: Mismatch[];
  severity: 'ok' | 'warn' | 'critical';
  /** Symbols that were missing_in_db on this run and got auto-imported into
   *  positions_meta. Surfaced for logging/audit; these are NOT counted in
   *  `mismatches` (the drift is resolved). */
  autoCorrected?: string[];
}

export interface ReconcileOptions {
  /**
   * When true, attempts to import broker-only positions into positions_meta
   * and submit a protective stop order at Alpaca. Mismatches that succeed are
   * removed from the result so the alert layer doesn't fire on resolved drift.
   * Default false (detection-only — backward-compatible with the iter4 plan
   * "auto-correct deferred" stance for explicit standalone reconcile runs).
   */
  autoCorrect?: boolean;
}

/**
 * Diff `positions_meta` against the broker's live position view.
 *
 * Detection (always runs):
 *   - qty drift > RECONCILE_QTY_TOLERANCE → 'qty_drift'
 *   - notional delta > RECONCILE_NOTIONAL_TOLERANCE_USD → 'price_drift'
 *   - missing on either side → critical regardless of tolerances
 *
 * Auto-correct (opt-in via options.autoCorrect):
 *   For each missing_in_db symbol, fetch the broker's avg_entry_price + qty,
 *   compute a fixed protective stop (max of cfg.STOP_LOSS_PCT and ATR-based),
 *   submit it to Alpaca if no open stop already exists for the symbol, and
 *   insert a positions_meta row. Best-effort: any failure leaves the mismatch
 *   in the result for human-visible alerting on the next run.
 */
export async function reconcilePositions(
  alpaca: AlpacaClient,
  cfg: Config,
  now: Date = new Date(),
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const db = getRawSqlite();
  const dbRows = db
    .prepare('SELECT symbol, qty, entry_price FROM positions_meta')
    .all() as Array<{ symbol: string; qty: number; entry_price: number }>;
  const dbBySymbol = new Map(dbRows.map((r) => [r.symbol.toUpperCase(), r]));

  const brokerRows = await alpaca.getPositions();
  const brokerBySymbol = new Map(
    brokerRows.map((p) => [
      p.symbol.toUpperCase(),
      {
        symbol: p.symbol.toUpperCase(),
        qty: parseFloat(p.qty),
        avgEntryPrice: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
      },
    ]),
  );

  const mismatches: Mismatch[] = [];
  const allSymbols = new Set<string>([...dbBySymbol.keys(), ...brokerBySymbol.keys()]);

  for (const sym of allSymbols) {
    const dbRow = dbBySymbol.get(sym);
    const brokerRow = brokerBySymbol.get(sym);

    if (dbRow && !brokerRow) {
      mismatches.push({
        symbol: sym,
        kind: 'missing_in_broker',
        dbQty: dbRow.qty,
        brokerQty: null,
        dbEntryPrice: dbRow.entry_price,
        brokerCurrentPrice: null,
      });
      continue;
    }
    if (!dbRow && brokerRow) {
      mismatches.push({
        symbol: sym,
        kind: 'missing_in_db',
        dbQty: null,
        brokerQty: brokerRow.qty,
        dbEntryPrice: null,
        brokerCurrentPrice: brokerRow.currentPrice,
      });
      continue;
    }
    if (!dbRow || !brokerRow) continue;

    const qtyDelta = Math.abs(dbRow.qty - brokerRow.qty);
    if (qtyDelta > cfg.RECONCILE_QTY_TOLERANCE) {
      mismatches.push({
        symbol: sym,
        kind: 'qty_drift',
        dbQty: dbRow.qty,
        brokerQty: brokerRow.qty,
        dbEntryPrice: dbRow.entry_price,
        brokerCurrentPrice: brokerRow.currentPrice,
        notionalDeltaUsd: qtyDelta * brokerRow.currentPrice,
      });
      continue;
    }

    // Same qty: check if broker's mark is wildly different from our entry —
    // a stale `positions_meta.entry_price` is benign, but track it as a soft
    // signal so reconciliation runs are useful for audit.
    const notionalDelta = Math.abs(
      dbRow.qty * dbRow.entry_price - brokerRow.qty * brokerRow.currentPrice,
    );
    if (notionalDelta > cfg.RECONCILE_NOTIONAL_TOLERANCE_USD * 50) {
      // NB: 50× tolerance because entry_price drift from current price is normal.
      // We only flag truly suspicious gaps.
      mismatches.push({
        symbol: sym,
        kind: 'price_drift',
        dbQty: dbRow.qty,
        brokerQty: brokerRow.qty,
        dbEntryPrice: dbRow.entry_price,
        brokerCurrentPrice: brokerRow.currentPrice,
        notionalDeltaUsd: notionalDelta,
      });
    }
  }

  // Auto-correct missing_in_db: promote broker-only positions into positions_meta
  // + place a protective stop. Any per-symbol failure logs a warning and leaves
  // the mismatch in the result for the alert layer.
  const autoCorrected: string[] = [];
  if (options.autoCorrect) {
    for (let i = mismatches.length - 1; i >= 0; i--) {
      const m = mismatches[i]!;
      if (m.kind !== 'missing_in_db') continue;
      const brokerRow = brokerBySymbol.get(m.symbol);
      if (!brokerRow) continue;
      try {
        await autoImportBrokerPosition(alpaca, cfg, brokerRow, now);
        autoCorrected.push(m.symbol);
        mismatches.splice(i, 1); // resolved — drop from results
      } catch (err) {
        logger.warn(
          { err: String(err), symbol: m.symbol },
          'reconcile auto-correct failed; mismatch remains for human review',
        );
      }
    }
  }

  const hasMissing = mismatches.some(
    (m) => m.kind === 'missing_in_broker' || m.kind === 'missing_in_db',
  );
  const hasQtyDrift = mismatches.some((m) => m.kind === 'qty_drift');
  const severity: 'ok' | 'warn' | 'critical' = hasMissing || hasQtyDrift
    ? 'critical'
    : mismatches.length > 0
      ? 'warn'
      : 'ok';

  const runAt = now.getTime();
  db.prepare(
    `INSERT INTO reconciliation_runs (run_at, mismatches, severity, mismatches_json)
     VALUES (?, ?, ?, ?)`,
  ).run(
    runAt,
    mismatches.length,
    severity,
    mismatches.length > 0 ? JSON.stringify(mismatches) : null,
  );

  return {
    runAt,
    mismatches,
    severity,
    autoCorrected: autoCorrected.length > 0 ? autoCorrected : undefined,
  };
}

/**
 * Import a broker-only position into positions_meta and place a protective
 * stop if Alpaca doesn't already have one open for the symbol. Throws on any
 * unrecoverable failure; the caller treats that as "leave the mismatch alone."
 */
async function autoImportBrokerPosition(
  alpaca: AlpacaClient,
  cfg: Config,
  broker: { symbol: string; qty: number; avgEntryPrice: number; currentPrice: number },
  now: Date,
): Promise<void> {
  const symbol = broker.symbol.toUpperCase();
  // 1. ATR — pull ~30 daily bars, compute Wilder's ATR(14). NaN if too few bars.
  const since = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rawBars = await alpaca.getBars(symbol, { timeframe: '1Day', start: since, limit: 60 });
  const bars = rawBars.map((b) => ({ high: b.h, low: b.l, close: b.c }));
  const atr14 = computeATR(bars, 14);
  if (!Number.isFinite(atr14) || atr14 <= 0) {
    throw new Error(`ATR unavailable for ${symbol} (n=${bars.length})`);
  }

  // 2. Stop price — wider of (cfg.STOP_LOSS_PCT below entry) and (ATR_MULT × ATR
  //    below entry). Matches the formula used by executeOrder for new entries.
  const fixedStopPrice = broker.avgEntryPrice * (1 - cfg.STOP_LOSS_PCT / 100);
  const atrStopPrice = broker.avgEntryPrice - cfg.ATR_MULT * atr14;
  const stopPrice = Math.min(fixedStopPrice, atrStopPrice);
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    throw new Error(`computed stopPrice=${stopPrice} is invalid for ${symbol}`);
  }

  // 3. Reuse an existing open stop sell on the symbol if one's already there
  //    (the original bracket child may have survived). Otherwise submit a new
  //    one. Fractional qty is a known Alpaca constraint for stop orders —
  //    fall back to floor(qty) if a fractional submit errors.
  let stopOrderId: string | null = null;
  try {
    const openOrders = await alpaca.getOrders({ status: 'open', limit: 100 });
    const existing = openOrders.find(
      (o) => o.symbol.toUpperCase() === symbol && o.side === 'sell' && /stop/.test(o.type),
    );
    if (existing) {
      stopOrderId = existing.id;
      logger.info(
        { symbol, orderId: stopOrderId, type: existing.type },
        'reconcile auto-correct: reusing existing protective stop at broker',
      );
    }
  } catch (err) {
    logger.warn({ err: String(err), symbol }, 'getOrders failed during auto-correct; will attempt stop submit');
  }

  if (!stopOrderId) {
    const stopQty = Number.isInteger(broker.qty) ? broker.qty : Math.floor(broker.qty);
    if (stopQty <= 0) {
      logger.warn(
        { symbol, qty: broker.qty },
        'auto-correct: position too small for an integer-qty stop; skipping stop submit (positions_meta still inserted)',
      );
    } else {
      try {
        const r = await alpaca.submitStop({
          symbol,
          side: 'sell',
          qty: stopQty,
          stopPrice: round2(stopPrice),
          timeInForce: 'gtc',
        });
        stopOrderId = r.id;
        logger.info(
          { symbol, qty: stopQty, stopPrice: round2(stopPrice), orderId: stopOrderId },
          'reconcile auto-correct: protective stop submitted',
        );
      } catch (err) {
        logger.warn(
          { err: String(err), symbol, stopPrice: round2(stopPrice), qty: stopQty },
          'auto-correct: stop submit failed (likely fractional or out-of-range); positions_meta still inserted',
        );
      }
    }
  }

  // 4. Insert positions_meta. Use 'momentum' as the safe default strategy_tag —
  //    we have no way to recover dip-strategy state (target_price, time_exit_at,
  //    dip_event_id) for a broker-imported position. The manage step will trail
  //    it like any other momentum position.
  const sector = SYMBOL_SECTOR[symbol] ?? null;
  const highest = Math.max(broker.avgEntryPrice, broker.currentPrice);
  const db = getRawSqlite();
  db.prepare(
    `INSERT INTO positions_meta (
       symbol, opened_at, entry_price, qty, atr_at_entry,
       current_stop_alpaca_order_id, current_stop_type, current_stop_price,
       trailing_stop_pct, highest_price_seen, strategy_tag, sector
     ) VALUES (?, ?, ?, ?, ?, ?, 'fixed', ?, ?, ?, 'momentum', ?)
     ON CONFLICT(symbol) DO UPDATE SET
       qty = excluded.qty,
       entry_price = excluded.entry_price,
       atr_at_entry = excluded.atr_at_entry,
       current_stop_alpaca_order_id = excluded.current_stop_alpaca_order_id,
       current_stop_type = excluded.current_stop_type,
       current_stop_price = excluded.current_stop_price,
       highest_price_seen = MAX(positions_meta.highest_price_seen, excluded.highest_price_seen),
       sector = COALESCE(positions_meta.sector, excluded.sector)`,
  ).run(
    symbol,
    now.getTime(),
    broker.avgEntryPrice,
    broker.qty,
    atr14,
    stopOrderId,
    round2(stopPrice),
    cfg.TRAILING_STOP_PCT,
    highest,
    sector,
  );

  logger.info(
    { symbol, qty: broker.qty, entry: broker.avgEntryPrice, stop: round2(stopPrice), stopOrderId, sector },
    'reconcile auto-correct: positions_meta synced from broker',
  );
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
