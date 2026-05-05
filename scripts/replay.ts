import '../src/lib/env.js';
import { loadConfig } from '../src/trading/config.js';
import { createRestClient } from '../src/alpaca/client.js';
import { computeATR } from '../src/trading/atr.js';

/**
 * Pulls historical daily bars from Alpaca for one symbol, prints a basic
 * trend summary + a synthetic stop ladder. Useful for sanity-checking the
 * stop-loss math against a real history without needing Claude.
 *
 * Usage: npm run replay -- AAPL 2025-04-01 2025-04-30
 */
async function main() {
  const [symbol, start, end] = process.argv.slice(2);
  if (!symbol || !start) {
    console.error('Usage: replay <SYMBOL> <YYYY-MM-DD> [YYYY-MM-DD]');
    process.exit(1);
  }
  const cfg = loadConfig();
  const alpaca = createRestClient(cfg);
  const bars = await alpaca.getBars(symbol, {
    timeframe: '1Day',
    start: `${start}T00:00:00Z`,
    end: end ? `${end}T23:59:59Z` : undefined,
    limit: 500,
  });
  if (bars.length === 0) {
    console.log('no bars');
    return;
  }
  const atr = computeATR(bars.map((b) => ({ high: b.h, low: b.l, close: b.c })), 14);
  const last = bars.at(-1)!;
  const fixedStop = last.c * (1 - cfg.STOP_LOSS_PCT / 100);
  const atrStop = last.c - cfg.ATR_MULT * atr;
  const finalStop = Math.min(fixedStop, atrStop);
  const trailing = last.c * (1 - cfg.TRAILING_STOP_PCT / 100);

  console.log(`${symbol}  bars=${bars.length}  range=[${bars[0]!.t.slice(0, 10)} → ${last.t.slice(0, 10)}]`);
  console.log(`  last close: $${last.c.toFixed(2)}`);
  console.log(`  ATR(14):    $${atr.toFixed(2)}  (${((atr / last.c) * 100).toFixed(2)}% of price)`);
  console.log(`  fixed stop @ ${cfg.STOP_LOSS_PCT}%: $${fixedStop.toFixed(2)}`);
  console.log(`  ATR stop @  ${cfg.ATR_MULT}× ATR: $${atrStop.toFixed(2)}`);
  console.log(`  → using:                  $${finalStop.toFixed(2)} (max width)`);
  console.log(`  trailing stop @ ${cfg.TRAILING_STOP_PCT}%: $${trailing.toFixed(2)} from peak`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
