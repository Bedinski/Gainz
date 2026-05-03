import { getRawSqlite } from '../../db/client.js';
import type { CongressSignals, CongressTradeSignal } from '../../trading/types.js';

interface Row {
  symbol: string;
  filer_name: string;
  filer_chamber: 'senate' | 'house' | null;
  filer_party: string | null;
  filer_state: string | null;
  filer_committees: string | null;
  transaction_type: 'buy' | 'sell' | 'exchange';
  transaction_date: string;
  disclosure_date: string | null;
  amount_min_usd: number | null;
  amount_max_usd: number | null;
}

export function loadCongressSignals(symbols: string[], lookbackDays: number): CongressSignals {
  if (symbols.length === 0) return {};
  const cutoff = isoDate(new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000));
  const db = getRawSqlite();
  const placeholders = symbols.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT symbol, filer_name, filer_chamber, filer_party, filer_state, filer_committees,
              transaction_type, transaction_date, disclosure_date, amount_min_usd, amount_max_usd
       FROM congress_trades
       WHERE symbol IN (${placeholders})
         AND transaction_date >= ?
       ORDER BY transaction_date DESC`,
    )
    .all(...symbols.map((s) => s.toUpperCase()), cutoff) as Row[];

  const out: CongressSignals = {};
  for (const sym of symbols) out[sym.toUpperCase()] = [];
  for (const r of rows) {
    const sig: CongressTradeSignal = {
      symbol: r.symbol,
      filerName: r.filer_name,
      filerChamber: r.filer_chamber ?? undefined,
      filerParty: r.filer_party ?? undefined,
      filerState: r.filer_state ?? undefined,
      filerCommittees: r.filer_committees ? safeJson(r.filer_committees) : undefined,
      transactionType: r.transaction_type,
      transactionDate: r.transaction_date,
      disclosureDate: r.disclosure_date ?? undefined,
      amountMinUsd: r.amount_min_usd ?? undefined,
      amountMaxUsd: r.amount_max_usd ?? undefined,
    };
    out[r.symbol]!.push(sig);
  }
  return out;
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function safeJson(s: string): string[] | undefined {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
