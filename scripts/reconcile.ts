import 'dotenv/config';
import { loadConfig } from '../src/trading/config.js';
import { applySchema } from '../src/db/migrate.js';
import { getDb } from '../src/db/client.js';
import { createRestClient } from '../src/alpaca/client.js';
import { reconcilePositions } from '../src/trading/reconcile.js';
import { sendAlert } from '../src/lib/alerts.js';
import { logger } from '../src/lib/logger.js';

/**
 * iter4 C4: standalone reconciliation CLI.
 *
 * Usage:
 *   npm run reconcile
 *
 * Diffs `positions_meta` against the broker's live positions. Mismatches
 * (missing on either side, or qty drift > tolerance) trigger a critical
 * alert via the configured transports. Detect-only — auto-correction is
 * deferred to a future iteration.
 */
async function main() {
  const cfg = loadConfig();
  getDb();
  applySchema();
  const alpaca = createRestClient(cfg);

  const result = await reconcilePositions(alpaca, cfg);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));

  if (result.severity !== 'ok') {
    await sendAlert(
      {
        severity: result.severity === 'critical' ? 'critical' : 'warn',
        title: `Reconciliation drift (manual): ${result.mismatches.length} mismatch${
          result.mismatches.length === 1 ? '' : 'es'
        }`,
        body: JSON.stringify(result.mismatches, null, 2).slice(0, 4000),
        dedupeKey: `reconcile-manual:${new Date().toISOString().slice(0, 10)}`,
      },
      cfg,
    );
  }

  logger.info({ severity: result.severity, mismatches: result.mismatches.length }, 'reconcile run complete');
  process.exit(result.severity === 'critical' ? 2 : 0);
}

main().catch((err) => {
  logger.error({ err: String(err) }, 'reconcile bootstrap failed');
  process.exit(1);
});
