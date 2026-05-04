import { z } from 'zod';
import type { Config } from '../../trading/config.js';
import type {
  DipEntryProposal,
  DipEvent,
  MarketSnapshotEntry,
  NewsSignals,
  PortfolioSnapshot,
} from '../../trading/types.js';
import type { ClaudeClient } from '../../claude/client.js';
import { extractJson, proposalSignalsSchema } from '../../claude/schema.js';
import { buildDipUserPrompt, SYSTEM_PROMPT_DIP_RECOVERY } from './prompt.js';
import type { DrawdownReading } from './detector.js';

export const dipResponseSchema = z.object({
  decision: z.enum(['enter', 'wait']),
  symbol: z.string().min(1).max(8).transform((s) => s.toUpperCase()),
  notional_usd: z.number().positive().optional(),
  reasoning: z.string().max(1000).optional(),
  signals: proposalSignalsSchema.optional(),
});

export type DipResponseRaw = z.infer<typeof dipResponseSchema>;

export interface AnalyzeDipArgs {
  cfg: Config;
  claude: ClaudeClient;
  portfolio: PortfolioSnapshot;
  event: DipEvent;
  drawdown: DrawdownReading;
  marketEntry: MarketSnapshotEntry;
  news?: NewsSignals;
  nowIso: string;
}

export interface AnalyzeDipResult {
  proposal?: DipEntryProposal;
  rawResponse: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  parseError?: string;
}

/**
 * Single Claude call that decides whether to enter a specific active dip event.
 * No shortlist step — the deterministic detector already gated this call.
 */
export async function analyzeDip({
  cfg,
  claude,
  portfolio,
  event,
  drawdown,
  marketEntry,
  news,
  nowIso,
}: AnalyzeDipArgs): Promise<AnalyzeDipResult> {
  const userPrompt = buildDipUserPrompt({ cfg, portfolio, event, drawdown, marketEntry, news, nowIso });
  const response = await claude.complete({
    systemPrompt: SYSTEM_PROMPT_DIP_RECOVERY,
    userPrompt,
  });

  let proposal: DipEntryProposal | undefined;
  let parseError: string | undefined;
  try {
    const json = extractJson(response.text);
    const parsed = dipResponseSchema.parse(json);
    proposal = {
      symbol: parsed.symbol,
      decision: parsed.decision,
      notionalUsd: parsed.notional_usd,
      reasoning: parsed.reasoning,
      signals: parsed.signals,
    };
  } catch (err) {
    parseError = String(err);
  }

  return {
    proposal,
    rawResponse: response.text,
    model: response.model,
    promptTokens: response.promptTokens,
    completionTokens: response.completionTokens,
    parseError,
  };
}
