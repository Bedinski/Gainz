import '../src/lib/env.js';
import { closeDb, getDb, getRawSqlite } from '../src/db/client.js';
import { applySchema } from '../src/db/migrate.js';
import { loadConfig, type Config } from '../src/trading/config.js';
import { createRestClient, type AlpacaClient } from '../src/alpaca/client.js';
import { fetchAlpacaNews, upsertNewsItems, classifyUnclassified } from '../src/signals/news/alpaca.js';
import { setHeadlineClassifier, heuristicClassify } from '../src/signals/news/classify.js';
import { runStrategyOracle, type OracleBar, type OracleEvent, type OracleTrade } from '../src/strategies/dip-recovery/oracle.js';

/**
 * Historical-replay backtest for the iter3 dip-recovery strategy.
 *
 * Usage:
 *   npm run backtest -- --start 2025-04-01 --end 2025-05-15
 *   npm run backtest -- --start 2025-04-01 --end 2025-05-15 --detector-only
 *   npm run backtest -- --symbols SPY,QQQ --start 2025-01-01 --end 2025-12-31
 *
 * No real Claude calls: backtest determinism uses a strategy oracle that
 * follows the same gates as the live deterministic detector. Validates the
 * surrounding plumbing + thresholds; live Claude judgment is layered on in
 * production.
 */

interface Args {
  start: string;
  end: string;
  symbols: string[];
  detectorOnly: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let start = '';
  let end = '';
  let symbolsRaw = '';
  let detectorOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--start') start = args[++i] ?? '';
    else if (a === '--end') end = args[++i] ?? '';
    else if (a === '--symbols') symbolsRaw = args[++i] ?? '';
    else if (a === '--detector-only') detectorOnly = true;
  }
  if (!start || !end) {
    console.error('Usage: backtest --start YYYY-MM-DD --end YYYY-MM-DD [--symbols SPY,QQQ] [--detector-only]');
    process.exit(1);
  }
  const symbols = (symbolsRaw || 'SPY,QQQ').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return { start, end, symbols, detectorOnly };
}

type Bar = OracleBar;
type Trade = OracleTrade;
type DipState = OracleEvent;

async function fetchBars(client: AlpacaClient, symbol: string, start: string, end: string): Promise<Bar[]> {
  const bars = await client.getBars(symbol, {
    timeframe: '1Day',
    start: `${start}T00:00:00Z`,
    end: `${end}T23:59:59Z`,
    limit: 500,
  });
  return bars;
}

function summarizeTrades(trades: Trade[]) {
  if (trades.length === 0) return { count: 0, winRate: 0, meanPnl: 0, totalPnl: 0, meanDays: 0 };
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const meanPnl = totalPnl / trades.length;
  const meanDays = trades.reduce((s, t) => s + t.daysHeld, 0) / trades.length;
  return {
    count: trades.length,
    winRate: wins.length / trades.length,
    meanPnl,
    totalPnl,
    meanDays,
  };
}

async function main() {
  const args = parseArgs();
  const cfg = loadConfig();

  // In-memory DB so the backtest doesn't pollute the main one.
  closeDb();
  process.env.SQLITE_PATH = ':memory:';
  getDb(':memory:');
  applySchema();

  // Force the heuristic classifier — backtest must be deterministic and free.
  setHeadlineClassifier({ classify: async (i) => heuristicClassify(i) });

  let alpaca: AlpacaClient;
  try {
    alpaca = createRestClient(cfg);
  } catch (err) {
    console.error('Alpaca credentials required to fetch historical bars + news.');
    console.error('Set ALPACA_KEY_ID and ALPACA_SECRET_KEY in .env (paper keys are fine).');
    console.error('Underlying error:', String(err));
    process.exit(1);
  }

  console.log(
    `Backtest range: ${args.start} → ${args.end}; symbols: ${args.symbols.join(', ')}; ` +
      `detector-only=${args.detectorOnly}`,
  );

  // 1. fetch bars for all symbols
  const barsBySymbol = new Map<string, Bar[]>();
  for (const sym of args.symbols) {
    const bars = await fetchBars(alpaca, sym, args.start, args.end);
    console.log(`  ${sym}: ${bars.length} bars`);
    barsBySymbol.set(sym, bars);
  }

  // 2. fetch + classify news once for all symbols (heuristic, deterministic).
  const newsByDay = new Map<string, Array<{ category: string }>>();
  if (cfg.DIP_REQUIRES_POLITICAL_NEWS) {
    try {
      const articles = await fetchAlpacaNews(args.symbols, {
        lookbackHours: hoursBetween(args.start, args.end),
        limit: 1000,
      });
      console.log(`  fetched ${articles.length} news articles`);
      upsertNewsItems(articles, args.symbols);
      await classifyUnclassified(cfg, 5000);
      const rows = getRawSqlite()
        .prepare('SELECT category, published_at FROM news_items')
        .all() as Array<{ category: string; published_at: number }>;
      for (const r of rows) {
        const day = new Date(r.published_at).toISOString().slice(0, 10);
        const arr = newsByDay.get(day) ?? [];
        arr.push({ category: r.category });
        newsByDay.set(day, arr);
      }
      const shockCount = rows.filter((r) => r.category === 'political_shock').length;
      console.log(`  classified ${rows.length} headlines (${shockCount} political_shock)`);
    } catch (err) {
      console.warn(`  news fetch failed (${String(err)}); continuing with empty news cache.`);
      console.warn('  Note: with DIP_REQUIRES_POLITICAL_NEWS=true the detector will not fire.');
    }
  }

  // 3. run strategy per symbol
  const allEvents: Array<DipState & { symbol: string }> = [];
  const allTrades: Trade[] = [];
  for (const sym of args.symbols) {
    const bars = barsBySymbol.get(sym) ?? [];
    if (bars.length < cfg.DIP_DETECTION_WINDOW_DAYS + 2) {
      console.warn(`  ${sym}: not enough bars (${bars.length}); skipping`);
      continue;
    }
    const { events, trades } = runStrategyOracle(sym, bars, newsByDay, cfg, { detectorOnly: args.detectorOnly });
    for (const e of events) allEvents.push({ ...e, symbol: sym });
    for (const t of trades) allTrades.push(t);
  }

  // 4. output
  console.log('\n=== Detected dip events ===');
  for (const e of allEvents) {
    console.log(
      `  ${e.symbol}  detected=${e.detectedAt}  peak=$${e.peakPrice.toFixed(2)} (${e.peakDate}) ` +
        `→ trough=$${e.troughPrice.toFixed(2)} (${e.troughDate}) = -${e.drawdownPct.toFixed(1)}%  ` +
        `target=$${e.targetPrice.toFixed(2)}  status=${e.status}`,
    );
  }

  if (!args.detectorOnly) {
    console.log('\n=== Trades (JSONL) ===');
    for (const t of allTrades) console.log(JSON.stringify(t));

    const summary = summarizeTrades(allTrades);
    console.log('\n=== Summary ===');
    console.log(JSON.stringify(summary, null, 2));
  }
}

function hoursBetween(start: string, end: string): number {
  const ms = Date.parse(`${end}T23:59:59Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.max(1, Math.ceil(ms / (60 * 60 * 1000)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
