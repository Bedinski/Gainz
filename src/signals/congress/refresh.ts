import { getRawSqlite } from '../../db/client.js';
import { loadConfig, type Config } from '../../trading/config.js';
import { logger } from '../../lib/logger.js';
import { hasCommitteeFit } from './committees.js';
import { getProvider, type RawCongressTrade } from './provider.js';

export async function refreshCongressTrades(opts?: { lookbackDays?: number }): Promise<{
  inserted: number;
  total: number;
  filtered: number;
}> {
  const cfg = loadConfig();
  const lookbackDays = opts?.lookbackDays ?? cfg.CONGRESS_LOOKBACK_DAYS * 2; // double on refresh
  const provider = await getProvider(cfg);

  logger.info({ provider: provider.name, lookbackDays }, 'refreshing congress trades');
  const rows = await provider.fetchRecent({ lookbackDays });
  const filtered = applyIngestionFilters(rows, cfg);
  const result = upsertTrades(filtered);
  recomputeBoosts(cfg);
  return { ...result, filtered: rows.length - filtered.length };
}

/**
 * Drops noise filings before upsert:
 *   - filer_is_politician === false  (spouse / blind trust / advisor)
 *   - amount_max_usd < CONGRESS_MIN_AMOUNT_USD
 *   - transaction older than CONGRESS_MAX_AGE_DAYS
 *
 * Removes ~85-95% of raw STOCK Act feeds. Filings dropped here never reach the
 * DB or the prompt — they're treated as noise upstream.
 */
export function applyIngestionFilters(
  rows: RawCongressTrade[],
  cfg: Config,
): RawCongressTrade[] {
  const cutoff = isoDate(new Date(Date.now() - cfg.CONGRESS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000));
  return rows.filter((r) => {
    if (cfg.CONGRESS_REQUIRE_OWN_TRADE && r.filerIsPolitician === false) return false;
    if ((r.amountMaxUsd ?? 0) < cfg.CONGRESS_MIN_AMOUNT_USD) return false;
    if (r.transactionDate < cutoff) return false;
    return true;
  });
}

export function upsertTrades(rows: RawCongressTrade[]): { inserted: number; total: number } {
  const db = getRawSqlite();
  const stmt = db.prepare(
    `INSERT INTO congress_trades (
       source, source_id, filer_name, filer_chamber, filer_party, filer_state, filer_committees,
       filer_is_politician,
       symbol, transaction_type, transaction_date, disclosure_date,
       amount_min_usd, amount_max_usd, committee_fit_boost, cluster_size,
       raw_json, fetched_at
     ) VALUES (
       @source, @source_id, @filer_name, @filer_chamber, @filer_party, @filer_state, @filer_committees,
       @filer_is_politician,
       @symbol, @transaction_type, @transaction_date, @disclosure_date,
       @amount_min_usd, @amount_max_usd, @committee_fit_boost, @cluster_size,
       @raw_json, @fetched_at
     )
     ON CONFLICT(source, source_id) DO NOTHING`,
  );
  let inserted = 0;
  const tx = db.transaction((batch: RawCongressTrade[]) => {
    for (const r of batch) {
      const fit = hasCommitteeFit(r.symbol, r.filerCommittees) ? 1 : 0;
      const result = stmt.run({
        source: r.source,
        source_id: r.sourceId,
        filer_name: r.filerName,
        filer_chamber: r.filerChamber ?? null,
        filer_party: r.filerParty ?? null,
        filer_state: r.filerState ?? null,
        filer_committees: r.filerCommittees ? JSON.stringify(r.filerCommittees) : null,
        filer_is_politician: r.filerIsPolitician === false ? 0 : 1,
        symbol: r.symbol,
        transaction_type: r.transactionType,
        transaction_date: r.transactionDate,
        disclosure_date: r.disclosureDate ?? null,
        amount_min_usd: r.amountMinUsd ?? null,
        amount_max_usd: r.amountMaxUsd ?? null,
        committee_fit_boost: fit,
        cluster_size: 1,
        raw_json: JSON.stringify(r.raw),
        fetched_at: Date.now(),
      });
      if (result.changes > 0) inserted++;
    }
  });
  tx(rows);
  return { inserted, total: rows.length };
}

/**
 * Computes cluster_size for every row: count of distinct filers buying the
 * same symbol within CLUSTER_WINDOW_DAYS of this trade's transaction_date.
 * Run after upsert so newly inserted rows pick up boosts from their neighbors.
 */
export function recomputeBoosts(cfg: Config): void {
  const db = getRawSqlite();
  const window = cfg.CLUSTER_WINDOW_DAYS;
  // Compute cluster sizes for `buy` trades only — selling clusters mean
  // something different and are out of scope for the boost.
  db.exec(`
    UPDATE congress_trades AS ct
    SET cluster_size = (
      SELECT COUNT(DISTINCT other.filer_name)
      FROM congress_trades AS other
      WHERE other.symbol = ct.symbol
        AND other.transaction_type = 'buy'
        AND ABS(julianday(other.transaction_date) - julianday(ct.transaction_date)) <= ${window}
        AND COALESCE(other.filer_is_politician, 1) = 1
    )
    WHERE ct.transaction_type = 'buy'
      AND COALESCE(ct.filer_is_politician, 1) = 1;
  `);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
