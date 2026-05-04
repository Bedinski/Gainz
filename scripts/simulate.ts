import 'dotenv/config';
import { applySchema } from '../src/db/migrate.js';
import { closeDb, getDb } from '../src/db/client.js';
import { runCycle } from '../src/trading/cycle.js';
import { loadConfig } from '../src/trading/config.js';
import type { AlpacaClient } from '../src/alpaca/client.js';
import type { ClaudeClient } from '../src/claude/client.js';

// Stand-in deps so this runs offline. Useful for prompt-iteration without an
// Alpaca key or Claude OAuth on the sandbox.
const fixtureBars = Array.from({ length: 30 }, (_, i) => ({
  t: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
  o: 180 + i * 0.2,
  h: 185 + i * 0.2,
  l: 175 + i * 0.2,
  c: 182 + i * 0.25,
  v: 1_000_000,
}));

const fakeAlpaca: AlpacaClient = {
  getClock: async () => ({ is_open: true, next_open: '', next_close: '' }),
  getAccount: async () => ({ cash: '2500', equity: '2500', portfolio_value: '2500' }),
  getSettledCash: async () => 2500,
  getPositions: async () => [],
  getOrders: async () => [],
  getBars: async () => fixtureBars,
  getBarsBatch: async (symbols) => Object.fromEntries(symbols.map((s) => [s, fixtureBars])),
  getLatestQuote: async () => ({ ap: 188, bp: 187.95, t: '' }),
  getLatestQuotesBatch: async (symbols) =>
    Object.fromEntries(symbols.map((s) => [s, { ap: 188, bp: 187.95, t: '' }])),
  submitBracket: async () => ({ id: 'sim-1', status: 'accepted', legs: [{ id: 'sim-sl-1', order_class: 'bracket' }] }),
  submitNotionalBracket: async () => ({
    parentOrderId: 'sim-p-1',
    parentStatus: 'filled',
    filledQty: 2.13,
    filledAvgPrice: 188,
    stopOrderId: 'sim-s-1',
    stopStatus: 'accepted',
  }),
  submitTrailingStop: async () => ({ id: 'sim-t-1', status: 'accepted' }),
  submitMarket: async () => ({ id: 'sim-m-1', status: 'accepted' }),
  submitStop: async () => ({ id: 'sim-st-1', status: 'accepted' }),
  cancelOrder: async () => undefined,
  getOrder: async () => ({
    id: 'sim-1',
    status: 'filled',
    filled_avg_price: '188',
    filled_qty: '2.13',
    filled_at: '',
  }),
};

/**
 * Two-stage simulator: the first call returns a shortlist; the second returns
 * a structured proposal with a `signals` block; subsequent calls (debate) say
 * proceed.
 */
function makeFakeClaude(): ClaudeClient {
  let n = 0;
  return {
    complete: async ({ userPrompt }) => {
      n++;
      console.log(`=== USER PROMPT call#${n} (truncated) ===`);
      console.log(userPrompt.slice(0, 1500));
      console.log('...');
      if (n === 1) {
        return {
          text: JSON.stringify({ shortlist: ['AAPL'], notes: 'one ticker worth a deeper look' }),
          model: 'claude-sonnet-4-6 (sim)',
          promptTokens: 0,
          completionTokens: 0,
        };
      }
      if (n === 2) {
        return {
          text: JSON.stringify({
            proposals: [
              {
                symbol: 'AAPL',
                side: 'buy',
                notional_usd: 300,
                entry_type: 'stop',
                stop_loss_pct: 2.5,
                trailing_stop_pct: 3,
                reasoning: '(simulated) breakout + cluster + earnings beat',
                signals: {
                  technical: { strength: 2, evidence: 'breakout above 5-day high, vol +120%' },
                  congress: { strength: 1, evidence: 'Pelosi single-filer buy 4d ago' },
                  news: { strength: 1, evidence: 'positive guidance update yesterday' },
                  earnings_proximity: 'clear',
                  conflicts: [],
                },
              },
            ],
            notes: 'simulated decision',
          }),
          model: 'claude-sonnet-4-6 (sim)',
          promptTokens: 0,
          completionTokens: 0,
        };
      }
      // debate (bull, bear) — both proceed for the simulator
      return {
        text: JSON.stringify({ decision: 'proceed', rationale: 'simulator default proceed' }),
        model: 'claude-sonnet-4-6 (sim)',
        promptTokens: 0,
        completionTokens: 0,
      };
    },
  };
}

async function main() {
  process.env.SQLITE_PATH ??= ':memory:';
  process.env.SAFE_MODE = 'true';
  const cfg = loadConfig();
  closeDb();
  getDb(':memory:');
  applySchema();
  const result = await runCycle({ cfg, alpaca: fakeAlpaca, claude: makeFakeClaude() });
  console.log('=== CYCLE RESULT ===');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
