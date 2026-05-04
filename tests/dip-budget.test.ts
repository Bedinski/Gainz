import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateProposal } from '../src/trading/guardrails.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import type { PortfolioSnapshot, ProposalSignals, TradeProposal } from '../src/trading/types.js';

const env = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'SPY,AAPL',
  MAX_POSITION_USD: '400',
  MAX_ORDER_USD: '400',
  MAX_DAILY_LOSS_USD: '60',
  MAX_TRADES_PER_DAY: '4',
  STOP_LOSS_MAX_PCT: '8',
  TRAILING_MAX_PCT: '8',
  ATR_MULT: '1.5',
  STOP_LOSS_PCT: '2.5',
  STOP_LOSS_MIN_PCT: '1.5',
  TRAILING_STOP_PCT: '3',
  TRAILING_MIN_PCT: '2',
  ENTRY_TRIGGER_PCT: '0.3',
  ENTRY_MAX_OFFSET_PCT: '1',
  ENTRY_ORDER_TTL_MIN: '30',
  EARNINGS_BLACKOUT_DAYS: '3',
  RESERVE_SETTLED_CASH_USD: '50',
  MIN_SIGNAL_SCORE: '3',
  MAX_CONFLICTS: '0',
  DIP_BUDGET_USD: '800',
} as unknown as NodeJS.ProcessEnv;

const portfolio: PortfolioSnapshot = {
  cashUsd: 2500,
  equityUsd: 2500,
  realizedPnlToday: 0,
  tradeCountToday: 0,
  positions: [],
};

function strongSignals(): ProposalSignals {
  return {
    technical: { strength: 2, evidence: 'rebound' },
    congress: { strength: 1, evidence: '—' },
    news: { strength: 1, evidence: 'tariff walked back' },
    earnings_proximity: 'clear',
    conflicts: [],
  };
}

beforeEach(() => clearConfigCacheForTests());

describe('strategy-aware budget', () => {
  it('momentum proposal uses MAX_POSITION_USD', () => {
    const cfg = loadConfig(env);
    const p: TradeProposal = {
      symbol: 'AAPL',
      side: 'buy',
      notionalUsd: 500,
      stopLossPct: 2.5,
      trailingStopPct: 3,
      entryType: 'stop',
      signals: strongSignals(),
    };
    const out = evaluateProposal(p, {
      cfg,
      portfolio,
      isHaltedToday: false,
      tradesToday: 0,
      strategyTag: 'momentum',
    });
    expect(out.status).toBe('clamped');
    // Per-order cap is 400 → MAX_ORDER_USD clamps before MAX_POSITION_USD bites.
    expect(out.clampedProposal?.notionalUsd).toBe(400);
  });

  it('dip_recovery proposal uses DIP_BUDGET_USD with strategy-wide existing exposure', () => {
    const cfg = loadConfig(env);
    const p: TradeProposal = {
      symbol: 'SPY',
      side: 'buy',
      notionalUsd: 800,
      stopLossPct: 8,
      trailingStopPct: 8,
      entryType: 'market',
      signals: strongSignals(),
    };
    // Existing dip exposure: 600. Remaining budget: 800 - 600 = 200.
    const out = evaluateProposal(p, {
      cfg,
      portfolio,
      isHaltedToday: false,
      tradesToday: 0,
      strategyTag: 'dip_recovery',
      strategyExistingExposureUsd: 600,
    });
    // First clamp: MAX_ORDER_USD=400. Then dip-budget clamp: 800-600=200.
    expect(out.status).toBe('clamped');
    expect(out.clampedProposal?.notionalUsd).toBe(200);
  });

  it('rejects dip proposal when DIP_BUDGET_USD already exhausted', () => {
    const cfg = loadConfig(env);
    const p: TradeProposal = {
      symbol: 'SPY',
      side: 'buy',
      notionalUsd: 200,
      stopLossPct: 8,
      trailingStopPct: 8,
      entryType: 'market',
      signals: strongSignals(),
    };
    const out = evaluateProposal(p, {
      cfg,
      portfolio,
      isHaltedToday: false,
      tradesToday: 0,
      strategyTag: 'dip_recovery',
      strategyExistingExposureUsd: 800, // already at the budget
    });
    expect(out.status).toBe('rejected');
    expect(out.reason).toContain('DIP_BUDGET_USD');
  });

  it('momentum and dip budgets are independent (high momentum exposure does not block a dip play)', () => {
    const cfg = loadConfig(env);
    const dip: TradeProposal = {
      symbol: 'SPY',
      side: 'buy',
      notionalUsd: 300,
      stopLossPct: 8,
      trailingStopPct: 8,
      entryType: 'market',
      signals: strongSignals(),
    };
    const out = evaluateProposal(dip, {
      cfg,
      portfolio: {
        ...portfolio,
        positions: [{ symbol: 'AAPL', qty: 2, avgEntryPrice: 200, currentPrice: 200, unrealizedPlPct: 0 }],
      },
      isHaltedToday: false,
      tradesToday: 0,
      strategyTag: 'dip_recovery',
      strategyExistingExposureUsd: 0,
    });
    expect(out.status).toBe('approved');
  });
});
