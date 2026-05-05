import type { Regime, StrategyTag, TradeProposal } from './types.js';

export interface AuditContext {
  strategyTag?: StrategyTag;
  dipEventId?: number;
  dipDrawdownPct?: number;
  dipTargetPrice?: number;
  dipTimeExitAt?: number;
  nowMs?: number;
  // iter4 D3: enriched audit fields. All optional so legacy callers compile.
  regime?: Regime;
  /** Sector tag at entry (matches positions_meta.sector). */
  sector?: string;
  /** 2-sigma daily VaR estimate (USD) computed at the time the proposal was sized. */
  var2SigmaUsd?: number;
  /** Effective stop-loss fraction used for vol sizing (max of stopLossPct/100 and ATR-based). */
  effectiveStopFrac?: number;
  /** True when vol sizing actually clamped down the proposed notional. */
  volSizingClamped?: boolean;
  /** Debate verdict + per-side models (when debate ran). */
  debate?: {
    decision: 'proceed' | 'skip';
    multiModel: boolean;
    bullModel: string;
    bearModel: string;
    judgeModel?: string;
  };
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

  // iter4 D3: enriched suffix carrying the regime, sector, VaR, vol-sizing,
  // and debate-verdict context that the post-mortem and any future ML
  // pipeline want to slice trades by.
  const enrichedParts: string[] = [];
  if (ctx.regime) enrichedParts.push(`regime=${ctx.regime}`);
  if (ctx.sector) enrichedParts.push(`sector=${ctx.sector}`);
  if (ctx.var2SigmaUsd !== undefined) enrichedParts.push(`var2σ=$${ctx.var2SigmaUsd.toFixed(0)}`);
  if (ctx.effectiveStopFrac !== undefined) {
    enrichedParts.push(`stopFrac=${(ctx.effectiveStopFrac * 100).toFixed(2)}%`);
  }
  if (ctx.volSizingClamped) enrichedParts.push(`volClamped`);
  if (ctx.debate) {
    const d = ctx.debate;
    const modelTrace = d.multiModel
      ? `${shortModel(d.bullModel)}|${shortModel(d.bearModel)}${d.judgeModel ? `|${shortModel(d.judgeModel)}` : ''}`
      : shortModel(d.bullModel);
    enrichedParts.push(`debate=${d.decision}(${modelTrace})`);
  }
  const enrichedSuffix = enrichedParts.length ? `; ${enrichedParts.join(' ')}` : '';

  if (tag === 'dip_recovery' && ctx.dipDrawdownPct !== undefined && ctx.dipTargetPrice !== undefined) {
    const now = ctx.nowMs ?? Date.now();
    const daysRemaining =
      ctx.dipTimeExitAt !== undefined
        ? Math.max(0, Math.round((ctx.dipTimeExitAt - now) / (24 * 60 * 60 * 1000)))
        : undefined;
    const tail = `drawdown -${ctx.dipDrawdownPct.toFixed(1)}% | target $${ctx.dipTargetPrice.toFixed(2)}` +
      (daysRemaining !== undefined ? ` | bailout in ${daysRemaining}d` : '');
    return `${base}; ${tail}${enrichedSuffix}`;
  }

  return `${base}${enrichedSuffix}`;
}

function shortModel(m: string): string {
  // 'claude-sonnet-4-6' → 'sonnet-4-6'; 'claude-opus-4-7' → 'opus-4-7'; etc.
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function quote(s: string): string {
  return `"${truncate(s.replace(/"/g, "'"), 60)}"`;
}
