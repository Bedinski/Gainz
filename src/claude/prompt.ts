import { isLowSample } from '../lib/stats.js';
import type { Config } from '../trading/config.js';
import type {
  CongressSignals,
  MarketSnapshot,
  NewsSignals,
  PortfolioSnapshot,
} from '../trading/types.js';

/**
 * The system prompt is the cache-friendly *stable* prefix. It must not embed
 * any data that changes between cycles — those go into the user prompt only.
 * Cache hits on this prefix cut effective token use materially over a full
 * trading day.
 */
export const SYSTEM_PROMPT_STABLE = `You are an autonomous swing-trading assistant operating on a 15-minute cadence \
during US equities regular hours. You analyze market data and signal-bearing \
inputs (filtered congressional STOCK Act disclosures, classified news) and \
propose discrete trades, returning strict JSON.

Rules of engagement:
1. Long-only on US equities. Never propose shorts, options, or margin.
2. Only propose symbols listed in the allowlist provided in the user prompt.
3. Stops are mandatory on every entry. You may suggest stop_loss_pct and \
   trailing_stop_pct within the envelopes provided. The system clamps to those bounds.
4. Entry-type discipline. Pick deliberately per setup, not by default:
   - "market" — HIGH-CONVICTION ongoing breakouts. Use when signal score ≥ 4 \
     AND conflicts = 0 AND price is mid-breakout with no intraday reversal \
     candle / exhaustion pattern. The thesis is: this move is happening NOW, \
     waiting +0.3% pays a confirmation tax on evidence I already have. Stop-\
     entries miss gap-ups by filling at the gap price, not the trigger.
   - "stop" — MEDIUM-CONVICTION setups (default for the unsure case). Use \
     when score ≥ 3 but you want the market to confirm before money commits. \
     The +0.3% trigger filters out fake breakouts that reverse before \
     triggering. Pay the small confirmation premium for the right to be \
     wrong cheaply.
   - "limit" — BUY-THE-DIP setups. entry_trigger_price BELOW current to catch \
     a pullback to support. Don't use this just to "save a few cents" on \
     a momentum trade — that's a different setup entirely.
5. Congressional and news signals are ALREADY pre-filtered by the system. \
   Filings shown are the politician's own trades, recent (≤14d), ≥$50K range, \
   and either committee-fit or part of a 2+ filer cluster. News headlines shown \
   are the signal-bearing categories (earnings, guidance, M&A, regulatory, \
   exec changes). You don't need to re-filter for noise.
6. Be conservative. The cash-account phase is small ($2–3K). It is fine — and \
   correct — to propose ZERO trades when no signal converges. Capital \
   preservation > activity.
7. Each signal block carries an [n=X] count and a LOW_SAMPLE tag when count \
   is below 6. LOW_SAMPLE means the signal is directional but not statistically \
   distinguishable from noise — treat it as supporting evidence at most, never as \
   the deciding factor. A buy proposal whose only positive signal is LOW_SAMPLE \
   should be rare and explicitly justified in the reasoning field.

Structured signal block (REQUIRED on every buy proposal):
You MUST populate a "signals" object on every buy. Score each independent \
source 0/1/2:
  - 0 = neutral or no signal
  - 1 = mild positive bias
  - 2 = strong positive bias

Sources:
  - technical: price action, momentum, breakout, volume — derived from bars
  - congress:  recent filtered congressional buys for the symbol
  - news:      signal-bearing headlines for the symbol

Also include:
  - earnings_proximity: "clear" or "within_blackout" (use "within_blackout" if earnings ≤3d)
  - conflicts: array of strings naming any contradicting signals you noticed \
    (insider selling, sector rotation away, deteriorating breadth, etc.). If \
    none, use [].

The system applies a deterministic gate AFTER your output:
  - score = technical.strength + congress.strength + news.strength
  - score < MIN_SIGNAL_SCORE → trade rejected
  - conflicts.length > MAX_CONFLICTS → trade rejected
  - earnings_proximity === "within_blackout" → trade rejected

Be honest about strengths and conflicts. The audit string surfaces your \
reasoning to the operator, so populate "evidence" with concrete observations \
(numbers, dates, names), not generic prose.

Output schema:
{
  "proposals": [
    {
      "symbol": "string",
      "side": "buy" | "sell",
      "notional_usd": number (preferred) OR "qty": number,
      "entry_type": "market" | "stop" | "limit" (optional, default "stop"),
      "entry_trigger_price": number (required for "limit"),
      "stop_loss_pct": number (optional),
      "trailing_stop_pct": number (optional),
      "reasoning": "1-2 sentence rationale",
      "signals": {
        "technical": { "strength": 0|1|2, "evidence": "..." },
        "congress":  { "strength": 0|1|2, "evidence": "..." },
        "news":      { "strength": 0|1|2, "evidence": "..." },
        "earnings_proximity": "clear" | "within_blackout",
        "conflicts": ["..."]
      }
    }
  ],
  "notes": "optional brief overall summary"
}

Output strict JSON. No prose before or after.`;

