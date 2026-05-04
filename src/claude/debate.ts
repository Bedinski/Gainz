import type { ClaudeClient } from './client.js';
import { SYSTEM_PROMPT_DEBATE } from './prompt.js';
import { debateResponseSchema, extractJson } from './schema.js';
import type { TradeProposal } from '../trading/types.js';

export interface DebateArgs {
  claude: ClaudeClient;
  proposal: TradeProposal;
}

export type DebateOutcome =
  | { decision: 'proceed'; bull: string; bear: string }
  | { decision: 'skip'; reason: string; bull: string; bear: string };

/**
 * Bull-vs-bear debate. Two short Claude calls; deterministic tiebreaker.
 *
 * Tiebreak rule: if both calls return 'proceed', proceed. If both return
 * 'skip', skip. If they disagree, the bear wins — at small capital, avoiding
 * a bad trade is worth more than catching one extra good trade.
 */
export async function debate({ claude, proposal }: DebateArgs): Promise<DebateOutcome> {
  const ctx = describeProposal(proposal);

  const [bullRaw, bearRaw] = await Promise.all([
    claude.complete({
      systemPrompt: SYSTEM_PROMPT_DEBATE,
      userPrompt: `Steel-man ENTERING this trade. What is the strongest case for proceeding?\n\n${ctx}`,
    }),
    claude.complete({
      systemPrompt: SYSTEM_PROMPT_DEBATE,
      userPrompt: `Steel-man SKIPPING this trade. What is the strongest case for not entering?\n\n${ctx}`,
    }),
  ]);

  const bull = parseDecision(bullRaw.text);
  const bear = parseDecision(bearRaw.text);

  if (bull.decision === 'proceed' && bear.decision === 'proceed') {
    return { decision: 'proceed', bull: bull.rationale, bear: bear.rationale };
  }
  if (bull.decision === 'skip' && bear.decision === 'skip') {
    return {
      decision: 'skip',
      reason: `both bull and bear voted skip; bull: ${truncate(bull.rationale, 120)}; bear: ${truncate(bear.rationale, 120)}`,
      bull: bull.rationale,
      bear: bear.rationale,
    };
  }
  // disagreement → bear wins (asymmetric: variance reduction at small capital)
  return {
    decision: 'skip',
    reason: `bear case prevailed in tiebreak: ${truncate(bear.rationale, 200)}`,
    bull: bull.rationale,
    bear: bear.rationale,
  };
}

function parseDecision(raw: string): { decision: 'proceed' | 'skip'; rationale: string } {
  try {
    const json = extractJson(raw);
    const parsed = debateResponseSchema.parse(json);
    return parsed;
  } catch {
    // If a side fails to return parseable JSON, fail-safe to 'skip' (the
    // conservative default at small capital).
    return { decision: 'skip', rationale: 'unparseable response — fail-safe skip' };
  }
}

function describeProposal(p: TradeProposal): string {
  const s = p.signals;
  const sigBlock = s
    ? [
        `signals:`,
        `  technical: ${s.technical.strength} — ${s.technical.evidence}`,
        `  congress:  ${s.congress.strength} — ${s.congress.evidence}`,
        `  news:      ${s.news.strength} — ${s.news.evidence}`,
        `  earnings_proximity: ${s.earnings_proximity}`,
        `  conflicts: ${s.conflicts.length === 0 ? '(none)' : s.conflicts.map((c) => `"${c}"`).join('; ')}`,
      ].join('\n')
    : '(no signals)';
  return [
    `Proposal: ${p.side.toUpperCase()} ${p.symbol}`,
    p.notionalUsd !== undefined ? `notional: $${p.notionalUsd.toFixed(0)}` : null,
    p.qty !== undefined ? `qty: ${p.qty}` : null,
    p.entryType ? `entry_type: ${p.entryType}` : null,
    p.stopLossPct !== undefined ? `stop_loss_pct: ${p.stopLossPct}` : null,
    p.trailingStopPct !== undefined ? `trailing_stop_pct: ${p.trailingStopPct}` : null,
    p.reasoning ? `reasoning: ${p.reasoning}` : null,
    sigBlock,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
