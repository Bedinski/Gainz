import type { Config } from '../trading/config.js';
import type {
  CongressSignals,
  MarketSnapshot,
  NewsSignals,
  PortfolioSnapshot,
} from '../trading/types.js';
import type { ClaudeClient } from './client.js';
import { buildUserPrompt, SYSTEM_PROMPT_SHORTLIST } from './prompt.js';
import { extractJson, shortlistResponseSchema } from './schema.js';

export interface ShortlistArgs {
  cfg: Config;
  claude: ClaudeClient;
  portfolio: PortfolioSnapshot;
  market: MarketSnapshot;
  congress: CongressSignals;
  news?: NewsSignals;
  recentDecisionSummaries: string[];
  nowIso: string;
  marketStateLines?: string[];
}

export interface ShortlistResult {
  shortlist: string[]; // tickers, capped to 3 by schema
  rawResponse: string;
  notes?: string;
  parseError?: string;
}

/**
 * Stage-1 broad scan. Cheap call: full snapshot in, list of 0–3 tickers out.
 * No `signals` block, no entry sizing — just "what deserves a closer look."
 */
export async function shortlist({
  cfg,
  claude,
  portfolio,
  market,
  congress,
  news,
  recentDecisionSummaries,
  nowIso,
  marketStateLines,
}: ShortlistArgs): Promise<ShortlistResult> {
  const userPrompt = buildUserPrompt({
    cfg,
    portfolio,
    market,
    congress,
    news,
    recentDecisionSummaries,
    nowIso,
    marketStateLines,
  });
  const response = await claude.complete({
    systemPrompt: SYSTEM_PROMPT_SHORTLIST,
    userPrompt,
  });

  let tickers: string[] = [];
  let notes: string | undefined;
  let parseError: string | undefined;
  try {
    const json = extractJson(response.text);
    const parsed = shortlistResponseSchema.parse(json);
    tickers = parsed.shortlist
      .map((s) => s.toUpperCase())
      .filter((s) => cfg.SYMBOL_ALLOWLIST.includes(s));
    notes = parsed.notes;
  } catch (err) {
    parseError = String(err);
  }

  return {
    shortlist: tickers,
    rawResponse: response.text,
    notes,
    parseError,
  };
}
