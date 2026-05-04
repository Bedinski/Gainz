import type { Config } from '../../trading/config.js';
import type { DipEvent, MarketSnapshotEntry, NewsSignals, PortfolioSnapshot } from '../../trading/types.js';
import type { DrawdownReading } from './detector.js';
import { formatDrawdownLine } from './detector.js';

/**
 * Stable system prompt for the dip-recovery strategy. Short, focused, separate
 * from the momentum prompt — the two strategies have opposite entry semantics
 * and mixing their reasoning in one prompt was historically worse than
 * dedicated calls (see iter3 plan). Cache-friendly: nothing here changes
 * between cycles.
 */
export const SYSTEM_PROMPT_DIP_RECOVERY = `You are an autonomous swing-trading assistant operating ONE specific strategy: \
TACO-trade dip-recovery on a major US index ETF (SPY or QQQ).

Background: during 2025-2026 a recurring pattern emerged where the administration \
announced aggressive policy moves (tariffs, sanctions, broad executive orders), \
indices sold off 4-12% over a few days, the policy got walked back / paused / \
softened, and indices recovered to flat-or-higher within ~1-2 weeks. Robert \
Armstrong (FT, May 2025) named this the "TACO trade".

Rules of engagement:
1. Long-only. The system has already detected an active dip event meeting the \
   drawdown threshold AND confirmed the rebound (≥ N consecutive higher closes \
   since trough). Your job is the FINAL judgment call: enter, or wait one more \
   bar.
2. Be conservative. The default action when uncertain is "wait" — the system \
   will offer the trade again next cycle if the setup persists.
3. The position will be exited deterministically by the system: target-price \
   (recovery hits configured retrace fraction) OR time-bailout (configured \
   recovery window expires). You do NOT propose stops or take-profit; those \
   are handled by the strategy module.
4. Output the structured "signals" block with the SAME schema as the momentum \
   strategy. The deterministic gate (MIN_SIGNAL_SCORE / MAX_CONFLICTS) applies.
5. If you decide to enter, suggest a notional_usd within the budget you are \
   given. The system will clamp.

Output strict JSON only:
{
  "decision": "enter" | "wait",
  "symbol": "SPY" | "QQQ",
  "notional_usd": number (only on enter),
  "reasoning": "1-3 sentence rationale",
  "signals": {
    "technical": { "strength": 0|1|2, "evidence": "..." },
    "congress":  { "strength": 0|1|2, "evidence": "..." },
    "news":      { "strength": 0|1|2, "evidence": "..." },
    "earnings_proximity": "clear" | "within_blackout",
    "conflicts": ["..."]
  }
}

For the dip strategy, "technical" should reflect the rebound quality (number \
of consecutive higher closes, distance from trough, volume on rebound bars). \
"news" should reflect whether the political shock has been WALKED BACK / \
softened (a signal the recovery thesis is intact), or whether escalation \
continues (a conflict). "congress" is usually 0 for index plays unless cluster \
buys are visible.

No prose before or after the JSON.`;

export interface BuildDipUserPromptArgs {
  cfg: Config;
  portfolio: PortfolioSnapshot;
  event: DipEvent;
  drawdown: DrawdownReading;
  marketEntry: MarketSnapshotEntry;
  news?: NewsSignals;
  nowIso: string;
}

export function buildDipUserPrompt({
  cfg,
  portfolio,
  event,
  drawdown,
  marketEntry,
  news,
  nowIso,
}: BuildDipUserPromptArgs): string {
  const last10 = marketEntry.bars.slice(-10);
  const series = last10
    .map(
      (b) =>
        `${b.t.slice(0, 10)} O${b.open.toFixed(2)} H${b.high.toFixed(2)} L${b.low.toFixed(2)} C${b.close.toFixed(2)} V${b.volume.toLocaleString()}`,
    )
    .join('\n  ');

  const eventBlock = [
    `Symbol: ${event.symbol}`,
    `Detected: ${new Date(event.detectedAt).toISOString().slice(0, 10)}`,
    `Peak: $${event.peakPrice.toFixed(2)} on ${event.peakDate}`,
    `Trough: $${event.troughPrice.toFixed(2)} on ${event.troughDate}`,
    `Drawdown: -${event.drawdownPct.toFixed(1)}%`,
    `Recovery target: $${event.recoveryTargetPrice.toFixed(2)} (${(cfg.DIP_TARGET_RECOVERY_PCT * 100).toFixed(0)}% retrace)`,
    `Bailout deadline: ${new Date(event.expiresAt).toISOString().slice(0, 10)}`,
    `Current rebound: ${drawdown.reboundBars} consecutive higher closes since trough; ${drawdown.daysSinceTrough}d since trough`,
  ].join('\n');

  const newsBlock = news?.[event.symbol]?.length
    ? news[event.symbol]!
        .slice(0, cfg.NEWS_MAX_ITEMS_PER_SYMBOL)
        .map((n) => {
          const t = new Date(n.publishedAt).toISOString().slice(0, 16).replace('T', ' ');
          return `  • ${t}  [${n.category}]  ${n.headline}  (${n.source})`;
        })
        .join('\n')
    : '(no news in lookback)';

  return [
    `Time: ${nowIso}`,
    '',
    '=== Active dip event ===',
    eventBlock,
    '',
    '=== Index price action (last 10 bars) ===',
    `  ${series}`,
    `  ${formatDrawdownLine(event.symbol, drawdown)}`,
    '',
    `=== News for ${event.symbol} (last ${cfg.NEWS_LOOKBACK_HOURS}h) ===`,
    newsBlock,
    '',
    '=== Strategy budget ===',
    `Available for this dip play: $${cfg.DIP_BUDGET_USD}`,
    `Portfolio cash: $${portfolio.cashUsd.toFixed(0)}`,
    `Signal score gate: MIN_SIGNAL_SCORE=${cfg.MIN_SIGNAL_SCORE}, MAX_CONFLICTS=${cfg.MAX_CONFLICTS}`,
    '',
    'Decide: ENTER now, or WAIT for another rebound bar? Return strict JSON only.',
  ].join('\n');
}
