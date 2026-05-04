import { resolveCredentials } from '../../alpaca/client.js';
import { loadConfig, type Config } from '../../trading/config.js';
import { getRawSqlite } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { classifyHeadline, type NewsCategory } from './classify.js';

/**
 * Raw shape returned by Alpaca's News REST endpoint.
 * https://data.alpaca.markets/v1beta1/news
 */
interface AlpacaNewsArticle {
  id: number | string;
  headline: string;
  summary?: string;
  author?: string;
  url?: string;
  source?: string;
  symbols?: string[];
  created_at?: string;
  updated_at?: string;
}

interface AlpacaNewsResponse {
  news: AlpacaNewsArticle[];
  next_page_token?: string;
}

/**
 * Fetches recent news for the given symbols from Alpaca's News REST endpoint.
 * Returns the raw articles. Caller is responsible for upsert + classification.
 */
export async function fetchAlpacaNews(
  symbols: string[],
  opts: { lookbackHours?: number; limit?: number } = {},
  cfg: Config = loadConfig(),
): Promise<AlpacaNewsArticle[]> {
  if (symbols.length === 0) return [];
  const lookbackHours = opts.lookbackHours ?? cfg.NEWS_LOOKBACK_HOURS;
  const limit = opts.limit ?? 50;
  const start = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const creds = resolveCredentials(cfg);
  const headers = {
    'APCA-API-KEY-ID': creds.keyId,
    'APCA-API-SECRET-KEY': creds.secretKey,
  };
  const params = new URLSearchParams({
    symbols: symbols.join(','),
    start,
    limit: String(limit),
    sort: 'desc',
  });
  const url = `${creds.dataBaseUrl}/v1beta1/news?${params}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca News GET ${url} ${res.status}: ${body}`);
  }
  const data = (await res.json()) as AlpacaNewsResponse;
  return data.news ?? [];
}

/**
 * Refresh + upsert + classify pipeline. Pulls last N hours of news for the
 * allowlist, upserts fresh rows, classifies any newly-inserted rows with the
 * Haiku tagger, and writes the resulting category back.
 *
 * Returns counts useful for logging / dashboard.
 */
export async function refreshAlpacaNews(opts?: {
  symbols?: string[];
  lookbackHours?: number;
}): Promise<{ fetched: number; inserted: number; classified: number }> {
  const cfg = loadConfig();
  if (!cfg.ALPACA_NEWS_ENABLED) {
    return { fetched: 0, inserted: 0, classified: 0 };
  }
  const symbols = opts?.symbols ?? cfg.SYMBOL_ALLOWLIST;
  const lookbackHours = opts?.lookbackHours ?? cfg.NEWS_LOOKBACK_HOURS;
  const articles = await fetchAlpacaNews(symbols, { lookbackHours }, cfg);
  const inserted = upsertNewsItems(articles, symbols);
  const classified = await classifyUnclassified(cfg);
  return { fetched: articles.length, inserted, classified };
}

/**
 * Upserts (sourceId, symbol) tuples from the article list. Each article may
 * mention multiple symbols; we fan out so the (symbol, published_at) index
 * is useful per-ticker.
 */
export function upsertNewsItems(
  articles: AlpacaNewsArticle[],
  symbolsScope: string[],
): number {
  if (articles.length === 0) return 0;
  const db = getRawSqlite();
  const stmt = db.prepare(
    `INSERT INTO news_items (
       source_id, symbol, headline, summary, url, source, category, published_at, fetched_at, classified_at
     ) VALUES (
       @source_id, @symbol, @headline, @summary, @url, @source, 'unclassified', @published_at, @fetched_at, NULL
     )
     ON CONFLICT(source_id, symbol) DO NOTHING`,
  );
  let inserted = 0;
  const now = Date.now();
  const inScope = new Set(symbolsScope.map((s) => s.toUpperCase()));
  const tx = db.transaction((batch: AlpacaNewsArticle[]) => {
    for (const a of batch) {
      const tickers = (a.symbols ?? []).filter((s) => inScope.has(s.toUpperCase()));
      const publishedAt = a.created_at ? Date.parse(a.created_at) : now;
      if (Number.isNaN(publishedAt)) continue;
      for (const symbol of tickers) {
        const result = stmt.run({
          source_id: String(a.id),
          symbol: symbol.toUpperCase(),
          headline: a.headline,
          summary: a.summary ?? null,
          url: a.url ?? null,
          source: a.source ?? a.author ?? 'alpaca',
          published_at: publishedAt,
          fetched_at: now,
        });
        if (result.changes > 0) inserted++;
      }
    }
  });
  tx(articles);
  return inserted;
}

/**
 * Classifies all unclassified news rows with the Haiku tagger and writes the
 * category back. Bounded by `limit` to keep cycle cost predictable.
 */
export async function classifyUnclassified(cfg: Config, limit = 50): Promise<number> {
  const db = getRawSqlite();
  const rows = db
    .prepare(
      `SELECT id, headline, summary FROM news_items
       WHERE category = 'unclassified'
       ORDER BY published_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: number; headline: string; summary: string | null }>;
  if (rows.length === 0) return 0;
  const update = db.prepare(
    `UPDATE news_items SET category = ?, classified_at = ? WHERE id = ?`,
  );
  let classified = 0;
  for (const r of rows) {
    let category: NewsCategory = 'other';
    try {
      category = await classifyHeadline({ headline: r.headline, summary: r.summary ?? undefined }, cfg);
    } catch (err) {
      logger.warn({ err: String(err), id: r.id }, 'news classification failed; defaulting to other');
    }
    update.run(category, Date.now(), r.id);
    classified++;
  }
  return classified;
}
