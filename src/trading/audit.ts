import type { StrategyTag, TradeProposal } from './types.js';

export interface AuditContext {
  strategyTag?: StrategyTag;
  dipEventId?: number;
  dipDrawdownPct?: number;
  dipTargetPrice?: number;
  dipTimeExitAt?: number;
  nowMs?: number;
}

/**
 * Composes the one-line decision_audit string surfaced on every order row.
 *
 * Format:
 *   "[momentum] PLTR: technical=2 (breakout, vol +180%), congress=2 (...), news=1 (...), conflicts=[], score=5"
 * Or for dip plays:
 *   "[dip_recovery #42] SPY: ...; drawdown -7.1% | target $516 | bailout in 9d"
 *
 * Pure function — easy to unit-test against fixtures.
 */
export function composeDecisionAudit(p: TradeProposal, ctx: AuditContext = {}): string {
  const tag = ctx.strategyTag ?? 'momentum';
  const tagPrefix = ctx.strategyTag === 'dip_recovery' && ctx.dipEventId
    ? `[dip_recovery #${ctx.dipEventId}] `
    : ctx.strategyTag === 'momentum'
      ? '[momentum] '
      : '';
  const s = p.signals;
  if (!s) {
    return `${tagPrefix}${p.symbol}: ${p.side} (no structured signals; legacy proposal)`;
  }
  const score = s.technical.strength + s.congress.strength + s.news.strength;
  const conflicts = s.conflicts.length === 0 ? '[]' : `[${s.conflicts.map((c) => quote(c)).join(', ')}]`;
  const base = `${tagPrefix}${p.symbol}: technical=${s.technical.strength} (${truncate(s.technical.evidence, 80)}), congress=${s.congress.strength} (${truncate(s.congress.evidence, 80)}), news=${s.news.strength} (${truncate(s.news.evidence, 80)}), conflicts=${conflicts}, score=${score}`;

  if (tag === 'dip_recovery' && ctx.dipDrawdownPct !== undefined && ctx.dipTargetPrice !== undefined) {
    const now = ctx.nowMs ?? Date.now();
    const daysRemaining =
      ctx.dipTimeExitAt !== undefined
        ? Math.max(0, Math.round((ctx.dipTimeExitAt - now) / (24 * 60 * 60 * 1000)))
        : undefined;
    const tail = `drawdown -${ctx.dipDrawdownPct.toFixed(1)}% | target $${ctx.dipTargetPrice.toFixed(2)}` +
      (daysRemaining !== undefined ? ` | bailout in ${daysRemaining}d` : '');
    return `${base}; ${tail}`;
  }

  return base;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function quote(s: string): string {
  return `"${truncate(s.replace(/"/g, "'"), 60)}"`;
}
