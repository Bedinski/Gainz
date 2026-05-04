import { describe, it, expect, beforeEach } from 'vitest';
import { applySchema } from '../src/db/migrate.js';
import { closeDb, getDb, getRawSqlite } from '../src/db/client.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import { upsertNewsItems, classifyUnclassified } from '../src/signals/news/alpaca.js';
import { loadNewsSignals } from '../src/signals/news/query.js';
import { heuristicClassify, setHeadlineClassifier } from '../src/signals/news/classify.js';

const env = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'AAPL,NVDA,PLTR',
  NEWS_LOOKBACK_HOURS: '24',
  NEWS_MAX_ITEMS_PER_SYMBOL: '3',
  NEWS_CATEGORIES_ALLOWED: 'earnings,guidance,m_and_a,regulatory,exec_change',
  NEWS_CLASSIFIER_MODEL: 'claude-haiku-4-5-20251001',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  closeDb();
  clearConfigCacheForTests();
  getDb(':memory:');
  applySchema();
  setHeadlineClassifier(null);
});

describe('news heuristic classifier', () => {
  it('tags earnings beats correctly', () => {
    expect(heuristicClassify({ headline: 'Apple beats Q2 estimates, raises guidance' })).toBe('earnings');
  });
  it('tags guidance changes', () => {
    expect(heuristicClassify({ headline: 'Cisco raises full-year outlook' })).toBe('guidance');
  });
  it('tags M&A activity', () => {
    expect(heuristicClassify({ headline: 'Microsoft to buy small AI startup for $2B' })).toBe('m_and_a');
  });
  it('tags regulatory news', () => {
    expect(heuristicClassify({ headline: 'SEC investigation into Tesla disclosure practices' })).toBe('regulatory');
  });
  it('tags political_shock for tariff headlines (BEFORE regulatory)', () => {
    expect(heuristicClassify({ headline: 'White House announces 25% tariff on EU autos' })).toBe('political_shock');
  });
  it('tags political_shock for executive orders', () => {
    expect(heuristicClassify({ headline: 'Trump signs executive order pausing China tariffs' })).toBe('political_shock');
  });
  it('tags political_shock for sanctions', () => {
    expect(heuristicClassify({ headline: 'Treasury imposes new sanctions on Russian banks' })).toBe('political_shock');
  });
  it('tags political_shock for FOMC / rate decisions', () => {
    expect(heuristicClassify({ headline: 'FOMC holds rates steady; rate decision dovish' })).toBe('political_shock');
  });
  it('tags executive changes', () => {
    expect(heuristicClassify({ headline: 'Acme appoints new CEO after sudden resignation' })).toBe('exec_change');
  });
  it('tags analyst notes', () => {
    expect(heuristicClassify({ headline: 'Goldman raises NVDA price target to $200' })).toBe('analyst');
  });
  it('defaults noisy headlines to other', () => {
    expect(heuristicClassify({ headline: 'Some unrelated thing happened today' })).toBe('other');
  });
});

describe('news upsert + query', () => {
  it('inserts only allowlisted symbols and dedupes on (sourceId, symbol)', () => {
    loadConfig(env);
    const articles = [
      { id: 1, headline: 'Apple beats Q2 estimates', symbols: ['AAPL'], created_at: new Date().toISOString() },
      // duplicate
      { id: 1, headline: 'Apple beats Q2 estimates', symbols: ['AAPL'], created_at: new Date().toISOString() },
      // not in allowlist scope (caller can choose to include / exclude based on scope)
      { id: 2, headline: 'IBM acquires startup', symbols: ['IBM'], created_at: new Date().toISOString() },
    ];
    const inserted = upsertNewsItems(articles, ['AAPL', 'NVDA', 'PLTR']);
    expect(inserted).toBe(1);
  });

  it('loadNewsSignals filters out unclassified rows by default', () => {
    loadConfig(env);
    const now = Date.now();
    const articles = [
      { id: 10, headline: 'Apple beats Q2 estimates, raises guidance', symbols: ['AAPL'], created_at: new Date(now - 60_000).toISOString() },
    ];
    upsertNewsItems(articles, ['AAPL']);
    // not classified yet → loadNewsSignals returns empty
    const before = loadNewsSignals(['AAPL']);
    expect(before.AAPL).toHaveLength(0);
  });

  it('loadNewsSignals returns classified rows with allowed categories', async () => {
    const cfg = loadConfig(env);
    const now = Date.now();
    const articles = [
      { id: 11, headline: 'Apple beats Q2 estimates, raises guidance', symbols: ['AAPL'], created_at: new Date(now - 60_000).toISOString() },
      { id: 12, headline: 'Goldman raises NVDA price target to $200', symbols: ['NVDA'], created_at: new Date(now - 60_000).toISOString() },
    ];
    upsertNewsItems(articles, ['AAPL', 'NVDA']);

    // Inject the heuristic so the test runs with no network.
    setHeadlineClassifier({ classify: async (i) => heuristicClassify(i) });
    await classifyUnclassified(cfg);

    const out = loadNewsSignals(['AAPL', 'NVDA']);
    expect(out.AAPL?.[0]?.category).toBe('earnings');
    // 'analyst' is NOT in NEWS_CATEGORIES_ALLOWED → filtered out
    expect(out.NVDA).toHaveLength(0);
  });

  it('respects NEWS_MAX_ITEMS_PER_SYMBOL cap', () => {
    loadConfig(env);
    const now = Date.now();
    const db = getRawSqlite();
    const insert = db.prepare(
      `INSERT INTO news_items (source_id, symbol, headline, source, category, published_at, fetched_at, classified_at)
       VALUES (?, 'PLTR', ?, 'Benzinga', 'earnings', ?, ?, ?)`,
    );
    for (let i = 0; i < 6; i++) {
      insert.run(`x${i}`, `headline ${i}`, now - i * 1000, now, now);
    }
    const out = loadNewsSignals(['PLTR']);
    expect(out.PLTR).toHaveLength(3);
  });
});
