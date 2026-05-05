import { describe, it, expect, beforeEach } from 'vitest';
import { applySchema } from '../src/db/migrate.js';
import { closeDb, getDb, getRawSqlite } from '../src/db/client.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import { runPostmortem } from '../src/claude/postmortem.js';
import type { ClaudeClient } from '../src/claude/client.js';

const env = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'AAPL',
  CLAUDE_MODEL: 'claude-sonnet-4-6',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  closeDb();
  clearConfigCacheForTests();
  getDb(':memory:');
  applySchema();
});

function seedDay(date: string) {
  const db = getRawSqlite();
  const ts = Date.parse(`${date}T14:30:00Z`);
  db.prepare(
    `INSERT INTO decisions (timestamp, model, prompt_tokens, completion_tokens, raw_response, parsed_proposals_json, market_snapshot_json, congress_signals_json)
     VALUES (?, 'claude-sonnet-4-6', 100, 50, 'raw', '[]', '{}', '{}')`,
  ).run(ts);
  db.prepare(
    `INSERT INTO orders (proposal_id, alpaca_order_id, symbol, side, type, qty, notional_usd, status, submitted_at, decision_audit)
     VALUES (NULL, 'a1', 'AAPL', 'buy', 'stop', 1, 200, 'filled', ?, '[momentum] AAPL: technical=2 ...; regime=risk_on sector=tech')`,
  ).run(ts);
  db.prepare(
    `INSERT INTO equity_history (recorded_at, date, equity_usd, cash_usd) VALUES (?, ?, ?, ?)`,
  ).run(ts, date, 10_000, 5_000);
  // next day equity
  db.prepare(
    `INSERT INTO equity_history (recorded_at, date, equity_usd, cash_usd) VALUES (?, ?, ?, ?)`,
  ).run(ts + 24 * 60 * 60 * 1000, '2026-05-02', 10_150, 5_050);
}

function jsonClient(payload: object): ClaudeClient {
  return {
    complete: async () => ({
      text: JSON.stringify(payload),
      model: 'claude-sonnet-4-6',
      promptTokens: 500,
      completionTokens: 200,
    }),
  };
}

describe('runPostmortem', () => {
  it('returns an empty result when no decisions/orders for the day', async () => {
    const cfg = loadConfig(env);
    const claude = jsonClient({ summary_md: 'unused', lessons: [] });
    const result = await runPostmortem(cfg, claude, '2026-05-01');
    expect(result.summaryMd).toContain('No decisions or orders');
    expect(result.lessons).toBeUndefined();
  });

  it('builds a prompt and parses the JSON response', async () => {
    const cfg = loadConfig(env);
    seedDay('2026-05-01');
    const claude = jsonClient({
      summary_md: '# Day in review\n\nAAPL buy worked.',
      lessons: [
        {
          category: 'sizing',
          observation: 'vol clamp held back what would have been a winner',
          action: 'consider widening RISK_PER_TRADE_PCT to 0.7 in risk_on regime',
        },
      ],
    });
    const result = await runPostmortem(cfg, claude, '2026-05-01');
    expect(result.summaryMd).toContain('Day in review');
    expect(result.lessons).toHaveLength(1);
    expect(result.lessons![0]!.category).toBe('sizing');
    expect(result.parseError).toBeUndefined();

    // Persisted to postmortems table.
    const row = getRawSqlite()
      .prepare('SELECT * FROM postmortems WHERE date = ?')
      .get('2026-05-01') as {
      summary_md: string;
      lessons_json: string;
      prompt_tokens: number;
    };
    expect(row.summary_md).toContain('Day in review');
    expect(JSON.parse(row.lessons_json)).toHaveLength(1);
    expect(row.prompt_tokens).toBe(500);
  });

  it('falls back to raw text when the model returns un-parseable JSON', async () => {
    const cfg = loadConfig(env);
    seedDay('2026-05-01');
    const claude: ClaudeClient = {
      complete: async () => ({
        text: 'this is not json at all',
        model: 'claude-sonnet-4-6',
      }),
    };
    const result = await runPostmortem(cfg, claude, '2026-05-01');
    expect(result.parseError).toBeTruthy();
    expect(result.summaryMd).toBe('this is not json at all');
  });

  it('respects skipPersist for ad-hoc/dry-run callers', async () => {
    const cfg = loadConfig(env);
    seedDay('2026-05-01');
    const claude = jsonClient({ summary_md: 'x', lessons: [] });
    await runPostmortem(cfg, claude, '2026-05-01', { skipPersist: true });
    const rows = getRawSqlite().prepare('SELECT COUNT(*) AS c FROM postmortems').get() as { c: number };
    expect(rows.c).toBe(0);
  });
});