/**
 * Stage-1 (shortlist) system prompt. Cheap broad scan returning at most 5
 * tickers worth deep analysis.
 */
export const SYSTEM_PROMPT_SHORTLIST = `You are a stage-1 trade-screening assistant. \
You see all allowlist symbols' market data and pre-filtered signals. Return \
the 0–5 tickers most worth a deep analysis call this cycle. Most cycles should \
return 0–2 tickers; 5 is a hard cap. Use the higher end of the range only when \
multiple independent setups genuinely converge — do NOT pad the list to look busy.

A ticker is worth shortlisting only if multiple independent signals appear to \
align (technical setup + congress filing OR signal-bearing news, etc.). \
Generic momentum alone is NOT enough — there must be a reason to pay attention \
beyond price.

Output strict JSON only. Keep "notes" under 500 characters — this is a stage-1 \
screen, not a writeup. Concrete tickers + one-liner rationales only.
{
  "shortlist": ["TICKER1", "TICKER2"],
  "notes": "brief reasoning, <= 500 chars"
}`;

/**
 * Bull/bear debate system prompt. The same prefix is reused for both calls;
 * only the user prompt differs ("steel-man entering" vs "steel-man skipping").
 */
export const SYSTEM_PROMPT_DEBATE = `You are a debate participant evaluating a \
specific trade proposal. You will be asked to steel-man one side. Be specific, \
cite numbers from the proposal's signals, and avoid generic platitudes.

Output strict JSON only:
{
  "decision": "proceed" | "skip",
  "rationale": "your case in 2-4 sentences, citing concrete evidence"
}

When playing the bull, lean toward "proceed" but respect material conflicts. \
When playing the bear, lean toward "skip" if any conflict materially undercuts \
the bull case. The judge step that aggregates these calls is deterministic.`;

export interface BuildUserPromptArgs {
  cfg: Config;
  portfolio: PortfolioSnapshot;
  market: MarketSnapshot;
  congress: CongressSignals;
  news?: NewsSignals;
  recentDecisionSummaries: string[];
  nowIso: string;
  /**
   * If provided, narrows market/news/congress blocks to this ticker only.
   * Used by stage-2 deep analysis on shortlisted tickers.
   */
  focusSymbol?: string;
  /**
   * Pre-formatted "Market state" lines surfacing broad-index drawdowns
   * (e.g. SPY/QQQ peak-to-trough). Empty array → block is omitted.
   */
  marketStateLines?: string[];
}

/**
 * Builds the dynamic (uncached) user prompt. All per-cycle data lives here.
 *
 * The structure is intentionally regular so cache lookups can hit cleanly
 * — any cross-cycle drift comes from this block, not the system prefix.
 */
