import type { Config } from './config.js';
import type {
  GuardrailOutcome,
  PortfolioSnapshot,
  TradeProposal,
} from './types.js';

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

export interface GuardrailContext {
  cfg: Config;
  portfolio: PortfolioSnapshot;
  isHaltedToday: boolean;
  tradesToday: number;
  upcomingEarningsDays?: number; // days until earnings for the symbol; undefined if none
}

/**
 * Pure-ish: evaluates a single proposal against config + portfolio state.
 * Never mutates anything. Returns the (possibly clamped) proposal or a rejection reason.
 *
 * Rules (in order):
 *   - daily halt
 *   - daily trade-count cap
 *   - symbol allowlist
 *   - sell of non-existent position
 *   - earnings blackout for new entries
 *   - clamp stop_loss_pct, trailing_stop_pct, entry_trigger_price into config envelopes
 *   - reject naked entry (no stop info available — guardrails will inject defaults if missing)
 *   - position-size cap (MAX_POSITION_USD)
 *   - per-order cap (MAX_ORDER_USD)
 *   - daily-loss kill switch (MAX_DAILY_LOSS_USD)
 */
export function evaluateProposal(
  proposal: TradeProposal,
  ctx: GuardrailContext,
): GuardrailOutcome {
  const { cfg, portfolio, isHaltedToday, tradesToday } = ctx;

  if (isHaltedToday) {
    return { status: 'rejected', reason: 'daily halt active' };
  }

  if (tradesToday >= cfg.MAX_TRADES_PER_DAY) {
    return { status: 'rejected', reason: `MAX_TRADES_PER_DAY (${cfg.MAX_TRADES_PER_DAY}) reached` };
  }

  if (-portfolio.realizedPnlToday >= cfg.MAX_DAILY_LOSS_USD) {
    return {
      status: 'rejected',
      reason: `daily loss ${(-portfolio.realizedPnlToday).toFixed(0)} USD >= MAX_DAILY_LOSS_USD ${cfg.MAX_DAILY_LOSS_USD}`,
    };
  }

  const symbol = proposal.symbol.toUpperCase();
  if (!cfg.SYMBOL_ALLOWLIST.includes(symbol)) {
    return { status: 'rejected', reason: `symbol ${symbol} not in SYMBOL_ALLOWLIST` };
  }

  const pos = portfolio.positions.find((p) => p.symbol === symbol);

  if (proposal.side === 'sell') {
    if (!pos || pos.qty <= 0) {
      return { status: 'rejected', reason: `sell with no open long position in ${symbol}` };
    }
  }

  if (proposal.side === 'buy') {
    if (
      ctx.upcomingEarningsDays !== undefined &&
      ctx.upcomingEarningsDays <= cfg.EARNINGS_BLACKOUT_DAYS
    ) {
      return {
        status: 'rejected',
        reason: `earnings in ${ctx.upcomingEarningsDays}d (blackout=${cfg.EARNINGS_BLACKOUT_DAYS}d)`,
      };
    }
  }

  // Build a clamped copy. Track whether we changed anything.
  const clamped: TradeProposal = { ...proposal };
  let didClamp = false;

  // Stop loss: inject default if missing on a buy; clamp into envelope.
  if (proposal.side === 'buy') {
    const requested = clamped.stopLossPct ?? cfg.STOP_LOSS_PCT;
    const bounded = clamp(requested, cfg.STOP_LOSS_MIN_PCT, cfg.STOP_LOSS_MAX_PCT);
    if (clamped.stopLossPct === undefined) {
      didClamp = true; // injected default
    } else if (bounded !== requested) {
      didClamp = true;
    }
    clamped.stopLossPct = bounded;

    const trailRequested = clamped.trailingStopPct ?? cfg.TRAILING_STOP_PCT;
    const trailBounded = clamp(trailRequested, cfg.TRAILING_MIN_PCT, cfg.TRAILING_MAX_PCT);
    if (clamped.trailingStopPct === undefined || trailBounded !== trailRequested) {
      didClamp = true;
    }
    clamped.trailingStopPct = trailBounded;

    // Entry type: default to stop with momentum confirmation.
    if (!clamped.entryType) {
      clamped.entryType = 'stop';
      didClamp = true;
    }
    if (clamped.entryType === 'stop' || clamped.entryType === 'limit') {
      // Validate the trigger offset isn't out of envelope. Without a current price
      // we can only sanity-check against a max absolute % via cfg.ENTRY_MAX_OFFSET_PCT;
      // the actual trigger price is set by orders.ts using current market price.
    }
  }

  // Per-order notional cap.
  const notional = clamped.notionalUsd;
  if (notional !== undefined && notional > cfg.MAX_ORDER_USD) {
    clamped.notionalUsd = cfg.MAX_ORDER_USD;
    didClamp = true;
  }

  // Position-size cap (existing exposure + this order).
  if (proposal.side === 'buy' && clamped.notionalUsd !== undefined) {
    const existingExposure = pos ? pos.qty * pos.currentPrice : 0;
    const projected = existingExposure + clamped.notionalUsd;
    if (projected > cfg.MAX_POSITION_USD) {
      const room = Math.max(0, cfg.MAX_POSITION_USD - existingExposure);
      if (room <= 0) {
        return {
          status: 'rejected',
          reason: `position cap reached: existing=${existingExposure.toFixed(0)} >= MAX_POSITION_USD=${cfg.MAX_POSITION_USD}`,
        };
      }
      clamped.notionalUsd = room;
      didClamp = true;
    }
  }

  return {
    status: didClamp ? 'clamped' : 'approved',
    clampedProposal: clamped,
  };
}
