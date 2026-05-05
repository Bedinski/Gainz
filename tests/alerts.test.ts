import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applySchema } from '../src/db/migrate.js';
import { closeDb, getDb, getRawSqlite } from '../src/db/client.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import { sendAlert } from '../src/lib/alerts.js';

const baseEnv = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'AAPL',
  ALERT_MIN_SEVERITY: 'warn',
  ALERT_DEDUPE_TTL_MIN: '30',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  closeDb();
  clearConfigCacheForTests();
  getDb(':memory:');
  applySchema();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendAlert dispatcher', () => {
  it('logs only when no transports are configured but still records the alert', async () => {
    const cfg = loadConfig(baseEnv);
    const r = await sendAlert({ severity: 'warn', title: 'T', body: 'B' }, cfg);
    expect(r.transports).toEqual([]); // no transports
    const rows = getRawSqlite().prepare('SELECT * FROM alerts_sent').all() as Array<{ transports: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.transports).toBe('log-only');
  });

  it('skips dispatch when severity is below ALERT_MIN_SEVERITY', async () => {
    const cfg = loadConfig({ ...baseEnv, ALERT_MIN_SEVERITY: 'critical' } as unknown as NodeJS.ProcessEnv);
    const r = await sendAlert({ severity: 'warn', title: 'T', body: 'B' }, cfg);
    expect(r.dispatched).toBe(false);
    expect(r.reason).toBe('below severity threshold');
  });

  it('dedupes within TTL window', async () => {
    const cfg = loadConfig(baseEnv);
    const first = await sendAlert(
      { severity: 'warn', title: 'Drift', body: 'b1', dedupeKey: 'recon:2026-05-05' },
      cfg,
    );
    const second = await sendAlert(
      { severity: 'warn', title: 'Drift', body: 'b2', dedupeKey: 'recon:2026-05-05' },
      cfg,
    );
    expect(first.reason).not.toBe('deduped');
    expect(second.reason).toBe('deduped');
    const rows = getRawSqlite().prepare('SELECT COUNT(*) AS c FROM alerts_sent').get() as { c: number };
    expect(rows.c).toBe(1); // only the first persisted
  });

  it('dispatches via webhook when ALERT_WEBHOOK_URL is set', async () => {
    const cfg = loadConfig({
      ...baseEnv,
      ALERT_WEBHOOK_URL: 'https://hooks.example.com/test',
    } as unknown as NodeJS.ProcessEnv);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    } as unknown as Response);
    const r = await sendAlert({ severity: 'warn', title: 'T', body: 'B' }, cfg);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r.transports).toContain('webhook');
  });

  it('records error when webhook fails but does not throw', async () => {
    const cfg = loadConfig({
      ...baseEnv,
      ALERT_WEBHOOK_URL: 'https://hooks.example.com/test',
    } as unknown as NodeJS.ProcessEnv);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
    } as unknown as Response);
    const r = await sendAlert({ severity: 'critical', title: 'T', body: 'B' }, cfg);
    expect(r.errors.length).toBeGreaterThan(0);
    const rows = getRawSqlite().prepare('SELECT error FROM alerts_sent').all() as Array<{ error: string | null }>;
    expect(rows[0]!.error).toBeTruthy();
  });
});
