import 'dotenv/config';
import { applySchema } from '../src/db/migrate.js';
import { getDb } from '../src/db/client.js';
import { refreshCongressTrades } from '../src/signals/congress/refresh.js';

async function main() {
  getDb();
  applySchema();
  const result = await refreshCongressTrades();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
