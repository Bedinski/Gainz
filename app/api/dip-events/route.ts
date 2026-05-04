import { NextResponse } from 'next/server';
import { getDb, getRawSqlite } from '@/db/client';
import { applySchema } from '@/db/migrate';

export const dynamic = 'force-dynamic';

interface DipEventRow {
  id: number;
  symbol: string;
  detected_at: number;
  peak_price: number;
  peak_date: string;
  trough_price: number;
  trough_date: string;
  drawdown_pct: number;
  recovery_target_price: number;
  status: 'active' | 'entered' | 'recovered' | 'expired' | 'failed';
  expires_at: number;
  position_symbol: string | null;
  notes: string | null;
}

export async function GET() {
  getDb();
  applySchema();
  const db = getRawSqlite();
  const rows = db
    .prepare('SELECT * FROM dip_events ORDER BY detected_at DESC LIMIT 50')
    .all() as DipEventRow[];
  return NextResponse.json({ events: rows });
}
