import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { applySchema } from '@/db/migrate';
import { runCycle } from '@/trading/cycle';
import { createRestClient } from '@/alpaca/client';
import { createSdkClient } from '@/claude/client';
import { loadConfig } from '@/trading/config';
import { isAuthorized } from '@/lib/auth';

export async function POST(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const cfg = loadConfig();
  getDb();
  applySchema();
  try {
    const result = await runCycle({
      cfg,
      alpaca: createRestClient(cfg),
      claude: createSdkClient(cfg),
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
