import { z } from 'zod';

/**
 * Postel's-law truncator for diagnostic free-text fields. Notes / reasoning /
 * rationale are not load-bearing — when Claude goes chatty past the soft
 * budget, clip rather than reject the whole response. A truncated notes field
 * is still useful for audit; a parse error throws away the proposals too.
 */
const tolerantText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.length > max ? v.slice(0, max) : v),
    z.string().max(max),
  );

const signalEvidenceSchema = z.object({
  strength: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  evidence: tolerantText(800),
});

export const proposalSignalsSchema = z.object({
  technical: signalEvidenceSchema,
  congress: signalEvidenceSchema,
  news: signalEvidenceSchema,
  earnings_proximity: z.enum(['clear', 'within_blackout']),
  conflicts: z.array(tolerantText(500)).max(10).default([]),
});

export const tradeProposalSchema = z.object({
  symbol: z.string().min(1).max(8).transform((s) => s.toUpperCase()),
  side: z.enum(['buy', 'sell']),
  qty: z.number().positive().optional(),
  notional_usd: z.number().positive().optional(),
  entry_type: z.enum(['market', 'stop', 'limit']).optional(),
  entry_trigger_price: z.number().positive().optional(),
  stop_loss_pct: z.number().positive().optional(),
  trailing_stop_pct: z.number().positive().optional(),
  reasoning: tolerantText(1500).optional(),
  signals: proposalSignalsSchema.optional(),
});

export const decisionResponseSchema = z.object({
  proposals: z.array(tradeProposalSchema).max(10),
  notes: tolerantText(2000).optional(),
});

/**
 * Stage-1 shortlist response: just a list of tickers worth deep analysis.
 * Designed cheap — small system prompt, small output budget.
 */
export const shortlistResponseSchema = z.object({
  shortlist: z.array(z.string().min(1).max(8).transform((s) => s.toUpperCase())).max(5),
  notes: tolerantText(2000).optional(),
});

/**
 * Bull/bear/judge debate output.
 */
export const debateResponseSchema = z.object({
  decision: z.enum(['proceed', 'skip']),
  rationale: tolerantText(1500),
});

export type DecisionResponseRaw = z.infer<typeof decisionResponseSchema>;
export type TradeProposalRaw = z.infer<typeof tradeProposalSchema>;
export type ProposalSignalsRaw = z.infer<typeof proposalSignalsSchema>;
export type ShortlistResponseRaw = z.infer<typeof shortlistResponseSchema>;
export type DebateResponseRaw = z.infer<typeof debateResponseSchema>;

export function toCamel(p: TradeProposalRaw) {
  return {
    symbol: p.symbol,
    side: p.side,
    qty: p.qty,
    notionalUsd: p.notional_usd,
    entryType: p.entry_type,
    entryTriggerPrice: p.entry_trigger_price,
    stopLossPct: p.stop_loss_pct,
    trailingStopPct: p.trailing_stop_pct,
    reasoning: p.reasoning,
    signals: p.signals,
  };
}

/**
 * Tolerant JSON parser: Claude sometimes wraps JSON in code fences or adds
 * leading prose. Strip what we can before parsing.
 */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidate = fenced ? fenced[1]! : raw;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('no JSON object found in response');
  }
  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}
