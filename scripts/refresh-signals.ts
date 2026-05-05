import '../src/lib/env.js';
import { applySchema } from '../src/db/migrate.js';
import { getDb } from '../src/db/client.js';
import { loadConfig } from '../src/trading/config.js';
import { refreshCongressTrades } from '../src/signals/congress/refresh.js';
import { refreshAlpacaNews } from '../src/signals/news/alpaca.js';

async function main() {
  getDb();
  applySchema();
  const cfg = loadConfig();
  const congress = await refreshCongressTrades();
  const news = cfg.ALPACA_NEWS_ENABLED
    ? await refreshAlpacaNews()
    : { fetched: 0, inserted: 0, classified: 0 };
  console.log(JSON.stringify({ congress, news }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
