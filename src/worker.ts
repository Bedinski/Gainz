import './lib/env.js';
import cron from 'node-cron';
import { loadConfig } from './trading/config.js';
import { applySchema } from './db/migrate.js';
import { getDb } from './db/client.js';
import { runCycle } from './trading/cycle.js';
import { createRestClient } from './alpaca/client.js';
import { createSdkClient } from './claude/client.js';
import { logger } from './lib/logger.js';
import { refreshCongressTrades } from './signals/congress/refresh.js';
import { refreshAlpacaNews } from './signals/news/alpaca.js';
import { runPostmortem } from './claude/postmortem.js';
import { reconcilePositions } from './trading/reconcile.js';
import { sendAlert } from './lib/alerts.js';

async function main() {
  const cfg = loadConfig();
  getDb();
  applySchema();

  const alpaca = createRestClient(cfg);
  const claude = createSdkClient(cfg);

  logger.info(
    { cron: cfg.CRON_SCHEDULE, tz: cfg.CRON_TZ, mode: cfg.TRADING_MODE, safe: cfg.SAFE_MODE },
    'worker starting',
  );

  // Trading cycle. Fired by cron on CRON_SCHEDULE plus once at boot so the
  // worker doesn't sit idle for up to 15 minutes after a (re)start. The
  // boot-time call goes through the same `runCycle` and respects all gates
  // (bot disabled, market closed, daily halt, circuit breaker), so an
  // out-of-hours start is a no-op that logs `skippedReason`.
  const tradingCycle = async () => {
    try {
      const result = await runCycle({ cfg, alpaca, claude });
      logger.info(result, 'cycle complete');
    } catch (err) {
      logger.error({ err: String(err) }, 'cycle threw');
    }
  };
  cron.schedule(cfg.CRON_SCHEDULE, tradingCycle, { timezone: cfg.CRON_TZ });
  // Fire once now so a fresh start doesn't stall behind the next 15-min tick.
  // Awaited inline — main() returns only after the boot-time cycle settles,
  // which keeps process startup logs in a sane order.
  await tradingCycle();

  // Daily congress + earnings refresh, 3am ET.
  cron.schedule(
    '0 3 * * *',
    async () => {
      try {
        const result = await refreshCongressTrades();
        logger.info(result, 'congress refresh complete');
      } catch (err) {
        logger.error({ err: String(err) }, 'congress refresh threw');
      }
    },
    { timezone: cfg.CRON_TZ },
  );

  // News + classify refresh, every 30 min during market hours (cheap, fast).
  if (cfg.ALPACA_NEWS_ENABLED) {
    cron.schedule(
      '*/30 9-16 * * 1-5',
      async () => {
        try {
          const result = await refreshAlpacaNews();
          logger.info(result, 'news refresh complete');
        } catch (err) {
          logger.error({ err: String(err) }, 'news refresh threw');
        }
      },
      { timezone: cfg.CRON_TZ },
    );
  }

  // iter4 B4: daily post-mortem at 6pm ET, M-F. Reviews yesterday's decisions
  // against today's market closes; output lands in the `postmortems` table.
  cron.schedule(
    '0 18 * * 1-5',
    async () => {
      try {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        const result = await runPostmortem(cfg, claude, yesterday);
        logger.info(
          {
            date: result.date,
            lessons: result.lessons?.length ?? 0,
            promptTokens: result.promptTokens,
          },
          'postmortem complete',
        );
      } catch (err) {
        logger.error({ err: String(err) }, 'postmortem threw');
      }
    },
    { timezone: cfg.CRON_TZ },
  );

  // iter4 C4: standalone reconciliation cron (in addition to per-cycle run).
  // Catches drift outside trading hours — e.g. a corporate action or a manual
  // broker-side adjustment that happens after market close.
  cron.schedule(
    '0 17 * * 1-5',
    async () => {
      try {
        const result = await reconcilePositions(alpaca, cfg);
        if (result.severity !== 'ok') {
          await sendAlert(
            {
              severity: result.severity === 'critical' ? 'critical' : 'warn',
              title: `Reconciliation drift (post-close): ${result.mismatches.length} mismatch${
                result.mismatches.length === 1 ? '' : 'es'
              }`,
              body: JSON.stringify(result.mismatches, null, 2).slice(0, 4000),
              dedupeKey: `reconcile-eod:${new Date().toISOString().slice(0, 10)}`,
            },
            cfg,
          ).catch((err) =>
            logger.error({ err: String(err) }, 'eod reconciliation alert dispatch failed'),
          );
        }
        logger.info({ result }, 'eod reconciliation complete');
      } catch (err) {
        logger.error({ err: String(err) }, 'eod reconciliation threw');
      }
    },
    { timezone: cfg.CRON_TZ },
  );

  // Keep alive.
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received');
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err: String(err) }, 'worker bootstrap failed');
  process.exit(1);
});
