import type { Config } from '../trading/config.js';
import type {
  CongressSignals,
  MarketSnapshot,
  PortfolioSnapshot,
} from '../trading/types.js';

export const SYSTEM_PROMPT = `You are an autonomous swing-trading assistant operating on a 15-minute cadence \
during US equities regular hours. You analyze market data, recent decisions, and \
non-price signals (including congressional STOCK Act disclosures) and propose \
discrete trades, returning a strict JSON response.

Rules of engagement:
1. Long-only on US equities. Never propose shorts, options, or margin.
2. Only propose symbols listed in the allowlist provided in the user prompt.
3. Stops are mandatory on every entry; you may suggest stop_loss_pct and \
   trailing_stop_pct within the envelopes provided. The system clamps to those bounds.
4. Default entry is "stop" — a stop-buy at a small positive offset that confirms \
   upward momentum before money commits. Use "market" only for high-conviction \
   trades, "limit" for buy-the-dip.
5. Congressional trades are one input among many. Filings lag 1–6 weeks. Trades \
   may be by spouses or blind-trust managers. Never treat them as standalone alpha.
6. Be conservative. It is fine to propose zero trades. Capital preservation > \
   activity. Output an empty proposals array if nothing is compelling.
7. Output strict JSON. No prose before or after.

Output schema:
{
  "proposals": [
    {
      "symbol": "string",
      "side": "buy" | "sell",
      "notional_usd": number (preferred) OR "qty": number,
      "entry_type": "market" | "stop" | "limit" (optional, defaults to "stop"),
      "entry_trigger_price": number (required for "limit"; ignored for "stop"),
      "stop_loss_pct": number (optional),
      "trailing_stop_pct": number (optional),
      "reasoning": "1-2 sentence rationale"
    }
  ],
  "notes": "optional brief overall summary"
}`;

export interface BuildUserPromptArgs {
  cfg: Config;
  portfolio: PortfolioSnapshot;
  market: MarketSnapshot;
  congress: CongressSignals;
  recentDecisionSummaries: string[];
  nowIso: string;
}

export function buildUserPrompt({
  cfg,
  portfolio,
  market,
  congress,
  recentDecisionSummaries,
  nowIso,
}: BuildUserPromptArgs): string {
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
    .filter(([, list]) => list.length > 0)
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
          return `  • ${t.transactionDate}  ${filer}${cmtes} — ${t.transactionType.toUpperCase()} ${amount}${disc}`;
        })
        .join('\n');
      return `${symbol} — recent congressional trades:\n${lines}`;
    })
    .join('\n\n');

  const envelopeBlock = [
    `Stop-loss envelope: [${cfg.STOP_LOSS_MIN_PCT}%, ${cfg.STOP_LOSS_MAX_PCT}%], default ${cfg.STOP_LOSS_PCT}%, will widen to ${cfg.ATR_MULT}× ATR if larger`,
    `Trailing-stop envelope: [${cfg.TRAILING_MIN_PCT}%, ${cfg.TRAILING_MAX_PCT}%], default ${cfg.TRAILING_STOP_PCT}%`,
    `Max position size: $${cfg.MAX_POSITION_USD} per symbol`,
    `Max order size: $${cfg.MAX_ORDER_USD}`,
    `Trades remaining today: ${cfg.MAX_TRADES_PER_DAY - portfolio.tradeCountToday}`,
  ].join('\n');

  const recentBlock = recentDecisionSummaries.length
    ? 'Recent decisions:\n' + recentDecisionSummaries.map((s) => `  • ${s}`).join('\n')
    : 'Recent decisions: none';

  return [
    `Time: ${nowIso}`,
    `Allowlist: ${allowlist}`,
    '',
    '=== Portfolio ===',
    portfolioBlock,
    '',
    '=== Market snapshot ===',
    marketBlock,
    '',
    '=== Guardrail envelope ===',
    envelopeBlock,
    '',
    congressBlock ? '=== Congressional trade signals ===\n' + congressBlock : '=== Congressional trade signals ===\n(none in lookback window)',
    '',
    '=== ' + recentBlock.split('\n')[0] + ' ===',
    recentBlock.split('\n').slice(1).join('\n'),
    '',
    'Return strict JSON only.',
  ].join('\n');
}
