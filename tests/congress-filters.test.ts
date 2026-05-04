import { describe, it, expect, beforeEach } from 'vitest';
import { applySchema } from '../src/db/migrate.js';
import { closeDb, getDb, getRawSqlite } from '../src/db/client.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import {
  applyIngestionFilters,
  recomputeBoosts,
  upsertTrades,
} from '../src/signals/congress/refresh.js';
import { loadCongressSignals } from '../src/signals/congress/query.js';
import { hasCommitteeFit } from '../src/signals/congress/committees.js';
import type { RawCongressTrade } from '../src/signals/congress/provider.js';

const env = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'LMT,AAPL,NVDA',
  CONGRESS_REQUIRE_OWN_TRADE: 'true',
  CONGRESS_MIN_AMOUNT_USD: '50000',
  CONGRESS_MAX_AGE_DAYS: '14',
  CLUSTER_WINDOW_DAYS: '7',
  CONGRESS_LOOKBACK_DAYS: '30',
  CONGRESS_MAX_TRADES_PER_SYMBOL: '5',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

function todayMinus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  closeDb();
  clearConfigCacheForTests();
  getDb(':memory:');
  applySchema();
});

const baseTrade: RawCongressTrade = {
  source: 'stockwatcher',
  sourceId: 'x',
  filerName: 'Sen. Doe',
  filerChamber: 'senate',
  filerParty: 'R',
  filerState: 'TX',
  filerCommittees: ['Armed Services'],
  filerIsPolitician: true,
  symbol: 'LMT',
  transactionType: 'buy',
  transactionDate: todayMinus(3),
  amountMinUsd: 50000,
  amountMaxUsd: 100000,
  raw: {},
};

describe('congress ingestion filters', () => {
  it('drops spouse / non-politician filings', () => {
    const cfg = loadConfig(env);
    const rows = [
      { ...baseTrade, sourceId: 'a' },
      { ...baseTrade, sourceId: 'b', filerIsPolitician: false },
    ];
    const out = applyIngestionFilters(rows, cfg);
    expect(out.map((r) => r.sourceId)).toEqual(['a']);
  });

  it('drops sub-threshold amount ranges', () => {
    const cfg = loadConfig(env);
    const rows = [
      { ...baseTrade, sourceId: 'a' },
      { ...baseTrade, sourceId: 'b', amountMaxUsd: 15000 },
    ];
    const out = applyIngestionFilters(rows, cfg);
    expect(out.map((r) => r.sourceId)).toEqual(['a']);
  });

  it('drops stale disclosures (older than CONGRESS_MAX_AGE_DAYS)', () => {
    const cfg = loadConfig(env);
    const rows = [
      { ...baseTrade, sourceId: 'a' },
      { ...baseTrade, sourceId: 'b', transactionDate: todayMinus(45) },
    ];
    const out = applyIngestionFilters(rows, cfg);
    expect(out.map((r) => r.sourceId)).toEqual(['a']);
  });
});

describe('committee fit boost', () => {
  it('matches Armed Services -> defense (LMT)', () => {
    expect(hasCommitteeFit('LMT', ['Armed Services'])).toBe(true);
  });
  it('matches Energy & Commerce -> healthcare (UNH)', () => {
    expect(hasCommitteeFit('UNH', ['Energy and Commerce'])).toBe(true);
  });
  it('does not boost mismatched committees', () => {
    expect(hasCommitteeFit('LMT', ['Agriculture'])).toBe(false);
  });
  it('returns false for index symbols', () => {
    expect(hasCommitteeFit('SPY', ['Armed Services'])).toBe(false);
  });
});

describe('cluster size + filtered query', () => {
  it('boosts cluster_size when multiple distinct filers buy same symbol', () => {
    const cfg = loadConfig(env);
    const rows: RawCongressTrade[] = [
      { ...baseTrade, sourceId: '1', filerName: 'Sen. Doe' },
      { ...baseTrade, sourceId: '2', filerName: 'Sen. Roe' },
      { ...baseTrade, sourceId: '3', filerName: 'Sen. Smith' },
    ];
    const filtered = applyIngestionFilters(rows, cfg);
    upsertTrades(filtered);
    recomputeBoosts(cfg);
    const db = getRawSqlite();
    const r = db.prepare('SELECT cluster_size FROM congress_trades WHERE source_id = ?').get('1') as
      | { cluster_size: number }
      | undefined;
    expect(r?.cluster_size).toBe(3);
  });

  it('loadCongressSignals returns only filings with committee_fit OR cluster>=2', () => {
    const cfg = loadConfig(env);
    // No committee fit, cluster size 1 → should be filtered out by query
    const isolatedTrade: RawCongressTrade = {
      ...baseTrade,
      sourceId: 'iso',
      symbol: 'AAPL',
      filerCommittees: ['Agriculture'], // no tech fit
      filerName: 'Rep. Lonely',
    };
    upsertTrades(applyIngestionFilters([isolatedTrade], cfg));
    recomputeBoosts(cfg);
    const out = loadCongressSignals(['AAPL', 'LMT'], 30);
    expect(out.AAPL).toHaveLength(0);
  });

  it('loadCongressSignals includes committee_fit filings', () => {
    const cfg = loadConfig(env);
    upsertTrades(applyIngestionFilters([baseTrade], cfg));
    recomputeBoosts(cfg);
    const out = loadCongressSignals(['LMT'], 30);
    expect(out.LMT).toHaveLength(1);
    expect(out.LMT?.[0]?.committeeFitBoost).toBe(true);
  });
});
