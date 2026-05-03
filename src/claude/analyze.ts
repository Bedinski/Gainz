import type { Config } from '../trading/config.js';
import type {
  CongressSignals,
  MarketSnapshot,
  PortfolioSnapshot,
  TradeProposal,
} from '../trading/types.js';
import type { ClaudeClient } from './client.js';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt.js';
import { decisionResponseSchema, extractJson, toCamel } from './schema.js';

export interface AnalyzeArgs {
  cfg: Config;
  claude: ClaudeClient;
  portfolio: PortfolioSnapshot;
  market: MarketSnapshot;
  congress: CongressSignals;
  recentDecisionSummaries: string[];
  nowIso?: string;
}

export interface AnalyzeResult {
  proposals: TradeProposal[];
  rawResponse: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  notes?: string;
  parseError?: string;
}

export async function analyze({
  cfg,
  claude,
  portfolio,
  market,
  congress,
  recentDecisionSummaries,
  nowIso = new Date().toISOString(),
}: AnalyzeArgs): Promise<AnalyzeResult> {
  const userPrompt = buildUserPrompt({
    cfg,
    portfolio,
    market,
    congress,
    recentDecisionSummaries,
    nowIso,
  });

  const response = await claude.complete({ systemPrompt: SYSTEM_PROMPT, userPrompt });

  let proposals: TradeProposal[] = [];
  let notes: string | undefined;
  let parseError: string | undefined;
  try {
    const json = extractJson(response.text);
    const parsed = decisionResponseSchema.parse(json);
    proposals = parsed.proposals.map(toCamel) as TradeProposal[];
    notes = parsed.notes;
  } catch (err) {
    parseError = String(err);
  }

  return {
    proposals,
    rawResponse: response.text,
    model: response.model,
    promptTokens: response.promptTokens,
    completionTokens: response.completionTokens,
    notes,
    parseError,
  };
}
