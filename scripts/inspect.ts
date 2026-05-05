import '../src/lib/env.js';
import { getRawSqlite, getDb } from '../src/db/client.js';
import { applySchema } from '../src/db/migrate.js';

/**
 * Lightweight DB inspection CLI. Avoids the sqlite3 binary dep — uses the
 * better-sqlite3 binding the bot already ships with.
 *
 *   npm run inspect             # all-symbols summary (recent proposals + orders + positions)
 *   npm run inspect GOOGL       # focus on a single symbol
 */
function main() {
  const symbolArg = process.argv[2]?.toUpperCase();
  getDb();
  applySchema();
  const db = getRawSqlite();

  console.log('\n=== Recent proposals (last 10) ===');
  const propRows = symbolArg
    ? db
        .prepare(
          `SELECT id, decision_id, symbol, side, qty, notional_usd,
                  entry_type, entry_trigger_price, stop_loss_pct, trailing_stop_pct,
                  guardrail_status, guardrail_reason
             FROM proposals
            WHERE symbol = ?
            ORDER BY id DESC LIMIT 10`,
        )
        .all(symbolArg)
    : db
        .prepare(
          `SELECT id, decision_id, symbol, side, qty, notional_usd,
                  entry_type, entry_trigger_price, stop_loss_pct, trailing_stop_pct,
                  guardrail_status, guardrail_reason
             FROM proposals
            ORDER BY id DESC LIMIT 10`,
        )
        .all();
  console.table(propRows);

  console.log('\n=== Recent orders (last 10) ===');
  const orderRows = symbolArg
    ? db
        .prepare(
          `SELECT id, alpaca_order_id, parent_alpaca_order_id, symbol, side, type, qty,
                  notional_usd, status, filled_avg_price,
                  datetime(submitted_at/1000, 'unixepoch') AS submitted,
                  datetime(filled_at/1000,    'unixepoch') AS filled
             FROM orders
            WHERE symbol = ?
            ORDER BY id DESC LIMIT 10`,
        )
        .all(symbolArg)
    : db
        .prepare(
          `SELECT id, alpaca_order_id, parent_alpaca_order_id, symbol, side, type, qty,
                  notional_usd, status, filled_avg_price,
                  datetime(submitted_at/1000, 'unixepoch') AS submitted,
                  datetime(filled_at/1000,    'unixepoch') AS filled
             FROM orders
            ORDER BY id DESC LIMIT 10`,
        )
        .all();
  console.table(orderRows);

  console.log('\n=== Open positions (positions_meta) ===');
  const posRows = symbolArg
    ? db
        .prepare(
          `SELECT symbol, qty, entry_price, current_stop_type, current_stop_price,
                  trailing_stop_pct, highest_price_seen, strategy_tag, sector,
                  datetime(opened_at/1000, 'unixepoch') AS opened
             FROM positions_meta WHERE symbol = ?`,
        )
        .all(symbolArg)
    : db
        .prepare(
          `SELECT symbol, qty, entry_price, current_stop_type, current_stop_price,
                  trailing_stop_pct, highest_price_seen, strategy_tag, sector,
                  datetime(opened_at/1000, 'unixepoch') AS opened
             FROM positions_meta`,
        )
        .all();
  console.table(posRows.length ? posRows : [{ note: 'no positions' }]);

  console.log('\n=== Bot state ===');
  const state = db.prepare('SELECT * FROM bot_state WHERE id = 1').get();
  console.table(state ? [state] : [{ note: 'no row — bot will start enabled by default' }]);

  console.log('\n=== Today daily_state ===');
  const today = new Date().toISOString().slice(0, 10);
  const daily = db.prepare('SELECT * FROM daily_state WHERE date = ?').get(today);
  console.table(daily ? [daily] : [{ note: `no row for ${today}` }]);

  console.log('\n=== Most recent decision (Claude raw response) ===');
  const lastDecision = db
    .prepare(
      `SELECT id, timestamp, model, prompt_tokens, completion_tokens,
              parsed_proposals_json, raw_response, error_message
         FROM decisions ORDER BY id DESC LIMIT 1`,
    )
    .get() as
    | {
        id: number;
        timestamp: number;
        model: string;
        prompt_tokens: number | null;
        completion_tokens: number | null;
        parsed_proposals_json: string;
        raw_response: string;
        error_message: string | null;
      }
    | undefined;
  if (!lastDecision) {
    console.log('(no decisions yet)');
  } else {
    console.log(
      `decision #${lastDecision.id}  ${new Date(lastDecision.timestamp).toISOString()}  ` +
        `model=${lastDecision.model}  prompt=${lastDecision.prompt_tokens}  completion=${lastDecision.completion_tokens}`,
    );
    if (lastDecision.error_message) {
      console.log(`error_message: ${lastDecision.error_message}`);
    }
    console.log(`parsed_proposals_json: ${lastDecision.parsed_proposals_json}`);
    console.log('--- raw_response (truncated to 4000 chars) ---');
    const raw = lastDecision.raw_response ?? '';
    console.log(raw.length > 4000 ? raw.slice(0, 4000) + `\n... [${raw.length - 4000} more chars]` : raw);
  }
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
