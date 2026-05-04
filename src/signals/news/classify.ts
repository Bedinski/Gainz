import { loadConfig, type Config } from '../../trading/config.js';

export type NewsCategory =
  | 'earnings'
  | 'guidance'
  | 'm_and_a'
  | 'regulatory'
  | 'exec_change'
  | 'analyst'
  | 'recap'
  | 'political_shock'
  | 'other';

const ALL_CATEGORIES: NewsCategory[] = [
  'earnings',
  'guidance',
  'm_and_a',
  'regulatory',
  'exec_change',
  'analyst',
  'recap',
  'political_shock',
  'other',
];

/**
 * Heuristic fallback classifier. Used when Claude is unavailable (tests,
 * offline, classifier disabled). Catches the most common patterns without
 * pretending to be smart.
 *
 * Order matters: political_shock checks BEFORE regulatory so a "tariff"
 * headline doesn't get caught by the regulatory bucket.
 */
export function heuristicClassify(input: { headline: string; summary?: string }): NewsCategory {
  const text = `${input.headline} ${input.summary ?? ''}`.toLowerCase();
  if (
    /\btariff|trade war|executive order|sanction|administration|white house|presidential|truth social|rate decision|federal reserve commentary|fomc\b/.test(
      text,
    )
  )
    return 'political_shock';
  if (/\bearnings\b|q[1-4]\b|beats|misses|reports.*profit|reports.*loss|eps\b/.test(text)) return 'earnings';
  if (/guidance|forecast|outlook|raises.*estimates|cuts.*estimates|reaffirms/.test(text)) return 'guidance';
  if (/acquir(es|ed|ing|ition)|merger|takeover|buyout|to buy\b|deal worth/.test(text)) return 'm_and_a';
  if (/sec\b|fda|approves|approval|investigation|fine|settlement|antitrust|doj\b|lawsuit/.test(text)) return 'regulatory';
  if (/ceo|cfo|coo|president|appoints|resigns|steps down|fires?\b|hired?\b/.test(text)) return 'exec_change';
  if (/upgrades?|downgrades?|price target|reiterates|coverage|analyst|raises pt|cuts pt/.test(text)) return 'analyst';
  if (/closes? (up|down|higher|lower)|recap|wraps up|extends gains|extends losses/.test(text)) return 'recap';
  return 'other';
}

let _classifier: HeadlineClassifier | null = null;

export interface HeadlineClassifier {
  classify(input: { headline: string; summary?: string }): Promise<NewsCategory>;
}

/**
 * Lets tests inject a deterministic classifier without spinning up the SDK.
 */
export function setHeadlineClassifier(c: HeadlineClassifier | null): void {
  _classifier = c;
}

/**
 * Default classifier. Tries Claude (Haiku) via the Agent SDK; on any failure
 * falls back to the heuristic. Keeps this layer resilient — a flaky model
 * call shouldn't block the whole pipeline.
 */
export async function classifyHeadline(
  input: { headline: string; summary?: string },
  cfg: Config = loadConfig(),
): Promise<NewsCategory> {
  if (_classifier) return _classifier.classify(input);
  try {
    return await classifyWithClaude(input, cfg);
  } catch {
    return heuristicClassify(input);
  }
}

async function classifyWithClaude(
  input: { headline: string; summary?: string },
  cfg: Config,
): Promise<NewsCategory> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const systemPrompt = `Classify a financial news headline into exactly one category.
Categories:
- political_shock: tariffs, trade war, executive orders, sanctions, administration commentary, Fed rate decisions
- earnings: Q-period results, EPS, beat/miss
- guidance: forward outlook, forecast changes
- m_and_a: acquisitions, mergers, deals
- regulatory: SEC/FDA/DOJ actions, lawsuits, antitrust (NOT broad political/policy headlines — those are political_shock)
- exec_change: CEO/CFO/key executive changes
- analyst: rating changes, price target moves
- recap: daily move recaps, generic commentary
- other: nothing useful for trading

Respond with the single category name only — no prose, no JSON, no formatting.`;
  const text = `Headline: ${input.headline}${input.summary ? `\nSummary: ${input.summary}` : ''}`;
  let combined = '';
  const iterator = query({
    prompt: text,
    options: {
      systemPrompt,
      model: cfg.NEWS_CLASSIFIER_MODEL,
      allowedTools: [],
      maxTurns: 1,
    },
  });
  for await (const message of iterator) {
    const m = message as { message?: { content?: unknown }; content?: unknown };
    const content = m.message?.content ?? m.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && 'text' in block && typeof (block as { text: unknown }).text === 'string') {
          combined += (block as { text: string }).text;
        }
      }
    }
  }
  const tag = combined.trim().toLowerCase().replace(/[^a-z_]/g, '');
  if ((ALL_CATEGORIES as string[]).includes(tag)) return tag as NewsCategory;
  // model returned something unexpected — fall back to heuristic rather than mis-tagging
  return heuristicClassify(input);
}
