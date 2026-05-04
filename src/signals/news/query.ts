import { getRawSqlite } from '../../db/client.js';
import { loadConfig, type Config } from '../../trading/config.js';
import type { NewsSignalItem, NewsSignals } from '../../trading/types.js';

interface Row {
  symbol: string;
  source_id: string;
  headline: string;
  summary: string | null;
  url: string | null;
  source: string;
  category: NewsSignalItem['category'];
  published_at: number;
}

/**
 * Returns recent news items per symbol, filtered to allowed categories and
 * capped per symbol. Reads from the news_items cache; never touches the wire.
 *
 * `requireClassified` (default true) excludes rows still tagged 'unclassified'
 * — those reach the prompt only after the Haiku tagger has labelled them.
 */
export function loadNewsSignals(
  symbols: string[],
  opts: {
    lookbackHours?: number;
    maxPerSymbol?: number;
    allowedCategories?: string[];
    requireClassified?: boolean;
  } = {},
  cfg: Config = loadConfig(),
): NewsSignals {
  const out: NewsSignals = {};
  for (const s of symbols) out[s.toUpperCase()] = [];
  if (symbols.length === 0) return out;

  const lookbackHours = opts.lookbackHours ?? cfg.NEWS_LOOKBACK_HOURS;
  const maxPerSymbol = opts.maxPerSymbol ?? cfg.NEWS_MAX_ITEMS_PER_SYMBOL;
  const allowed = (opts.allowedCategories ?? cfg.NEWS_CATEGORIES_ALLOWED).map((c) => c.toLowerCase());
  const requireClassified = opts.requireClassified ?? true;
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;

  const db = getRawSqlite();
  const placeholders = symbols.map(() => '?').join(',');
  const catPlaceholders = allowed.map(() => '?').join(',');
  const classifiedClause = requireClassified ? "AND category != 'unclassified'" : '';
  const sql = `SELECT symbol, source_id, headline, summary, url, source, category, published_at
               FROM news_items
               WHERE symbol IN (${placeholders})
                 AND published_at >= ?
                 ${classifiedClause}
                 ${allowed.length ? `AND category IN (${catPlaceholders})` : ''}
               ORDER BY symbol ASC, published_at DESC`;

  const params = [...symbols.map((s) => s.toUpperCase()), cutoff];
  if (allowed.length) params.push(...allowed);
  const rows = db.prepare(sql).all(...params) as Row[];

  // Cap per-symbol while preserving the desc-by-date order.
  const counts = new Map<string, number>();
  for (const r of rows) {
    const cur = counts.get(r.symbol) ?? 0;
    if (cur >= maxPerSymbol) continue;
    counts.set(r.symbol, cur + 1);
    out[r.symbol]!.push({
      symbol: r.symbol,
      headline: r.headline,
      summary: r.summary ?? undefined,
      url: r.url ?? undefined,
      source: r.source,
      category: r.category,
      publishedAt: r.published_at,
    });
  }
  return out;
}
