import { describe, it, expect, beforeEach } from 'vitest';
import { applySchema } from '../src/db/migrate.js';
import { closeDb, getDb, getRawSqlite } from '../src/db/client.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import { classifyUnclassified } from '../src/signals/news/alpaca.js';
import { setHeadlineClassifier } from '../src/signals/news/classify.js';

const env = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'AAPL',
  NEWS_LOOKBACK_HOURS: '24',
  NEWS_MAX_ITEMS_PER_SYMBOL: '5',
  NEWS_CATEGORIES_ALLOWED: 'earnings,guidance',
  NEWS_CLASSIFIER_MODEL: 'claude-haiku-4-5-20251001',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

function seedUnclassified(n: number) {
  const db = getRawSqlite();
  const stmt = db.prepare(
    `INSERT INTO news_items (source_id, symbol, headline, source, category, published_at, fetched_at, classified_at)
     VALUES (?, 'AAPL', ?, 'test', 'unclassified', ?, ?, NULL)`,
  );
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    stmt.run(`s${i}`, `headline ${i}`, now - i * 1000, now);
  }
}

beforeEach(() => {
  closeDb();
  clearConfigCacheForTests();
  getDb(':memory:');
  applySchema();
  setHeadlineClassifier(null);
});

describe('classifyUnclassified bounded concurrency', () => {
  it('classifies all rows even when running with parallel workers', async () => {
    const cfg = loadConfig(env);
    seedUnclassified(10);
    setHeadlineClassifier({ classify: async () => 'earnings' });
    const n = await classifyUnclassified(cfg, 50, 5);
    expect(n).toBe(10);
    const remaining = (
      getRawSqlite()
        .prepare("SELECT COUNT(*) AS c FROM news_items WHERE category = 'unclassified'")
        .get() as { c: number }
    ).c;
    expect(remaining).toBe(0);
  });

  it('honors the concurrency cap (never more than N classifications in flight)', async () => {
    const cfg = loadConfig(env);
    seedUnclassified(20);

    let inFlight = 0;
    let maxInFlight = 0;
    setHeadlineClassifier({
      classify: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return 'earnings';
      },
    });

    await classifyUnclassified(cfg, 50, 4);
    expect(maxInFlight).toBeGreaterThan(1); // it really is parallel
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it('still completes when individual classifications throw (defaults to other)', async () => {
    const cfg = loadConfig(env);
    seedUnclassified(6);
    let i = 0;
    setHeadlineClassifier({
      classify: async () => {
        if (i++ % 2 === 0) throw new Error('boom');
        return 'earnings';
      },
    });
    const n = await classifyUnclassified(cfg, 50, 3);
    expect(n).toBe(6);
    const others = (
      getRawSqlite().prepare("SELECT COUNT(*) AS c FROM news_items WHERE category = 'other'").get() as { c: number }
    ).c;
    const earnings = (
      getRawSqlite().prepare("SELECT COUNT(*) AS c FROM news_items WHERE category = 'earnings'").get() as { c: number }
    ).c;
    expect(others + earnings).toBe(6);
    expect(others).toBeGreaterThan(0);
    expect(earnings).toBeGreaterThan(0);
  });
});
