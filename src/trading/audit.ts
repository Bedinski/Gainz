import type { TradeProposal } from './types.js';

/**
 * Composes the one-line decision_audit string surfaced on every order row.
 *
 * Format:
 *   "PLTR: technical=2 (breakout, vol +180%), congress=2 (Pelosi+Schumer cluster), \
 *    news=1 (earnings beat 2d ago), conflicts=[], score=5"
 *
 * Pure function — easy to unit-test against fixtures.
 */
export function composeDecisionAudit(p: TradeProposal): string {
  const s = p.signals;
  if (!s) {
    return `${p.symbol}: ${p.side} (no structured signals; legacy proposal)`;
  }
  const score = s.technical.strength + s.congress.strength + s.news.strength;
  const conflicts = s.conflicts.length === 0 ? '[]' : `[${s.conflicts.map((c) => quote(c)).join(', ')}]`;
  return `${p.symbol}: technical=${s.technical.strength} (${truncate(s.technical.evidence, 80)}), congress=${s.congress.strength} (${truncate(s.congress.evidence, 80)}), news=${s.news.strength} (${truncate(s.news.evidence, 80)}), conflicts=${conflicts}, score=${score}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function quote(s: string): string {
  return `"${truncate(s.replace(/"/g, "'"), 60)}"`;
}