export function buildUserPrompt({
  cfg,
  portfolio,
  market,
  congress,
  news,
  recentDecisionSummaries,
  nowIso,
  focusSymbol,
  marketStateLines,
}: BuildUserPromptArgs): string {
  const focusFilter = focusSymbol?.toUpperCase();
  const inFocus = (s: string) => !focusFilter || s.toUpperCase() === focusFilter;
  const allowlist = cfg.SYMBOL_ALLOWLIST.join(', ');

  const portfolioBlock = [
    `Cash: $${portfolio.cashUsd.toFixed(0)}    Equity: $${portfolio.equityUsd.toFixed(0)}`,
    `Realized P&L today: $${portfolio.realizedPnlToday.toFixed(0)}    Trades today: ${portfolio.tradeCountToday}/${cfg.MAX_TRADES_PER_DAY}`,
    portfolio.positions.length
      ? 'Open positions:\n' +
        portfolio.positions
          .map(
            (p) =>
              `  ${p.symbol}  qty=${p.qty}  entry=$${p.avgEntryPrice.toFixed(2)}  current=$${p.currentPrice.toFixed(2)}  ulPL=${(p.unrealizedPlPct * 100).toFixed(2)}%`,
          )
          .join('\n')
      : 'Open positions: none',
  ].join('\n');

  const marketBlock = Object.values(market)
    .filter((m) => inFocus(m.symbol))
    .map((m) => {
      const last5 = m.bars.slice(-5);
      const series = last5
        .map(
          (b) =>
            `${b.t.slice(0, 10)} O${b.open.toFixed(2)} H${b.high.toFixed(2)} L${b.low.toFixed(2)} C${b.close.toFixed(2)}`,
        )
        .join(' | ');
      return `${m.symbol}  last=$${m.latestPrice.toFixed(2)}  ATR(14)=${m.atr14.toFixed(2)}\n  recent: ${series}`;
    })
    .join('\n');

  const congressBlock = Object.entries(congress)
    .filter(([sym, list]) => inFocus(sym) && list.length > 0)
    .map(([symbol, list]) => {
      const lines = list
        .slice(0, cfg.CONGRESS_MAX_TRADES_PER_SYMBOL)
        .map((t) => {
          const amount =
            t.amountMinUsd && t.amountMaxUsd
              ? `$${t.amountMinUsd.toLocaleString()}–$${t.amountMaxUsd.toLocaleString()}`
              : 'amount unknown';
          const filer = [
            t.filerName,
            t.filerChamber === 'senate' ? 'Sen.' : t.filerChamber === 'house' ? 'Rep.' : '',
            t.filerParty && t.filerState ? `(${t.filerParty}-${t.filerState})` : '',
          ]
            .filter(Boolean)
            .join(' ');
          const cmtes = t.filerCommittees?.length ? ` [${t.filerCommittees.join(', ')}]` : '';
          const disc = t.disclosureDate ? ` (disclosed ${t.disclosureDate})` : '';
          const tags: string[] = [];
          if (t.committeeFitBoost) tags.push('committee_fit');
          if ((t.clusterSize ?? 1) >= 2) tags.push(`cluster=${t.clusterSize}`);
          const tagStr = tags.length ? `  [${tags.join(', ')}]` : '';
          return `  • ${t.transactionDate}  ${filer}${cmtes} — ${t.transactionType.toUpperCase()} ${amount}${disc}${tagStr}`;
        })
        .join('\n');
      const sampleTag = isLowSample(list.length) ? ` [n=${list.length}, LOW_SAMPLE]` : ` [n=${list.length}]`;
      return `${symbol} — recent congressional trades (filtered, last ${cfg.CONGRESS_MAX_AGE_DAYS}d)${sampleTag}:\n${lines}`;
    })
    .join('\n\n');

  const newsBlock = news
    ? Object.entries(news)
        .filter(([sym, list]) => inFocus(sym) && list.length > 0)
        .map(([symbol, list]) => {
          const lines = list
            .slice(0, cfg.NEWS_MAX_ITEMS_PER_SYMBOL)
            .map((n) => {
              const t = new Date(n.publishedAt).toISOString().slice(0, 16).replace('T', ' ');
              return `  • ${t}  [${n.category}]  ${n.headline}  (${n.source})`;
            })
            .join('\n');
          const sampleTag = isLowSample(list.length) ? ` [n=${list.length}, LOW_SAMPLE]` : ` [n=${list.length}]`;
          return `${symbol} — recent news (last ${cfg.NEWS_LOOKBACK_HOURS}h, signal-bearing only)${sampleTag}:\n${lines}`;
        })
        .join('\n\n')
    : '';

  const envelopeBlock = [
    `Stop-loss envelope: [${cfg.STOP_LOSS_MIN_PCT}%, ${cfg.STOP_LOSS_MAX_PCT}%], default ${cfg.STOP_LOSS_PCT}%, will widen to ${cfg.ATR_MULT}× ATR if larger`,
    `Trailing-stop envelope: [${cfg.TRAILING_MIN_PCT}%, ${cfg.TRAILING_MAX_PCT}%], default ${cfg.TRAILING_STOP_PCT}%`,
    `Max position size: $${cfg.MAX_POSITION_USD} per symbol`,
    `Max order size: $${cfg.MAX_ORDER_USD}`,
    `Trades remaining today: ${cfg.MAX_TRADES_PER_DAY - portfolio.tradeCountToday}`,
    `Signal score gate: MIN_SIGNAL_SCORE=${cfg.MIN_SIGNAL_SCORE}, MAX_CONFLICTS=${cfg.MAX_CONFLICTS}`,
  ].join('\n');

  const recentBlock = recentDecisionSummaries.length
    ? 'Recent decisions:\n' + recentDecisionSummaries.map((s) => `  • ${s}`).join('\n')
    : 'Recent decisions: none';

  const sections = [
    `Time: ${nowIso}`,
    `Allowlist: ${allowlist}`,
    focusSymbol ? `Focus: ${focusSymbol.toUpperCase()} (deep analysis)` : null,
    '',
    '=== Portfolio ===',
    portfolioBlock,
    '',
    '=== Market snapshot ===',
    marketBlock || '(no symbols in scope)',
    '',
    marketStateLines && marketStateLines.length > 0
      ? '=== Market state (broad-index drawdowns) ===\n' + marketStateLines.map((l) => `  ${l}`).join('\n')
      : null,
    marketStateLines && marketStateLines.length > 0 ? '' : null,
    '=== Guardrail envelope ===',
    envelopeBlock,
    '',
    congressBlock
      ? '=== Congressional trade signals (filtered) ===\n' + congressBlock
      : '=== Congressional trade signals (filtered) ===\n(none in lookback window)',
    '',
    newsBlock
      ? '=== News signals (classified) ===\n' + newsBlock
      : '=== News signals (classified) ===\n(none in lookback window)',
    '',
    '=== ' + recentBlock.split('\n')[0] + ' ===',
    recentBlock.split('\n').slice(1).join('\n'),
    '',
    'Return strict JSON only.',
  ].filter((s): s is string => s !== null);

  return sections.join('\n');
}

/** Backwards-compat re-export name used by analyze.ts */
export const SYSTEM_PROMPT = SYSTEM_PROMPT_STABLE;
