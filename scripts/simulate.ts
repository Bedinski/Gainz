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
  getAccount: async () => ({ cash: '5000', equity: '5000', portfolio_value: '5000' }),
  getPositions: async () => [],
  getBars: async () => fixtureBars,
  getLatestQuote: async () => ({ ap: 188, bp: 187.95, t: '' }),
  submitBracket: async () => ({ id: 'sim-1', status: 'accepted', legs: [{ id: 'sim-sl-1', order_class: 'bracket' }] }),
  submitTrailingStop: async () => ({ id: 'sim-t-1', status: 'accepted' }),
  submitMarket: async () => ({ id: 'sim-m-1', status: 'accepted' }),
  cancelOrder: async () => undefined,
  getOrder: async () => ({ id: 'sim-1', status: 'filled', filled_avg_price: '188', filled_at: '' }),
};

const fakeClaude: ClaudeClient = {
  complete: async ({ userPrompt }) => {
    console.log('=== USER PROMPT (truncated) ===');
    console.log(userPrompt.slice(0, 1500));
    console.log('...');
    return {
      text: JSON.stringify({
        proposals: [
          {
            symbol: 'AAPL',
            side: 'buy',
            notional_usd: 500,
            entry_type: 'stop',
            stop_loss_pct: 2.5,
            trailing_stop_pct: 3,
            reasoning: '(simulated) momentum confirmed by 5-day uptrend',
          },
        ],
        notes: 'simulated decision',
      }),
      model: 'claude-sonnet-4-6 (sim)',
      promptTokens: 0,
      completionTokens: 0,
    };
  },
};

async function main() {
  process.env.SQLITE_PATH ??= ':memory:';
  process.env.SAFE_MODE = 'true';
  const cfg = loadConfig();
  closeDb();
  getDb(':memory:');
  applySchema();
  const result = await runCycle({ cfg, alpaca: fakeAlpaca, claude: fakeClaude });
  console.log('=== CYCLE RESULT ===');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
