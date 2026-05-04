import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateProposal } from '../src/trading/guardrails.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import type { PortfolioSnapshot, TradeProposal } from '../src/trading/types.js';

const baseEnv = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'AAPL,NVDA',
  MAX_POSITION_USD: '2000',
  MAX_ORDER_USD: '1000',
  MAX_DAILY_LOSS_USD: '500',
  MAX_TRADES_PER_DAY: '10',
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
} as unknown as NodeJS.ProcessEnv;

const portfolio: PortfolioSnapshot = {
  cashUsd: 10000,
  equityUsd: 10000,
  realizedPnlToday: 0,
  tradeCountToday: 0,
  positions: [],
};

beforeEach(() => clearConfigCacheForTests());

const cfg = () => loadConfig(baseEnv);

describe('guardrails', () => {
  it('rejects symbol not in allowlist', () => {
    const out = evaluateProposal(
      { symbol: 'TSLA', side: 'buy', notionalUsd: 500 },
      { cfg: cfg(), portfolio, isHaltedToday: false, tradesToday: 0 },
    );
    expect(out.status).toBe('rejected');
    expect(out.reason).toContain('SYMBOL_ALLOWLIST');
  });

  it('rejects when bot is halted', () => {
    const out = evaluateProposal(
      { symbol: 'AAPL', side: 'buy', notionalUsd: 500 },
      { cfg: cfg(), portfolio, isHaltedToday: true, tradesToday: 0 },
    );
    expect(out.status).toBe('rejected');
  });

  it('rejects sell with no position', () => {
    const out = evaluateProposal(
      { symbol: 'AAPL', side: 'sell' },
      { cfg: cfg(), portfolio, isHaltedToday: false, tradesToday: 0 },
    );
    expect(out.status).toBe('rejected');
    expect(out.reason).toContain('no open long position');
  });

  it('rejects buy in earnings blackout', () => {
    const out = evaluateProposal(
      { symbol: 'AAPL', side: 'buy', notionalUsd: 500 },
      { cfg: cfg(), portfolio, isHaltedToday: false, tradesToday: 0, upcomingEarningsDays: 1 },
    );
    expect(out.status).toBe('rejected');
    expect(out.reason).toContain('earnings');
  });

  it('clamps stop_loss_pct above max', () => {
    const out = evaluateProposal(
      { symbol: 'AAPL', side: 'buy', notionalUsd: 500, stopLossPct: 50 },
      { cfg: cfg(), portfolio, isHaltedToday: false, tradesToday: 0 },
    );
    expect(out.status).toBe('clamped');
    expect(out.clampedProposal?.stopLossPct).toBe(8);
  });

  it('clamps stop_loss_pct below min', () => {
    const out = evaluateProposal(
      { symbol: 'AAPL', side: 'buy', notionalUsd: 500, stopLossPct: 0.5 },
      { cfg: cfg(), portfolio, isHaltedToday: false, tradesToday: 0 },
    );
    expect(out.status).toBe('clamped');
    expect(out.clampedProposal?.stopLossPct).toBe(1.5);
  });

  it('injects defaults when stop fields are missing on a buy', () => {
    const out = evaluateProposal(
      { symbol: 'AAPL', side: 'buy', notionalUsd: 500 } as TradeProposal,
      { cfg: cfg(), portfolio, isHaltedToday: false, tradesToday: 0 },
    );
    expect(out.status).toBe('clamped');
    expect(out.clampedProposal?.stopLossPct).toBe(2.5);
    expect(out.clampedProposal?.trailingStopPct).toBe(3);
    expect(out.clampedProposal?.entryType).toBe('stop');
  });

  it('caps notional at MAX_ORDER_USD', () => {
    const out = evaluateProposal(
      { symbol: 'AAPL', side: 'buy', notionalUsd: 5000, stopLossPct: 2.5, trailingStopPct: 3 },
      { cfg: cfg(), portfolio, isHaltedToday: false, tradesToday: 0 },
    );
    expect(out.status).toBe('clamped');
    expect(out.clampedProposal?.notionalUsd).toBe(1000);
  });

  it('caps notional by remaining position room', () => {
    const out = evaluateProposal(
      { symbol: 'AAPL', side: 'buy', notionalUsd: 1000, stopLossPct: 2.5, trailingStopPct: 3 },
      {
        cfg: cfg(),
        portfolio: {
          ...portfolio,
          positions: [{ symbol: 'AAPL', qty: 10, avgEntryPrice: 150, currentPrice: 180, unrealizedPlPct: 0.2 }],
        },
        isHaltedToday: false,
        tradesToday: 0,
      },
    );
    // existing exposure = 10 * 180 = 1800; room = 200
    expect(out.status).toBe('clamped');
    expect(out.clampedProposal?.notionalUsd).toBe(200);
  });

  it('rejects when position cap already reached', () => {
    const out = evaluateProposal(
      { symbol: 'AAPL', side: 'buy', notionalUsd: 100, stopLossPct: 2.5, trailingStopPct: 3 },
      {
        cfg: cfg(),
        portfolio: {
          ...portfolio,
          positions: [{ symbol: 'AAPL', qty: 20, avgEntryPrice: 100, currentPrice: 200, unrealizedPlPct: 1 }],
        },
        isHaltedToday: false,
        tradesToday: 0,
      },
    );
    expect(out.status).toBe('rejected');
    expect(out.reason).toContain('MAX_POSITION_USD');
  });

  it('rejects when daily-loss kill switch tripped', () => {
    const out = evaluateProposal(
      { symbol: 'AAPL', side: 'buy', notionalUsd: 100 },
      {
        cfg: cfg(),
        portfolio: { ...portfolio, realizedPnlToday: -600 },
        isHaltedToday: false,
        tradesToday: 0,
      },
    );
    expect(out.status).toBe('rejected');
    expect(out.reason).toContain('daily loss');
  });

  it('rejects when trade-count cap hit', () => {
    const out = evaluateProposal(
      { symbol: 'AAPL', side: 'buy', notionalUsd: 100 },
      { cfg: cfg(), portfolio, isHaltedToday: false, tradesToday: 10 },
    );
    expect(out.status).toBe('rejected');
    expect(out.reason).toContain('MAX_TRADES_PER_DAY');
  });

  it('approves a clean proposal', () => {
    const out = evaluateProposal(
      {
        symbol: 'AAPL',
        side: 'buy',
        notionalUsd: 500,
        stopLossPct: 2.5,
        trailingStopPct: 3,
        entryType: 'stop',
      },
      { cfg: cfg(), portfolio, isHaltedToday: false, tradesToday: 0 },
    );
    expect(out.status).toBe('approved');
    expect(out.clampedProposal?.notionalUsd).toBe(500);
  });
});
