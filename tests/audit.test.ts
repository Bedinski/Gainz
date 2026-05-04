import { describe, it, expect } from 'vitest';
import { composeDecisionAudit } from '../src/trading/audit.js';
import type { TradeProposal } from '../src/trading/types.js';

describe('composeDecisionAudit', () => {
  it('renders the standard one-line format with score and conflicts=[]', () => {
    const p: TradeProposal = {
      symbol: 'PLTR',
      side: 'buy',
      notionalUsd: 400,
      signals: {
        technical: { strength: 2, evidence: 'breakout above 50d, vol +180%' },
        congress: { strength: 2, evidence: 'Pelosi+Schumer cluster' },
        news: { strength: 1, evidence: 'earnings beat 2d ago' },
        earnings_proximity: 'clear',
        conflicts: [],
      },
    };
    const out = composeDecisionAudit(p);
    expect(out).toContain('PLTR:');
    expect(out).toContain('technical=2');
    expect(out).toContain('congress=2');
    expect(out).toContain('news=1');
    expect(out).toContain('conflicts=[]');
    expect(out).toContain('score=5');
  });

  it('includes conflict strings when present', () => {
    const p: TradeProposal = {
      symbol: 'NVDA',
      side: 'buy',
      notionalUsd: 400,
      signals: {
        technical: { strength: 1, evidence: 'mild uptrend' },
        congress: { strength: 0, evidence: 'no recent filings' },
        news: { strength: 2, evidence: 'positive guidance' },
        earnings_proximity: 'clear',
        conflicts: ['insider selling 3d ago', 'sector rotation away'],
      },
    };
    const out = composeDecisionAudit(p);
    expect(out).toContain('score=3');
    expect(out).toContain('insider selling');
  });

  it('falls back gracefully on missing signals', () => {
    const p: TradeProposal = { symbol: 'AAPL', side: 'buy', notionalUsd: 200 };
    const out = composeDecisionAudit(p);
    expect(out).toContain('AAPL:');
    expect(out).toContain('legacy');
  });

  it('prefixes dip plays with [dip_recovery #N] and trailing dip context', () => {
    const p: TradeProposal = {
      symbol: 'SPY',
      side: 'buy',
      notionalUsd: 800,
      signals: {
        technical: { strength: 2, evidence: '2 rebound bars from $95 trough' },
        congress: { strength: 0, evidence: '—' },
        news: { strength: 2, evidence: 'tariff walked back' },
        earnings_proximity: 'clear',
        conflicts: [],
      },
    };
    const out = composeDecisionAudit(p, {
      strategyTag: 'dip_recovery',
      dipEventId: 42,
      dipDrawdownPct: 7.1,
      dipTargetPrice: 107,
      dipTimeExitAt: Date.now() + 9 * 86_400_000,
      nowMs: Date.now(),
    });
    expect(out).toContain('[dip_recovery #42]');
    expect(out).toContain('drawdown -7.1%');
    expect(out).toContain('target $107.00');
    expect(out).toContain('bailout in 9d');
  });
});
