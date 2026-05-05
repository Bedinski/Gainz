import { z } from 'zod';
import { getRawSqlite } from '../db/client.js';
import { logger } from '../lib/logger.js';
import type { Config } from '../trading/config.js';
import type { ClaudeClient, ToolCallRecord } from './client.js';
import { extractJson } from './schema.js';

/**
 * iter4 B4: daily post-mortem.
 *
 * Once a day (cron in worker.ts at 6pm ET), we ask the model to grade the
 * previous trading day's decisions against the next day's market closes.
 * Output is a markdown summary + a structured JSON list of "lessons" that
 * future iterations can fold into the system prompt or training data.
 *
 * The post-mortem stage runs with `enableMcpTools: true` so the model can
 * pull UW flow / dark pool / congressional context for tickers it wants to
 * dig deeper on. The decision audit (D3) carries enough structured tags
 * that the model can group trades by regime / signal mix / debate verdict
 * without needing to re-pull market data.
 */

const postmortemResponseSchema = z.object({
  summary_md: z.string().min(1).max(50_000),
  lessons: z
    .array(
      z.object({
        category: z.string().max(80),
        observation: z.string().max(1000),
        action: z.string().max(1000).optional(),
      }),
    )
    .max(20)
    .optional(),
});

export type PostmortemLesson = z.infer<typeof postmortemResponseSchema>['lessons'] extends
  | (infer L)[]
  | undefined
  ? L
  : never;

export interface PostmortemResult {
  date: string;
  summaryMd: string;
  lessons?: PostmortemLesson[];
  promptTokens?: number;
  completionTokens?: number;
  toolCalls?: ToolCallRecord[];
  parseError?: string;
  rawResponse: string;
}

interface DecisionRow {
  id: number;
  timestamp: number;
  parsed_proposals_json: string;
  raw_response: string;
}

interface OrderRow {
  symbol: string;
  side: string;
  type: string;
  qty: number;
  notional_usd: number | null;
  status: string;
  filled_avg_price: number | null;
  submitted_at: number;
  filled_at: number | null;
  decision_audit: string | null;
}

const SYSTEM_PROMPT_POSTMORTEM = `You are reviewing a trading bot's decisions from one day, against the
following day's outcomes. Your job is to identify patterns of good and bad
calls — NOT to grade individual trades luckily/unluckily.

For each batch of orders + their decision audits, ask:
  - Did the signal mix (technical/congress/news/options-flow) actually predict?
  - Were the regime and sector tags right? Did the bot under- or over-react?
  - Did the bull/bear/judge debate add value or just delay?
  - Were any vol-clamped trades correct in retrospect (would unclamped have
    been larger losses, or smaller wins)?

Output a JSON object with:
  { "summary_md": "...", "lessons": [{ "category": "...", "observation": "...", "action": "..." }] }

summary_md is a short markdown report (<= 1500 words). lessons is an optional
structured list of takeaways (each <= 200 words). Be specific — name tickers
and exact dates rather than abstract patterns.`;

