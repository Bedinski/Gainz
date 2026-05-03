import { NextResponse } from 'next/server';
import { getDb, getRawSqlite } from '@/db/client';
import { applySchema } from '@/db/migrate';
import { isAuthorized } from '@/lib/auth';

export async function POST(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  getDb();
  applySchema();
  const db = getRawSqlite();
  const body = (await req.json().catch(() => ({}))) as { enabled?: boolean };
  const enabled = body.enabled === true ? 1 : 0;
  db.prepare(
    `INSERT INTO bot_state (id, enabled, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(enabled, Date.now());
  return NextResponse.json({ ok: true, enabled: enabled === 1 });
}
