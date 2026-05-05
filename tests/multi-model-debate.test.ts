import { describe, it, expect, beforeEach } from 'vitest';
import { debate } from '../src/claude/debate.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import type { ClaudeClient } from '../src/claude/client.js';
import type { TradeProposal } from '../src/trading/types.js';

const baseEnv = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'AAPL',
  CLAUDE_MODEL: 'claude-sonnet-4-6',
  DEBATE_BULL_MODEL: 'claude-sonnet-4-6',
  DEBATE_BEAR_MODEL: 'claude-opus-4-7',
  DEBATE_JUDGE_MODEL: 'claude-haiku-4-5-20251001',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => clearConfigCacheForTests());

const proposal: TradeProposal = {
  symbol: 'AAPL',
  side: 'buy',
  notionalUsd: 300,
  signals: {
    technical: { strength: 2, evidence: 'breakout' },
    congress: { strength: 1, evidence: 'cluster' },
    news: { strength: 1, evidence: 'guidance' },
    earnings_proximity: 'clear',
    conflicts: [],
  },
};

/** A scripted client that returns the next response from a queue, recording per-call modelOverride. */
function scriptedClient(queue: Array<{ text: string; model?: string }>): {
  client: ClaudeClient;
  callsByModel: string[];
} {
  const callsByModel: string[] = [];
  const client: ClaudeClient = {
    complete: async ({ modelOverride }) => {
      callsByModel.push(modelOverride ?? '(default)');
      const next = queue.shift();
      if (!next) throw new Error('test queue exhausted');
      return {
        text: next.text,
        model: next.model ?? modelOverride ?? 'claude-sonnet-4-6',
      };
    },
  };
  return { client, callsByModel };
}

describe('debate — single-model mode (iter3 default)', () => {
  it('proceeds when both bull and bear vote proceed', async () => {
    const { client, callsByModel } = scriptedClient([
      { text: '{"decision":"proceed","rationale":"strong"}' },
      { text: '{"decision":"proceed","rationale":"agrees"}' },
    ]);
    const v = await debate({ claude: client, proposal });
    expect(v.decision).toBe('proceed');
    expect(v.models.multiModel).toBe(false);
    // both calls used the default model (no override)
    expect(callsByModel).toEqual(['(default)', '(default)']);
  });

  it('skips when they disagree (bear-wins tiebreaker)', async () => {
    const { client } = scriptedClient([
      { text: '{"decision":"proceed","rationale":"bull"}' },
      { text: '{"decision":"skip","rationale":"bear"}' },
    ]);
    const v = await debate({ claude: client, proposal });
    expect(v.decision).toBe('skip');
    if (v.decision === 'skip') expect(v.reason).toContain('bear case prevailed');
  });
});

describe('debate — multi-model mode (iter4)', () => {
  it('dispatches bull/bear to configured models when DEBATE_MULTI_MODEL_ENABLED=true', async () => {
    const cfg = loadConfig({
      ...baseEnv,
      DEBATE_MULTI_MODEL_ENABLED: 'true',
    } as unknown as NodeJS.ProcessEnv);
    const { client, callsByModel } = scriptedClient([
      { text: '{"decision":"proceed","rationale":"bull-strong"}', model: 'claude-sonnet-4-6' },
      { text: '{"decision":"proceed","rationale":"bear-agrees"}', model: 'claude-opus-4-7' },
    ]);
    const v = await debate({ claude: client, proposal, cfg });
    expect(v.decision).toBe('proceed');
    expect(v.models.multiModel).toBe(true);
    expect(callsByModel).toEqual(['claude-sonnet-4-6', 'claude-opus-4-7']);
    expect(v.models.bull).toBe('claude-sonnet-4-6');
    expect(v.models.bear).toBe('claude-opus-4-7');
    expect(v.models.judge).toBeUndefined(); // no disagreement → no judge
  });

  it('runs the judge call on disagreement and follows its verdict', async () => {
    const cfg = loadConfig({
      ...baseEnv,
      DEBATE_MULTI_MODEL_ENABLED: 'true',
    } as unknown as NodeJS.ProcessEnv);
    const { client, callsByModel } = scriptedClient([
      { text: '{"decision":"proceed","rationale":"bull case"}', model: 'claude-sonnet-4-6' },
      { text: '{"decision":"skip","rationale":"bear case"}', model: 'claude-opus-4-7' },
      { text: '{"decision":"proceed","rationale":"judge picks bull"}', model: 'claude-haiku-4-5-20251001' },
    ]);
    const v = await debate({ claude: client, proposal, cfg });
    expect(v.decision).toBe('proceed');
    expect(callsByModel).toEqual([
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'claude-haiku-4-5-20251001',
    ]);
    expect(v.models.judge).toBe('claude-haiku-4-5-20251001');
  });

  it('judge can also vote skip on disagreement', async () => {
    const cfg = loadConfig({
      ...baseEnv,
      DEBATE_MULTI_MODEL_ENABLED: 'true',
    } as unknown as NodeJS.ProcessEnv);
    const { client } = scriptedClient([
      { text: '{"decision":"proceed","rationale":"bull"}', model: 'claude-sonnet-4-6' },
      { text: '{"decision":"skip","rationale":"bear"}', model: 'claude-opus-4-7' },
      { text: '{"decision":"skip","rationale":"judge sides with bear"}', model: 'claude-haiku-4-5-20251001' },
    ]);
    const v = await debate({ claude: client, proposal, cfg });
    expect(v.decision).toBe('skip');
    if (v.decision === 'skip') expect(v.reason).toContain('judge resolved');
  });
});
