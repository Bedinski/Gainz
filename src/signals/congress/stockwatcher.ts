import type { CongressSignalProvider, RawCongressTrade } from './provider.js';

const SENATE_FEED = 'https://senatestockwatcher.com/api/v1/all_transactions';
const HOUSE_FEED = 'https://housestockwatcher.com/api/v1/all_transactions';

interface SwRow {
  transaction_date: string;
  disclosure_date?: string;
  ticker?: string;
  asset_description?: string;
  type?: string;
  amount?: string;
  representative?: string;
  senator?: string;
  party?: string;
  state?: string;
  ptr_link?: string;
  district?: string;
}

export class StockWatcherProvider implements CongressSignalProvider {
  readonly name = 'stockwatcher' as const;

  async fetchRecent({ lookbackDays }: { lookbackDays: number }): Promise<RawCongressTrade[]> {
    const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    const [senate, house] = await Promise.all([this.fetchOne(SENATE_FEED, 'senate'), this.fetchOne(HOUSE_FEED, 'house')]);
    return [...senate, ...house].filter((t) => new Date(t.transactionDate) >= cutoff);
  }

  private async fetchOne(url: string, chamber: 'senate' | 'house'): Promise<RawCongressTrade[]> {
    let rows: SwRow[];
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'gainz-bot/0.1' } });
      if (!res.ok) return [];
      rows = (await res.json()) as SwRow[];
    } catch {
      return [];
    }
    if (!Array.isArray(rows)) return [];

    const out: RawCongressTrade[] = [];
    for (const r of rows) {
      const symbol = (r.ticker ?? '').trim().toUpperCase();
      if (!symbol || symbol === '--' || symbol.length > 8) continue;
      const txType = mapType(r.type);
      if (!txType) continue;
      const filerName = (chamber === 'senate' ? r.senator : r.representative) ?? 'unknown';
      const { min, max } = parseAmount(r.amount);
      out.push({
        source: 'stockwatcher',
        sourceId: `${chamber}:${r.transaction_date}:${filerName}:${symbol}:${r.amount ?? ''}`,
        filerName,
        filerChamber: chamber,
        filerParty: r.party,
        filerState: r.state,
        symbol,
        transactionType: txType,
        transactionDate: r.transaction_date,
        disclosureDate: r.disclosure_date,
        amountMinUsd: min,
        amountMaxUsd: max,
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

function parseAmount(s: string | undefined): { min?: number; max?: number } {
  if (!s) return {};
  const cleaned = s.replace(/[$,]/g, '').trim();
  const parts = cleaned.split(/\s*-\s*/);
  if (parts.length === 2) {
    const min = Number(parts[0]);
    const max = Number(parts[1]);
    if (!Number.isNaN(min) && !Number.isNaN(max)) return { min, max };
  }
  const single = Number(cleaned);
  if (!Number.isNaN(single)) return { min: single, max: single };
  return {};
}
