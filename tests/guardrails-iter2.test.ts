import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateProposal } from '../src/trading/guardrails.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import type { PortfolioSnapshot, ProposalSignals, TradeProposal } from '../src/trading/types.js';

const baseEnv = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'AAPL,NVDA',
  MAX_POSITION_USD: '400',
  MAX_ORDER_USD: '400',
  MAX_DAILY_LOSS_USD: '60',
  MAX_TRADES_PER_DAY: '4',
  STOP_LOSS_PCT: '2.5',
  STOP_LOSS_MIN_PCT: '1.5',
  STOP_LOSS_MAX_PCT: '8',
  ATR_MULT: '1.5',
  TRAILING_STOP_PCT: '3',
  TRAILING_MIN_PCT: '2',
  TRAILING_MAX_PCT: '8',
  ENTRY_TRIGGER_PCT: '0.3',
  ENTRY_MAX_OFFSET_PCT: '1',
  ENTRY_ORDER_TTL_MIN: '30',
  EARNINGS_BLACKOUT_DAYS: '3',
  RESERVE_SETTLED_CASH_USD: '50',
  MIN_SIGNAL_SCORE: '3',
  MAX_CONFLICTS: '0',
} as unknown as NodeJS.ProcessEnv;

const portfolio: PortfolioSnapshot = {
  cashUsd: 2500,
  equityUsd: 2500,
  realizedPnlToday: 0,
  tradeCountToday: 0,
  positions: [],
};

beforeEach(() => clearConfigCacheForTests());

const cfg = () => loadConfig(baseEnv);

function strongSignals(overrides: Partial<ProposalSignals> = {}): ProposalSignals {
  return {
    technical: { strength: 2, evidence: 'breakout' },
    congress: { strength: 1, evidence: 'cluster of 2' },
    news: { strength: 1, evidence: 'guidance raise' },
    earnings_proximity: 'clear',
    conflicts: [],
    ...overrides,
  };
}

describe('iter2 guardrails — signal score gate', () => {
  it('rejects when signal score < MIN_SIGNAL_SCORE', () => {
    const p: TradeProposal = {
      symbol: 'AAPL',
      side: 'buy',
      notionalUsd: 300,
      stopLossPct: 2.5,
      trailingStopPct: 3,
      signals: strongSignals({
        technical: { strength: 1, evidence: 'mild' },
        congress: { strength: 0, evidence: 'none' },
        news: { strength: 1, evidence: 'one item' },
      }),
    };
    const out = evaluateProposal(p, { cfg: cfg(), portfolio, isHaltedToday: false, tradesToday: 0 });
    expect(out.status).toBe('rejected');
    expect(out.reason).toContain('signal score');
  });

  it('rejects when conflicts > MAX_CONFLICTS', () => {
    const p: TradeProposal = {
      symbol: 'AAPL',
      side: 'buy',
      notionalUsd: 300,
      stopLossPct: 2.5,
      trailingStopPct: 3,
      signals: strongSignals({ conflicts: ['insider selling 3d ago'] }),
    };
    const out = evaluateProposal(p, { cfg: cfg(), portfolio, isHaltedToday: false, tradesToday: 0 });
    expect(out.status).toBe('rejected');
    expect(out.reason).toContain('conflicts');
  });

  it('rejects on within_blackout', () => {
    const p: TradeProposal = {
      symbol: 'AAPL',
      side: 'buy',
      notionalUsd: 300,
      stopLossPct: 2.5,
      trailingStopPct: 3,
      signals: strongSignals({ earnings_proximity: 'within_blackout' }),
    };
    const out = evaluateProposal(p, { cfg: cfg(), portfolio, isHaltedToday: false, tradesToday: 0 });
    expect(out.status).toBe('rejected');
    expect(out.reason).toContain('within_blackout');
  });

  it('approves when score >= MIN_SIGNAL_SCORE and no conflicts', () => {
    const p: TradeProposal = {
      symbol: 'AAPL',
      side: 'buy',
      notionalUsd: 300,
      stopLossPct: 2.5,
      trailingStopPct: 3,
      entryType: 'stop',
      signals: strongSignals(),
    };
    const out = evaluateProposal(p, { cfg: cfg(), portfolio, isHaltedToday: false, tradesToday: 0 });
    expect(out.status).toBe('approved');
  });
});

describe('config — empty-string env handling', () => {
  it('accepts blank TAKE_PROFIT_PCT (.env leaves it empty)', () => {
    const env = { ...baseEnv, TAKE_PROFIT_PCT: '' } as unknown as NodeJS.ProcessEnv;
    expect(() => loadConfig(env)).not.toThrow();
    const c = loadConfig(env);
    expect(c.TAKE_PROFIT_PCT).toBeUndefined();
  });

  it('parses a real TAKE_PROFIT_PCT value when set', () => {
    const env = { ...baseEnv, TAKE_PROFIT_PCT: '5' } as unknown as NodeJS.ProcessEnv;
    const c = loadConfig(env);
    expect(c.TAKE_PROFIT_PCT).toBe(5);
  });
});

describe('iter2 guardrails — settled-cash check (T+1)', () => {
  it('clamps notional to settledCashAvailable - reserve', () => {
    const p: TradeProposal = {
      symbol: 'AAPL',
      side: 'buy',
      notionalUsd: 400,
      stopLossPct: 2.5,
      trailingStopPct: 3,
      entryType: 'stop',
      signals: strongSignals(),
    };
    const out = evaluateProposal(p, {
      cfg: cfg(),
      portfolio,
      isHaltedToday: false,
      tradesToday: 0,
      settledCashAvailable: 200, // reserve 50 -> ceiling 150
    });
    expect(out.status).toBe('clamped');
    expect(out.clampedProposal?.notionalUsd).toBe(150);
  });

  it('rejects when settled cash exhausted', () => {
    const p: TradeProposal = {
      symbol: 'AAPL',
      side: 'buy',
      notionalUsd: 400,
      stopLossPct: 2.5,
      trailingStopPct: 3,
      entryType: 'stop',
      signals: strongSignals(),
    };
    const out = evaluateProposal(p, {
      cfg: cfg(),
      portfolio,
      isHaltedToday: false,
      tradesToday: 0,
      settledCashAvailable: 30, // < reserve 50 -> ceiling 0
    });
    expect(out.status).toBe('rejected');
    expect(out.reason).toContain('settled cash');
  });

  it('skips the check when settledCashAvailable is undefined', () => {
    const p: TradeProposal = {
      symbol: 'AAPL',
      side: 'buy',
      notionalUsd: 300,
      stopLossPct: 2.5,
      trailingStopPct: 3,
      entryType: 'stop',
      signals: strongSignals(),
    };
    const out = evaluateProposal(p, { cfg: cfg(), portfolio, isHaltedToday: false, tradesToday: 0 });
    expect(out.status).toBe('approved');
  });
});
