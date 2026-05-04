import { describe, it, expect } from 'vitest';
import { debate } from '../src/claude/debate.js';
import type { ClaudeClient } from '../src/claude/client.js';
import type { TradeProposal } from '../src/trading/types.js';

function clientReturning(bull: string, bear: string): ClaudeClient {
  let n = 0;
  return {
    async complete() {
      const text = n++ % 2 === 0 ? bull : bear;
      return { text, model: 'test' };
    },
  };
}

const proposal: TradeProposal = {
  symbol: 'PLTR',
  side: 'buy',
  notionalUsd: 300,
  entryType: 'stop',
  stopLossPct: 2.5,
  trailingStopPct: 3,
  signals: {
    technical: { strength: 2, evidence: 'breakout' },
    congress: { strength: 1, evidence: 'one filing' },
    news: { strength: 1, evidence: 'guidance' },
    earnings_proximity: 'clear',
    conflicts: [],
  },
};

describe('debate', () => {
  it('proceeds when both bull and bear vote proceed', async () => {
    const claude = clientReturning(
      JSON.stringify({ decision: 'proceed', rationale: 'strong setup' }),
      JSON.stringify({ decision: 'proceed', rationale: 'risk acceptable' }),
    );
    const out = await debate({ claude, proposal });
    expect(out.decision).toBe('proceed');
  });

  it('skips when both bull and bear vote skip', async () => {
    const claude = clientReturning(
      JSON.stringify({ decision: 'skip', rationale: 'too thin' }),
      JSON.stringify({ decision: 'skip', rationale: 'sector weak' }),
    );
    const out = await debate({ claude, proposal });
    expect(out.decision).toBe('skip');
  });

  it('on disagreement, bear wins (asymmetric tiebreak)', async () => {
    const claude = clientReturning(
      JSON.stringify({ decision: 'proceed', rationale: 'momentum is real' }),
      JSON.stringify({ decision: 'skip', rationale: 'macro headwinds tomorrow' }),
    );
    const out = await debate({ claude, proposal });
    expect(out.decision).toBe('skip');
  });

  it('fail-safes to skip when responses are unparseable', async () => {
    const claude = clientReturning('not json', 'also not json');
    const out = await debate({ claude, proposal });
    expect(out.decision).toBe('skip');
  });
});
