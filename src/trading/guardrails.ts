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
  /**
   * Settled cash available for new buys on a cash account, after subtracting
   * today's unsettled sell proceeds and the configured reserve. Undefined
   * skips the check (margin accounts, paper without the cash-account flag).
   */
  settledCashAvailable?: number;
  /**
   * Which strategy is dispatching this proposal. Drives per-strategy budget
   * enforcement: 'momentum' uses MAX_POSITION_USD; 'dip_recovery' uses
   * DIP_BUDGET_USD. Defaults to 'momentum' for backwards compat.
   */
  strategyTag?: 'momentum' | 'dip_recovery';
  /**
   * Existing exposure (USD) within the *same* strategy bucket, used to
   * prevent dip plays from doubling up. If undefined the guardrail computes
   * exposure across all positions (legacy behavior).
   */
  strategyExistingExposureUsd?: number;
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

  // Position-size cap (existing exposure + this order). Strategy-aware:
  // momentum uses MAX_POSITION_USD per-symbol; dip_recovery uses DIP_BUDGET_USD
  // as a strategy-wide cap (existing exposure passed in by the caller).
  if (proposal.side === 'buy' && clamped.notionalUsd !== undefined) {
    const strategyTag = ctx.strategyTag ?? 'momentum';
    const isDip = strategyTag === 'dip_recovery';
    const existingExposure = isDip
      ? ctx.strategyExistingExposureUsd ?? 0
      : pos
        ? pos.qty * pos.currentPrice
        : 0;
    const cap = isDip ? cfg.DIP_BUDGET_USD : cfg.MAX_POSITION_USD;
    const capName = isDip ? 'DIP_BUDGET_USD' : 'MAX_POSITION_USD';
    const projected = existingExposure + clamped.notionalUsd;
    if (projected > cap) {
      const room = Math.max(0, cap - existingExposure);
      if (room <= 0) {
        return {
          status: 'rejected',
          reason: `${strategyTag} budget reached: existing=${existingExposure.toFixed(0)} >= ${capName}=${cap}`,
        };
      }
      clamped.notionalUsd = room;
      didClamp = true;
    }
  }

  // Settled-cash check (cash-account T+1). Applied last so all clamping has
  // settled and we know the final intended notional.
  if (
    proposal.side === 'buy' &&
    ctx.settledCashAvailable !== undefined &&
    clamped.notionalUsd !== undefined
  ) {
    const ceiling = Math.max(0, ctx.settledCashAvailable - cfg.RESERVE_SETTLED_CASH_USD);
    if (clamped.notionalUsd > ceiling) {
      if (ceiling <= 0) {
        return {
          status: 'rejected',
          reason: `settled cash exhausted: available=${ctx.settledCashAvailable.toFixed(0)} reserve=${cfg.RESERVE_SETTLED_CASH_USD}`,
        };
      }
      clamped.notionalUsd = ceiling;
      didClamp = true;
    }
  }

  // Structured-signal score gate (improvement #3). If a `signals` object is
  // present, demand convergence + zero conflicts. Earnings blackout is enforced
  // via Claude's `earnings_proximity` field as a redundant check (the earnings
  // table is the primary source above).
  if (proposal.side === 'buy' && proposal.signals) {
    const s = proposal.signals;
    const score =
      (s.technical?.strength ?? 0) +
      (s.congress?.strength ?? 0) +
      (s.news?.strength ?? 0);
    if (score < cfg.MIN_SIGNAL_SCORE) {
      return {
        status: 'rejected',
        reason: `signal score ${score} < MIN_SIGNAL_SCORE ${cfg.MIN_SIGNAL_SCORE}`,
      };
    }
    const conflicts = s.conflicts ?? [];
    if (conflicts.length > cfg.MAX_CONFLICTS) {
      return {
        status: 'rejected',
        reason: `conflicts=${conflicts.length} > MAX_CONFLICTS ${cfg.MAX_CONFLICTS}: ${conflicts.slice(0, 3).join('; ')}`,
      };
    }
    if (s.earnings_proximity === 'within_blackout') {
      return {
        status: 'rejected',
        reason: 'earnings_proximity=within_blackout per Claude signals',
      };
    }
  }

  return {
    status: didClamp ? 'clamped' : 'approved',
    clampedProposal: clamped,
  };
}
