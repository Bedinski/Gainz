import { getRawSqlite } from '../db/client.js';
import type { AlpacaClient } from '../alpaca/client.js';
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
}

/**
 * Diff `positions_meta` against the broker's live position view. iter4 is
 * detect-only — the run produces an audit row + (when wired) an alert; humans
 * investigate. Auto-correction is deferred to iter5.
 *
 * Tolerances:
 *   - qty drift > RECONCILE_QTY_TOLERANCE → 'qty_drift'
 *   - notional delta > RECONCILE_NOTIONAL_TOLERANCE_USD → 'price_drift'
 *   - missing on either side → critical regardless of tolerances
 */
export async function reconcilePositions(
  alpaca: AlpacaClient,
  cfg: Config,
  now: Date = new Date(),
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

  return { runAt, mismatches, severity };
}
