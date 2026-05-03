import { getRawSqlite } from '../../db/client.js';
import { loadConfig } from '../../trading/config.js';
import { logger } from '../../lib/logger.js';
import { getProvider, type RawCongressTrade } from './provider.js';

export async function refreshCongressTrades(opts?: { lookbackDays?: number }): Promise<{ inserted: number; total: number }> {
  const cfg = loadConfig();
  const lookbackDays = opts?.lookbackDays ?? cfg.CONGRESS_LOOKBACK_DAYS * 2; // double on refresh
  const provider = await getProvider(cfg);

  logger.info({ provider: provider.name, lookbackDays }, 'refreshing congress trades');
  const rows = await provider.fetchRecent({ lookbackDays });
  return upsertTrades(rows);
}

export function upsertTrades(rows: RawCongressTrade[]): { inserted: number; total: number } {
  const db = getRawSqlite();
  const stmt = db.prepare(
    `INSERT INTO congress_trades (
       source, source_id, filer_name, filer_chamber, filer_party, filer_state, filer_committees,
       symbol, transaction_type, transaction_date, disclosure_date,
       amount_min_usd, amount_max_usd, raw_json, fetched_at
     ) VALUES (
       @source, @source_id, @filer_name, @filer_chamber, @filer_party, @filer_state, @filer_committees,
       @symbol, @transaction_type, @transaction_date, @disclosure_date,
       @amount_min_usd, @amount_max_usd, @raw_json, @fetched_at
     )
     ON CONFLICT(source, source_id) DO NOTHING`,
  );
  let inserted = 0;
  const tx = db.transaction((batch: RawCongressTrade[]) => {
    for (const r of batch) {
      const result = stmt.run({
        source: r.source,
        source_id: r.sourceId,
        filer_name: r.filerName,
        filer_chamber: r.filerChamber ?? null,
        filer_party: r.filerParty ?? null,
        filer_state: r.filerState ?? null,
        filer_committees: r.filerCommittees ? JSON.stringify(r.filerCommittees) : null,
        symbol: r.symbol,
        transaction_type: r.transactionType,
        transaction_date: r.transactionDate,
        disclosure_date: r.disclosureDate ?? null,
        amount_min_usd: r.amountMinUsd ?? null,
        amount_max_usd: r.amountMaxUsd ?? null,
        raw_json: JSON.stringify(r.raw),
        fetched_at: Date.now(),
      });
      if (result.changes > 0) inserted++;
    }
  });
  tx(rows);
  return { inserted, total: rows.length };
}
