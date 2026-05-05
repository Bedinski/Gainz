import type { ClaudeClient } from './client.js';
import { SYSTEM_PROMPT_DEBATE } from './prompt.js';
import { debateResponseSchema, extractJson } from './schema.js';
import type { Config } from '../trading/config.js';
import type { TradeProposal } from '../trading/types.js';

export interface DebateArgs {
  claude: ClaudeClient;
  proposal: TradeProposal;
  /** iter4: when omitted, single-model behavior is preserved (iter3 default). */
  cfg?: Config;
}

export type DebateOutcome =
  | { decision: 'proceed'; bull: string; bear: string; judge?: string; models: DebateModelTrace }
  | { decision: 'skip'; reason: string; bull: string; bear: string; judge?: string; models: DebateModelTrace };

export interface DebateModelTrace {
  bull: string;
  bear: string;
  /** Only populated when the judge ran (i.e. bull/bear disagreed in multi-model mode). */
  judge?: string;
  /** True when DEBATE_MULTI_MODEL_ENABLED dispatched bull + bear to different models. */
  multiModel: boolean;
}

/**
 * Bull-vs-bear debate. Two short Claude calls; deterministic tiebreaker.
 *
 * iter3 single-model mode (default):
 *   bull + bear both run on cfg.CLAUDE_MODEL; if they agree, that wins. On
 *   disagreement, the bear wins (asymmetric — variance reduction at small
 *   capital).
 *
 * iter4 multi-model mode (when cfg.DEBATE_MULTI_MODEL_ENABLED=true):
 *   bull on DEBATE_BULL_MODEL, bear on DEBATE_BEAR_MODEL. If they agree,
 *   that wins. If they disagree, a third "judge" call on DEBATE_JUDGE_MODEL
 *   resolves the tie (rather than the static bear-wins rule). Cheaper net
 *   when bull/bear agree most of the time, more accurate when they don't.
 */
export async function debate({ claude, proposal, cfg }: DebateArgs): Promise<DebateOutcome> {
  const ctx = describeProposal(proposal);
  const multiModel = !!cfg?.DEBATE_MULTI_MODEL_ENABLED;
  const bullModel = cfg?.DEBATE_BULL_MODEL ?? cfg?.CLAUDE_MODEL ?? 'default';
  const bearModel = cfg?.DEBATE_BEAR_MODEL ?? cfg?.CLAUDE_MODEL ?? 'default';
  const judgeModel = cfg?.DEBATE_JUDGE_MODEL ?? cfg?.CLAUDE_MODEL ?? 'default';

  const [bullRaw, bearRaw] = await Promise.all([
    claude.complete({
      systemPrompt: SYSTEM_PROMPT_DEBATE,
      userPrompt: `Steel-man ENTERING this trade. What is the strongest case for proceeding?\n\n${ctx}`,
      modelOverride: multiModel ? bullModel : undefined,
    }),
    claude.complete({
      systemPrompt: SYSTEM_PROMPT_DEBATE,
      userPrompt: `Steel-man SKIPPING this trade. What is the strongest case for not entering?\n\n${ctx}`,
      modelOverride: multiModel ? bearModel : undefined,
    }),
  ]);

  const bull = parseDecision(bullRaw.text);
  const bear = parseDecision(bearRaw.text);
  const models: DebateModelTrace = {
    bull: bullRaw.model,
    bear: bearRaw.model,
    multiModel,
  };

  if (bull.decision === 'proceed' && bear.decision === 'proceed') {
    return { decision: 'proceed', bull: bull.rationale, bear: bear.rationale, models };
  }
  if (bull.decision === 'skip' && bear.decision === 'skip') {
    return {
      decision: 'skip',
      reason: `both bull and bear voted skip; bull: ${truncate(bull.rationale, 120)}; bear: ${truncate(bear.rationale, 120)}`,
      bull: bull.rationale,
      bear: bear.rationale,
      models,
    };
  }

  // Disagreement.
  if (multiModel) {
    // Judge call breaks the tie. Prompted with the bull and bear arguments
    // verbatim so it sees the same evidence the disagreeing models did.
    const judgeRaw = await claude.complete({
      systemPrompt: SYSTEM_PROMPT_DEBATE,
      userPrompt:
        `Two analysts disagree on this proposed trade. Read both arguments and ` +
        `decide which is stronger. Reply with the same JSON shape (decision: ` +
        `"proceed" or "skip", with rationale).\n\n` +
        `=== Bull case ===\n${bull.rationale}\n\n=== Bear case ===\n${bear.rationale}\n\n` +
        `=== Proposal ===\n${ctx}`,
      modelOverride: judgeModel,
    });
    const judge = parseDecision(judgeRaw.text);
    models.judge = judgeRaw.model;
    if (judge.decision === 'proceed') {
      return {
        decision: 'proceed',
        bull: bull.rationale,
        bear: bear.rationale,
        judge: judge.rationale,
        models,
      };
    }
    return {
      decision: 'skip',
      reason: `judge resolved disagreement → skip: ${truncate(judge.rationale, 200)}`,
      bull: bull.rationale,
      bear: bear.rationale,
      judge: judge.rationale,
      models,
    };
  }

  // Single-model mode (iter3 behavior): bear wins on disagreement.
  return {
    decision: 'skip',
    reason: `bear case prevailed in tiebreak: ${truncate(bear.rationale, 200)}`,
    bull: bull.rationale,
    bear: bear.rationale,
    models,
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
