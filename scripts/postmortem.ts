import '../src/lib/env.js';
import { loadConfig } from '../src/trading/config.js';
import { applySchema } from '../src/db/migrate.js';
import { getDb } from '../src/db/client.js';
import { createSdkClient } from '../src/claude/client.js';
import { runPostmortem } from '../src/claude/postmortem.js';
import { logger } from '../src/lib/logger.js';

/**
 * iter4 B4: standalone post-mortem CLI.
 *
 * Usage:
 *   npm run postmortem            # reviews yesterday
 *   npm run postmortem 2026-05-01 # reviews a specific date
 *
 * The cron in worker.ts calls this same code path at 6pm ET each weekday.
 * Standalone runs are useful for backfilling or re-running after an outage.
 */
async function main() {
  const cfg = loadConfig();
  getDb();
  applySchema();
  const claude = createSdkClient(cfg);

  const arg = process.argv[2];
  const date = arg ?? defaultDate();
  logger.info({ date }, 'postmortem starting');

  const result = await runPostmortem(cfg, claude, date);
  logger.info(
    {
      date,
      summaryLen: result.summaryMd.length,
      lessons: result.lessons?.length ?? 0,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      parseError: result.parseError,
    },
    'postmortem complete',
  );
  // eslint-disable-next-line no-console
  console.log('\n=== POST-MORTEM SUMMARY ===\n');
  // eslint-disable-next-line no-console
  console.log(result.summaryMd);
}

/** Yesterday's date in YYYY-MM-DD (UTC). */
function defaultDate(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

main().catch((err) => {
  logger.error({ err: String(err) }, 'postmortem bootstrap failed');
  process.exit(1);
});
