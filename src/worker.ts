import 'dotenv/config';
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

  // Trading cycle.
  cron.schedule(
    cfg.CRON_SCHEDULE,
    async () => {
      try {
        const result = await runCycle({ cfg, alpaca, claude });
        logger.info(result, 'cycle complete');
      } catch (err) {
        logger.error({ err: String(err) }, 'cycle threw');
      }
    },
    { timezone: cfg.CRON_TZ },
  );

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
