import type { CongressSignalProvider, RawCongressTrade } from './provider.js';

interface QuiverRow {
  Representative?: string;
  Senator?: string;
  Party?: string;
  State?: string;
  Chamber?: string;
  Ticker?: string;
  Transaction?: string;
  TransactionDate?: string;
  ReportDate?: string;
  Range?: string;
  Amount?: number;
  House?: string;
}

export class QuiverProvider implements CongressSignalProvider {
  readonly name = 'quiver' as const;

  constructor(private readonly apiKey: string) {}

  async fetchRecent({ lookbackDays }: { lookbackDays: number }): Promise<RawCongressTrade[]> {
    const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    const url = 'https://api.quiverquant.com/beta/live/congresstrading';
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) throw new Error(`quiver ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as QuiverRow[];
    if (!Array.isArray(rows)) return [];

    const out: RawCongressTrade[] = [];
    for (const r of rows) {
      const symbol = (r.Ticker ?? '').trim().toUpperCase();
      if (!symbol || !r.TransactionDate) continue;
      const txType = mapType(r.Transaction);
      if (!txType) continue;
      const txDate = r.TransactionDate.slice(0, 10);
      if (new Date(txDate) < cutoff) continue;
      const chamber: 'senate' | 'house' | undefined =
        r.Chamber?.toLowerCase().includes('senate') ? 'senate' :
        r.Chamber?.toLowerCase().includes('house') ? 'house' : undefined;
      const filerName = r.Representative ?? r.Senator ?? 'unknown';
      const { min, max } = parseRange(r.Range);
      out.push({
        source: 'quiver',
        sourceId: `quiver:${txDate}:${filerName}:${symbol}:${r.Amount ?? r.Range ?? ''}`,
        filerName,
        filerChamber: chamber,
        filerParty: r.Party,
        filerState: r.State,
        symbol,
        transactionType: txType,
        transactionDate: txDate,
        disclosureDate: r.ReportDate?.slice(0, 10),
        amountMinUsd: min ?? r.Amount,
        amountMaxUsd: max ?? r.Amount,
        raw: r,
      });
    }
    return out;
  }
}

function mapType(t: string | undefined): 'buy' | 'sell' | 'exchange' | null {
  if (!t) return null;
  const s = t.toLowerCase();
  if (s.includes('purchase') || s === 'buy') return 'buy';
  if (s.includes('sale') || s === 'sell') return 'sell';
  if (s.includes('exchange')) return 'exchange';
  return null;
}

function parseRange(s: string | undefined): { min?: number; max?: number } {
  if (!s) return {};
  const cleaned = s.replace(/[$,]/g, '').trim();
  const parts = cleaned.split(/\s*-\s*/);
  if (parts.length === 2) {
    const min = Number(parts[0]);
    const max = Number(parts[1]);
    if (!Number.isNaN(min) && !Number.isNaN(max)) return { min, max };
  }
  return {};
}
