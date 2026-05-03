import { z } from 'zod';

export const tradeProposalSchema = z.object({
  symbol: z.string().min(1).max(8).transform((s) => s.toUpperCase()),
  side: z.enum(['buy', 'sell']),
  qty: z.number().positive().optional(),
  notional_usd: z.number().positive().optional(),
  entry_type: z.enum(['market', 'stop', 'limit']).optional(),
  entry_trigger_price: z.number().positive().optional(),
  stop_loss_pct: z.number().positive().optional(),
  trailing_stop_pct: z.number().positive().optional(),
  reasoning: z.string().max(500).optional(),
});

export const decisionResponseSchema = z.object({
  proposals: z.array(tradeProposalSchema).max(10),
  notes: z.string().max(2000).optional(),
});

export type DecisionResponseRaw = z.infer<typeof decisionResponseSchema>;
export type TradeProposalRaw = z.infer<typeof tradeProposalSchema>;

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
