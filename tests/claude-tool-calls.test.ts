import { describe, it, expect, beforeEach } from 'vitest';
import { applySchema } from '../src/db/migrate.js';
import { closeDb, getDb, getRawSqlite } from '../src/db/client.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import { runCycle } from '../src/trading/cycle.js';
import type { AlpacaClient } from '../src/alpaca/client.js';
import type { ClaudeClient } from '../src/claude/client.js';

const env = {
  TRADING_MODE: 'paper',
  SAFE_MODE: 'true',
  SYMBOL_ALLOWLIST: 'AAPL',
  MAX_POSITION_USD: '500',
  MAX_ORDER_USD: '500',
  MAX_DAILY_LOSS_USD: '500',
  MIN_SIGNAL_SCORE: '0',
  CIRCUIT_BREAKER_ENABLED: 'false',
  ALPACA_KEY_ID: 'k',
  ALPACA_SECRET_KEY: 's',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

function bars() {
  return Array.from({ length: 30 }, (_, i) => ({
    t: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    o: 180,
    h: 185,
    l: 175,
    c: 182,
    v: 1_000_000,
  }));
}

function mockAlpaca(): AlpacaClient {
  const b = bars();
  return {
    getClock: async () => ({ is_open: true, next_open: '', next_close: '' }),
    getAccount: async () => ({ cash: '5000', equity: '5000', portfolio_value: '5000' }),
    getSettledCash: async () => 5000,
    getPositions: async () => [],
    getOrders: async () => [],
    getBars: async () => b,
    getBarsBatch: async (s) => Object.fromEntries(s.map((x) => [x, b])),
    getLatestQuote: async () => ({ ap: 182, bp: 181.95, t: '' }),
    getLatestQuotesBatch: async (s) =>
      Object.fromEntries(s.map((x) => [x, { ap: 182, bp: 181.95, t: '' }])),
    submitBracket: async () => ({ id: 'b', status: 'accepted', legs: [] }),
    submitNotionalBracket: async () => ({ parentOrderId: 'p', parentStatus: 'filled' }),
    submitTrailingStop: async () => ({ id: 't', status: 'accepted' }),
    submitMarket: async () => ({ id: 'm', status: 'accepted' }),
    submitStop: async () => ({ id: 's', status: 'accepted' }),
    cancelOrder: async () => undefined,
    getOrder: async () => ({ id: '', status: 'filled', filled_avg_price: '182', filled_qty: '1', filled_at: '' }),
  };
}

/** Claude mock that emits tool_use + tool_result on the second call (deep analyze). */
function clientWithToolCalls(): ClaudeClient {
  let n = 0;
  return {
    complete: async () => {
      n++;
      if (n === 1) {
        return { text: JSON.stringify({ shortlist: ['AAPL'] }), model: 'claude-sonnet-4-6' };
      }
      if (n === 2) {
        // Deep analyze: emit a fake tool call + result alongside the proposal.
        return {
          text: JSON.stringify({
            proposals: [
              {
                symbol: 'AAPL',
                side: 'buy',
                notional_usd: 200,
                signals: {
                  technical: { strength: 2, evidence: '' },
                  congress: { strength: 1, evidence: '' },
                  news: { strength: 1, evidence: '' },
                  earnings_proximity: 'clear',
                  conflicts: [],
                },
              },
            ],
          }),
          model: 'claude-sonnet-4-6',
          toolCalls: [
            {
              name: 'mcp__unusualwhales__options_flow',
              args: { symbol: 'AAPL', lookback_hours: 4 },
              result: { sweeps: 3, total_notional: 1_500_000 },
            },
          ],
        };
      }
      // debate calls
      return {
        text: JSON.stringify({ decision: 'proceed', rationale: '' }),
        model: 'claude-sonnet-4-6',
      };
    },
  };
}

beforeEach(() => {
  closeDb();
  clearConfigCacheForTests();
  getDb(':memory:');
  applySchema();
});

describe('iter4 A2 — claude_tool_calls audit', () => {
  it('persists tool_use rows tagged by stage to claude_tool_calls', async () => {
    const cfg = loadConfig(env);
    const result = await runCycle({ cfg, alpaca: mockAlpaca(), claude: clientWithToolCalls() });
    expect(result.skippedReason).toBeUndefined();

    const rows = getRawSqlite()
      .prepare('SELECT decision_id, tool_name, args_json, result_json FROM claude_tool_calls ORDER BY id')
      .all() as Array<{ decision_id: number; tool_name: string; args_json: string; result_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_name).toBe('deep:AAPL:mcp__unusualwhales__options_flow');
    expect(JSON.parse(rows[0]!.args_json)).toEqual({ symbol: 'AAPL', lookback_hours: 4 });
    expect(JSON.parse(rows[0]!.result_json)).toEqual({ sweeps: 3, total_notional: 1_500_000 });
    expect(rows[0]!.decision_id).toBe(result.decisionId);
  });
});
