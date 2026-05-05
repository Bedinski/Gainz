import { z } from 'zod';
import { getRawSqlite } from '../db/client.js';
import { logger } from '../lib/logger.js';
import {
  formatMeanSummary,
  formatRateSummary,
  normalCiMean,
  summarizeRate,
} from '../lib/stats.js';
import type { Config } from '../trading/config.js';
import type { ClaudeClient } from './client.js';
import { extractJson } from './schema.js';

/**
 * iter4 B4: daily post-mortem.
 *
 * Once a day (cron in worker.ts at 6pm ET), we ask the model to grade the
 * previous trading day's decisions against the next day's market closes.
 * Output is a markdown summary + a structured JSON list of "lessons" that
 * future iterations can fold into the system prompt or training data.
 *
 * The decision audit (D3) carries enough structured tags that the model can
 * group trades by regime / signal mix / debate verdict from the prompt alone.
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

interface ClosedTradeRow {
  symbol: string;
  buy_price: number | null;
  sell_price: number;
  sell_submitted_at: number;
  buy_submitted_at: number | null;
}

const SYSTEM_PROMPT_POSTMORTEM = `You are reviewing a trading bot's decisions from one day, against the
following day's outcomes. Your job is to identify patterns of good and bad
calls — NOT to grade individual trades luckily/unluckily.

For each batch of orders + their decision audits, ask:
  - Did the signal mix (technical/congress/news) actually predict?
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

  // Closed trades that finished on the day under review: each filled sell paired
  // with the most recent prior filled buy of the same symbol. FIFO-by-time, not
  // qty-aware — a partial scale-out is reported as one trade against the most
  // recent buy. Good enough for aggregate win-rate framing; do not confuse with
  // P&L bookkeeping.
  const closedTrades = db
    .prepare(
      `SELECT s.symbol               AS symbol,
              s.filled_avg_price     AS sell_price,
              s.submitted_at         AS sell_submitted_at,
              (SELECT b.filled_avg_price FROM orders b
                 WHERE b.symbol = s.symbol
                   AND b.side = 'buy'
                   AND b.filled_avg_price IS NOT NULL
                   AND b.submitted_at < s.submitted_at
                 ORDER BY b.submitted_at DESC LIMIT 1) AS buy_price,
              (SELECT b.submitted_at FROM orders b
                 WHERE b.symbol = s.symbol
                   AND b.side = 'buy'
                   AND b.filled_avg_price IS NOT NULL
                   AND b.submitted_at < s.submitted_at
                 ORDER BY b.submitted_at DESC LIMIT 1) AS buy_submitted_at
         FROM orders s
        WHERE s.side = 'sell'
          AND s.filled_avg_price IS NOT NULL
          AND s.submitted_at >= ?
          AND s.submitted_at < ?
        ORDER BY s.submitted_at ASC`,
    )
    .all(dayStartMs, dayEndMs) as ClosedTradeRow[];

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

  const userPrompt = buildPrompt(
    date,
    decisions,
    orders,
    closedTrades,
    equityRow?.equity_usd,
    nextDayEquityRow,
  );
  const response = await claude.complete({
    systemPrompt: SYSTEM_PROMPT_POSTMORTEM,
    userPrompt,
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
  closedTrades: ClosedTradeRow[],
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

  const aggregateBlock = formatAggregatePerformance(closedTrades);

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
    '== Aggregate performance (closed trades on this day) ==',
    aggregateBlock,
    '',
    '== Orders ==',
    orderSummary,
    '',
    `Reply with JSON: { "summary_md": "...", "lessons": [...] }.`,
  ].join('\n');
}

/**
 * Render closed-trade win rate + mean return with confidence intervals so the
 * model treats small samples as directional rather than precise. The aggregate
 * pairs each filled sell with the most recent prior filled buy of the same
 * symbol (FIFO-by-time, not qty-aware) — gross of fees and slippage between
 * the recorded fill prices.
 */
function formatAggregatePerformance(closedTrades: ClosedTradeRow[]): string {
  const pairs = closedTrades.filter(
    (t) => t.buy_price !== null && t.buy_price > 0 && t.sell_price > 0,
  );
  if (pairs.length === 0) {
    return '(no closed trades — nothing exited on this day, or no matching buy entry)';
  }
  const returnsPct = pairs.map((t) => ((t.sell_price - (t.buy_price as number)) / (t.buy_price as number)) * 100);
  const wins = returnsPct.filter((r) => r > 0).length;
  const rate = summarizeRate(wins, returnsPct.length);
  const mean = normalCiMean(returnsPct);
  const lines = [
    `Win rate: ${formatRateSummary(rate)}`,
    mean ? `Per-trade return: ${formatMeanSummary(mean, '%')}` : 'Per-trade return: n/a',
  ];
  if (rate.lowSample) {
    lines.push(
      'NOTE: small sample — the CI is wide. Treat the rate and mean as directional, not as proof of edge or lack thereof.',
    );
  }
  return lines.join('\n');
}

function persistPostmortem(r: PostmortemResult): void {
  const db = getRawSqlite();
  db.prepare(
    `INSERT OR REPLACE INTO postmortems (
       date, generated_at, summary_md, lessons_json, prompt_tokens, completion_tokens
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    r.date,
    Date.now(),
    r.summaryMd,
    r.lessons ? JSON.stringify(r.lessons) : null,
    r.promptTokens ?? null,
    r.completionTokens ?? null,
  );
}