export async function runPostmortem(
  cfg: Config,
  claude: ClaudeClient,
  date: string, // YYYY-MM-DD of the day being reviewed
  options: { skipPersist?: boolean } = {},
): Promise<PostmortemResult> {
  const db = getRawSqlite();
  const dayStartMs = Date.parse(`${date}T00:00:00Z`);
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;

  const decisions = db
    .prepare(
      `SELECT id, timestamp, parsed_proposals_json, raw_response
       FROM decisions
       WHERE timestamp >= ? AND timestamp < ?
       ORDER BY timestamp ASC`,
    )
    .all(dayStartMs, dayEndMs) as DecisionRow[];

  const orders = db
    .prepare(
      `SELECT symbol, side, type, qty, notional_usd, status, filled_avg_price,
              submitted_at, filled_at, decision_audit
       FROM orders
       WHERE submitted_at >= ? AND submitted_at < ?
       ORDER BY submitted_at ASC`,
    )
    .all(dayStartMs, dayEndMs) as OrderRow[];

  const equityRow = db
    .prepare(
      `SELECT equity_usd FROM equity_history WHERE date = ?
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .get(date) as { equity_usd: number } | undefined;
  const nextDayEquityRow = db
    .prepare(
      `SELECT equity_usd, date FROM equity_history WHERE date > ?
       ORDER BY recorded_at ASC LIMIT 1`,
    )
    .get(date) as { equity_usd: number; date: string } | undefined;

  if (decisions.length === 0 && orders.length === 0) {
    const empty: PostmortemResult = {
      date,
      summaryMd: `No decisions or orders recorded on ${date}.`,
      rawResponse: '',
    };
    if (!options.skipPersist) persistPostmortem(empty);
    return empty;
  }

  const userPrompt = buildPrompt(date, decisions, orders, equityRow?.equity_usd, nextDayEquityRow);
  const response = await claude.complete({
    systemPrompt: SYSTEM_PROMPT_POSTMORTEM,
    userPrompt,
    enableMcpTools: true,
  });

  let summaryMd = response.text;
  let lessons: PostmortemLesson[] | undefined;
  let parseError: string | undefined;
  try {
    const json = extractJson(response.text);
    const parsed = postmortemResponseSchema.parse(json);
    summaryMd = parsed.summary_md;
    lessons = parsed.lessons;
  } catch (err) {
    parseError = String(err);
    logger.warn({ err: parseError, date }, 'postmortem: failed to parse JSON; saving raw text');
  }

  const result: PostmortemResult = {
    date,
    summaryMd,
    lessons,
    promptTokens: response.promptTokens,
    completionTokens: response.completionTokens,
    toolCalls: response.toolCalls,
    parseError,
    rawResponse: response.text,
  };
  if (!options.skipPersist) persistPostmortem(result);
  return result;
}

function buildPrompt(
  date: string,
  decisions: DecisionRow[],
  orders: OrderRow[],
  startEquity: number | undefined,
  nextDayEquity: { equity_usd: number; date: string } | undefined,
): string {
  const orderSummary = orders.length === 0
    ? '(no orders submitted)'
    : orders
        .map(
          (o) =>
            `- ${o.side.toUpperCase()} ${o.symbol} qty=${o.qty} notional=${
              o.notional_usd?.toFixed(0) ?? '-'
            } status=${o.status} filledAvg=${o.filled_avg_price?.toFixed(2) ?? '-'}\n  audit: ${
              o.decision_audit ?? '(none)'
            }`,
        )
        .join('\n');

  const decisionCount = decisions.length;
  const equityChange =
    startEquity !== undefined && nextDayEquity !== undefined
      ? `\nStart-of-day equity: $${startEquity.toFixed(0)}\nNext-day (${
          nextDayEquity.date
        }) equity: $${nextDayEquity.equity_usd.toFixed(0)} (Δ $${(
          nextDayEquity.equity_usd - startEquity
        ).toFixed(0)})`
      : '';

  return [
    `Date under review: ${date}`,
    `Cycles: ${decisionCount}`,
    `Orders: ${orders.length}`,
    equityChange,
    '',
    '== Orders ==',
    orderSummary,
    '',
    `Use the unusualwhales MCP tools to pull next-day price action, options`,
    `flow, or dark-pool prints for any ticker that needs deeper context.`,
    '',
    `Reply with JSON: { "summary_md": "...", "lessons": [...] }.`,
  ].join('\n');
}

function persistPostmortem(r: PostmortemResult): void {
  const db = getRawSqlite();
  db.prepare(
    `INSERT OR REPLACE INTO postmortems (
       date, generated_at, summary_md, lessons_json, prompt_tokens, completion_tokens, tool_call_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.date,
    Date.now(),
    r.summaryMd,
    r.lessons ? JSON.stringify(r.lessons) : null,
    r.promptTokens ?? null,
    r.completionTokens ?? null,
    r.toolCalls?.length ?? 0,
  );
}
