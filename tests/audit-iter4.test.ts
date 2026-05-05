import { describe, it, expect } from 'vitest';
import { composeDecisionAudit } from '../src/trading/audit.js';
import type { TradeProposal } from '../src/trading/types.js';

const proposal: TradeProposal = {
  symbol: 'AAPL',
  side: 'buy',
  notionalUsd: 300,
  signals: {
    technical: { strength: 2, evidence: 'breakout above 50d, vol +120%' },
    congress: { strength: 1, evidence: 'one cluster filing' },
    news: { strength: 1, evidence: 'guidance raise' },
    earnings_proximity: 'clear',
    conflicts: [],
  },
};

describe('composeDecisionAudit — iter4 enriched fields', () => {
  it('adds regime, sector, var, stopFrac, and volClamped suffix when supplied', () => {
    const out = composeDecisionAudit(proposal, {
      strategyTag: 'momentum',
      regime: 'risk_on',
      sector: 'tech',
      var2SigmaUsd: 35,
      effectiveStopFrac: 0.025,
      volSizingClamped: true,
    });
    expect(out).toContain('regime=risk_on');
    expect(out).toContain('sector=tech');
    expect(out).toContain('var2σ=$35');
    expect(out).toContain('stopFrac=2.50%');
    expect(out).toContain('volClamped');
  });

  it('appends a single-model debate trace when single-model debate ran', () => {
    const out = composeDecisionAudit(proposal, {
      strategyTag: 'momentum',
      debate: {
        decision: 'proceed',
        multiModel: false,
        bullModel: 'claude-sonnet-4-6',
        bearModel: 'claude-sonnet-4-6',
      },
    });
    expect(out).toContain('debate=proceed(sonnet-4-6)');
  });

  it('appends a multi-model trace including judge when judge ran', () => {
    const out = composeDecisionAudit(proposal, {
      strategyTag: 'momentum',
      debate: {
        decision: 'skip',
        multiModel: true,
        bullModel: 'claude-sonnet-4-6',
        bearModel: 'claude-opus-4-7',
        judgeModel: 'claude-haiku-4-5-20251001',
      },
    });
    expect(out).toContain('debate=skip(sonnet-4-6|opus-4-7|haiku-4-5)');
  });

  it('preserves dip_recovery suffix and adds enriched suffix after it', () => {
    const out = composeDecisionAudit(proposal, {
      strategyTag: 'dip_recovery',
      dipEventId: 7,
      dipDrawdownPct: 6.2,
      dipTargetPrice: 478.5,
      dipTimeExitAt: Date.now() + 5 * 24 * 60 * 60 * 1000,
      regime: 'chop',
      sector: 'tech',
    });
    expect(out).toMatch(/\[dip_recovery #7\]/);
    expect(out).toContain('drawdown -6.2%');
    expect(out).toContain('regime=chop');
    expect(out).toContain('sector=tech');
  });

  it('returns the legacy line unchanged when no iter4 fields supplied', () => {
    const out = composeDecisionAudit(proposal, { strategyTag: 'momentum' });
    expect(out).not.toContain('regime=');
    expect(out).not.toContain('sector=');
    expect(out).not.toContain('debate=');
  });
});
