import { getRawSqlite } from '../db/client.js';
import { loadConfig, type Config } from './config.js';
import { evaluateProposal } from './guardrails.js';
import { planManagement, type ManagedPosition } from './manage.js';
import { daysUntilEarnings } from './earnings.js';
import { composeDecisionAudit } from './audit.js';
import { logger } from '../lib/logger.js';
import type { AlpacaClient } from '../alpaca/client.js';
import { fetchMarketSnapshot, fetchPortfolioSnapshot } from '../alpaca/market.js';
import { executeOrder } from '../alpaca/orders.js';
import type { ClaudeClient } from '../claude/client.js';
import { analyze } from '../claude/analyze.js';
import { shortlist } from '../claude/shortlist.js';
import { debate } from '../claude/debate.js';
import { loadCongressSignals } from '../signals/congress/query.js';
import { loadNewsSignals } from '../signals/news/query.js';
import { refreshAlpacaNews } from '../signals/news/alpaca.js';
import type { TradeProposal } from './types.js';

export interface CycleDeps {
  cfg?: Config;
  alpaca: AlpacaClient;
  claude: ClaudeClient;
  now?: () => Date;
  /**
   * When true, runs the legacy single-stage flow (used by older tests).
   * Default: false — use the two-stage shortlist→deep→debate path.
   */
  singleStage?: boolean;
}

export interface CycleResult {
  ranAt: string;
  skippedReason?: string;
  decisionId?: number;
  proposals: number;
  approved: number;
  rejected: number;
  ordersSubmitted: number;
  managementUpgrades: number;
  shortlistSize?: number;
  debateSkipped?: number;
}

const SKIP_OUTPUT = (reason: string, ranAt: string): CycleResult => ({
  ranAt,
  skippedReason: reason,
  proposals: 0,
  approved: 0,
  rejected: 0,
  ordersSubmitted: 0,
  managementUpgrades: 0,
});

export async function runCycle(deps: CycleDeps): Promise<CycleResult> {
  const cfg = deps.cfg ?? loadConfig();
  const now = deps.now?.() ?? new Date();
  const ranAt = now.toISOString();
  const today = ranAt.slice(0, 10);
  const db = getRawSqlite();

  // 0. bot enabled?
  const bot = db.prepare('SELECT enabled FROM bot_state WHERE id = 1').get() as { enabled: number } | undefined;
  if (bot && !bot.enabled) return SKIP_OUTPUT('bot disabled', ranAt);

  // 0b. daily halt?
  ensureDailyState(today);
  const daily = db.prepare('SELECT halted, halt_reason, realized_pnl, trade_count FROM daily_state WHERE date = ?').get(today) as
    | { halted: number; halt_reason: string | null; realized_pnl: number; trade_count: number }
    | undefined;
  if (daily?.halted) return SKIP_OUTPUT(`halted: ${daily.halt_reason ?? 'unknown'}`, ranAt);

  // 1. market open?
  let clock;
  try {
    clock = await deps.alpaca.getClock();
  } catch (err) {
    logger.error({ err: String(err) }, 'getClock failed');
    return SKIP_OUTPUT('clock unavailable', ranAt);
  }
  if (!clock.is_open) return SKIP_OUTPUT('market closed', ranAt);

  // 2-3. portfolio + market
  const portfolio = await fetchPortfolioSnapshot(
    deps.alpaca,
    daily?.realized_pnl ?? 0,
    daily?.trade_count ?? 0,
  );
  const market = await fetchMarketSnapshot(deps.alpaca, cfg.SYMBOL_ALLOWLIST);

  // settled cash for the cash-account guardrail (T+1)
  let settledCashAvailable: number | undefined;
  try {
    settledCashAvailable = await deps.alpaca.getSettledCash();
  } catch (err) {
    logger.warn({ err: String(err) }, 'getSettledCash failed; skipping settled-cash check');
  }

  // 4. congress (filtered query already requires committee_fit OR cluster>=2)
  const congress = loadCongressSignals(cfg.SYMBOL_ALLOWLIST, cfg.CONGRESS_LOOKBACK_DAYS);

  // 4b. news (refresh + load if enabled)
  if (cfg.ALPACA_NEWS_ENABLED) {
    try {
      await refreshAlpacaNews({ symbols: cfg.SYMBOL_ALLOWLIST, lookbackHours: cfg.NEWS_LOOKBACK_HOURS });
    } catch (err) {
      logger.warn({ err: String(err) }, 'news refresh failed; using cached items only');
    }
  }
  const news = loadNewsSignals(cfg.SYMBOL_ALLOWLIST, {}, cfg);

  // recent decisions (last 5)
  const recent = db
    .prepare('SELECT timestamp, parsed_proposals_json FROM decisions ORDER BY timestamp DESC LIMIT 5')
    .all() as Array<{ timestamp: number; parsed_proposals_json: string }>;
  const recentSummaries = recent.map((d) => {
    const t = new Date(d.timestamp).toISOString();
    let n = 0;
    try {
      const arr = JSON.parse(d.parsed_proposals_json);
      n = Array.isArray(arr) ? arr.length : 0;
    } catch {
      // ignore
    }
    return `${t} → ${n} proposals`;
  });

  // 5. analyze: stage-1 shortlist → stage-2 deep per ticker (default), or single stage
  let proposals: TradeProposal[] = [];
  let rawResponse = '';
  let model = cfg.CLAUDE_MODEL;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let parseError: string | undefined;
  let shortlistSize: number | undefined;

  try {
    if (deps.singleStage) {
      const r = await analyze({
        cfg,
        claude: deps.claude,
        portfolio,
        market,
        congress,
        news,
        recentDecisionSummaries: recentSummaries,
        nowIso: ranAt,
      });
      proposals = r.proposals;
      rawResponse = r.rawResponse;
      model = r.model;
      promptTokens = r.promptTokens;
      completionTokens = r.completionTokens;
      parseError = r.parseError;
    } else {
      const stage1 = await shortlist({
        cfg,
        claude: deps.claude,
        portfolio,
        market,
        congress,
        news,
        recentDecisionSummaries: recentSummaries,
        nowIso: ranAt,
      });
      shortlistSize = stage1.shortlist.length;
      rawResponse = `[shortlist] ${stage1.rawResponse}`;
      if (stage1.parseError) parseError = stage1.parseError;

      for (const symbol of stage1.shortlist) {
        const r = await analyze({
          cfg,
          claude: deps.claude,
          portfolio,
          market,
          congress,
          news,
          recentDecisionSummaries: recentSummaries,
          nowIso: ranAt,
          focusSymbol: symbol,
        });
        proposals.push(...r.proposals);
        rawResponse += `\n\n[deep ${symbol}] ${r.rawResponse}`;
        promptTokens = (promptTokens ?? 0) + (r.promptTokens ?? 0);
        completionTokens = (completionTokens ?? 0) + (r.completionTokens ?? 0);
        if (r.parseError) parseError = (parseError ?? '') + `\n[deep ${symbol}] ${r.parseError}`;
      }
    }
  } catch (err) {
    const msg = String(err);
    logger.error({ err: msg }, 'analyze failed');
    if (/rate limit|quota|429/i.test(msg)) {
      db.prepare('UPDATE daily_state SET halted = 1, halt_reason = ? WHERE date = ?').run(
        `claude quota: ${msg.slice(0, 200)}`,
        today,
      );
    }
    return SKIP_OUTPUT('analyze error', ranAt);
  }

  // persist decision
  const decisionInsert = db
    .prepare(
      `INSERT INTO decisions (timestamp, model, prompt_tokens, completion_tokens, raw_response, parsed_proposals_json, market_snapshot_json, congress_signals_json, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      now.getTime(),
      model,
      promptTokens ?? null,
      completionTokens ?? null,
      rawResponse,
      JSON.stringify(proposals),
      JSON.stringify(market),
      JSON.stringify({ congress, news }),
      parseError ?? null,
    );
  const decisionId = Number(decisionInsert.lastInsertRowid);

  // 6. guardrails per proposal
  let approved = 0;
  let rejected = 0;
  let ordersSubmitted = 0;
  let debateSkipped = 0;
  for (const proposal of proposals) {
    const earningsDays = daysUntilEarnings(proposal.symbol, now);
    const outcome = evaluateProposal(proposal, {
      cfg,
      portfolio,
      isHaltedToday: false,
      tradesToday: portfolio.tradeCountToday,
      upcomingEarningsDays: earningsDays,
      settledCashAvailable,
    });

    const finalProposal: TradeProposal = outcome.clampedProposal ?? proposal;

    const proposalRow = db
      .prepare(
        `INSERT INTO proposals (decision_id, symbol, side, qty, notional_usd, entry_type, entry_trigger_price, stop_loss_pct, trailing_stop_pct, reasoning, guardrail_status, guardrail_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decisionId,
        finalProposal.symbol,
        finalProposal.side,
        finalProposal.qty ?? null,
        finalProposal.notionalUsd ?? null,
        finalProposal.entryType ?? null,
        finalProposal.entryTriggerPrice ?? null,
        finalProposal.stopLossPct ?? null,
        finalProposal.trailingStopPct ?? null,
        finalProposal.reasoning ?? null,
        outcome.status,
        outcome.reason ?? null,
      );

    if (outcome.status === 'rejected') {
      rejected++;
      continue;
    }

    // Bull/bear debate gate (buys with structured signals only).
    if (
      !deps.singleStage &&
      finalProposal.side === 'buy' &&
      finalProposal.signals
    ) {
      try {
        const verdict = await debate({ claude: deps.claude, proposal: finalProposal });
        if (verdict.decision === 'skip') {
          db.prepare('UPDATE proposals SET guardrail_status = ?, guardrail_reason = ? WHERE id = ?').run(
            'rejected',
            `debate-skip: ${verdict.reason}`.slice(0, 500),
            Number(proposalRow.lastInsertRowid),
          );
          rejected++;
          debateSkipped++;
          continue;
        }
      } catch (err) {
        logger.warn({ err: String(err) }, 'debate failed; conservative fail-safe is to skip');
        db.prepare('UPDATE proposals SET guardrail_status = ?, guardrail_reason = ? WHERE id = ?').run(
          'rejected',
          `debate-error: ${String(err).slice(0, 200)}`,
          Number(proposalRow.lastInsertRowid),
        );
        rejected++;
        continue;
      }
    }

    approved++;

    // 7. execute
    const snap = market[finalProposal.symbol.toUpperCase()];
    if (!snap) {
      logger.warn({ symbol: finalProposal.symbol }, 'no market snapshot; skipping order');
      continue;
    }
    const qty = computeQty(finalProposal, snap.latestPrice, portfolio);
    if (qty <= 0 && finalProposal.side === 'sell') {
      logger.warn({ proposal: finalProposal }, 'qty resolved to 0; skipping order');
      continue;
    }
    const meta = db
      .prepare('SELECT current_stop_alpaca_order_id FROM positions_meta WHERE symbol = ?')
      .get(finalProposal.symbol) as { current_stop_alpaca_order_id: string | null } | undefined;
    const result = await executeOrder(deps.alpaca, finalProposal, {
      cfg,
      currentPrice: snap.latestPrice,
      atr14: snap.atr14,
      qty,
      cancelStopOrderId: finalProposal.side === 'sell' ? meta?.current_stop_alpaca_order_id ?? undefined : undefined,
    });

    const auditStr = composeDecisionAudit(finalProposal);
    db.prepare(
      `INSERT INTO orders (proposal_id, alpaca_order_id, parent_alpaca_order_id, symbol, side, type, qty, notional_usd, status, submitted_at, decision_audit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Number(proposalRow.lastInsertRowid),
      result.alpacaOrderId ?? null,
      result.parentAlpacaOrderId ?? null,
      finalProposal.symbol,
      finalProposal.side,
      finalProposal.entryType ?? (finalProposal.side === 'sell' ? 'market' : 'stop'),
      result.filledQty ?? qty,
      finalProposal.notionalUsd ?? null,
      result.status,
      now.getTime(),
      auditStr,
    );

    if (result.ok) {
      ordersSubmitted++;
      db.prepare('UPDATE daily_state SET trade_count = trade_count + 1 WHERE date = ?').run(today);

      if (finalProposal.side === 'buy' && !result.dryRun && result.alpacaOrderId) {
        const fixedStop = Math.min(
          snap.latestPrice * (1 - finalProposal.stopLossPct! / 100),
          snap.latestPrice - cfg.ATR_MULT * snap.atr14,
        );
        const recordedQty = result.filledQty ?? qty;
        db.prepare(
          `INSERT INTO positions_meta (symbol, opened_at, entry_price, qty, atr_at_entry, current_stop_alpaca_order_id, current_stop_type, current_stop_price, trailing_stop_pct, highest_price_seen)
           VALUES (?, ?, ?, ?, ?, ?, 'fixed', ?, ?, ?)
           ON CONFLICT(symbol) DO UPDATE SET
             qty = qty + excluded.qty,
             current_stop_price = MIN(current_stop_price, excluded.current_stop_price),
             trailing_stop_pct = excluded.trailing_stop_pct,
             highest_price_seen = MAX(highest_price_seen, excluded.highest_price_seen)`,
        ).run(
          finalProposal.symbol,
          now.getTime(),
          result.filledAvgPrice ?? snap.latestPrice,
          recordedQty,
          snap.atr14,
          result.parentAlpacaOrderId ?? result.alpacaOrderId,
          fixedStop,
          finalProposal.trailingStopPct ?? cfg.TRAILING_STOP_PCT,
          snap.latestPrice,
        );
      }
      if (finalProposal.side === 'sell') {
        db.prepare('DELETE FROM positions_meta WHERE symbol = ?').run(finalProposal.symbol);
      }
    } else {
      logger.error({ result, proposal: finalProposal }, 'order failed');
    }
  }

  // 8. manage open positions: fixed stop → trailing stop upgrade
  const managementUpgrades = await manageOpenPositions(deps.alpaca, cfg, market, now);

  return {
    ranAt,
    decisionId,
    proposals: proposals.length,
    approved,
    rejected,
    ordersSubmitted,
    managementUpgrades,
    shortlistSize,
    debateSkipped,
  };
}

async function manageOpenPositions(
  alpaca: AlpacaClient,
  cfg: Config,
  market: Awaited<ReturnType<typeof fetchMarketSnapshot>>,
  now: Date,
): Promise<number> {
  const db = getRawSqlite();
  const rows = db.prepare('SELECT * FROM positions_meta').all() as Array<{
    symbol: string;
    entry_price: number;
    qty: number;
    current_stop_alpaca_order_id: string | null;
    current_stop_type: 'fixed' | 'trailing';
    current_stop_price: number | null;
    trailing_stop_pct: number | null;
    highest_price_seen: number;
  }>;
  let upgrades = 0;

  for (const r of rows) {
    const snap = market[r.symbol];
    if (!snap) continue;
    const trail = r.trailing_stop_pct ?? cfg.TRAILING_STOP_PCT;
    const managed: ManagedPosition = {
      symbol: r.symbol,
      entryPrice: r.entry_price,
      qty: r.qty,
      currentPrice: snap.latestPrice,
      highestPriceSeen: r.highest_price_seen,
      currentStopType: r.current_stop_type,
      currentStopPrice: r.current_stop_price,
      trailingStopPct: trail,
    };
    const action = planManagement(managed, cfg);
    db.prepare('UPDATE positions_meta SET highest_price_seen = ? WHERE symbol = ?').run(
      action.newHighestPriceSeen,
      r.symbol,
    );
    if (action.kind === 'noop') continue;

    if (cfg.SAFE_MODE) {
      logger.info({ action }, 'SAFE_MODE: would upgrade to trailing stop');
      continue;
    }

    try {
      if (r.current_stop_alpaca_order_id) {
        await alpaca.cancelOrder(r.current_stop_alpaca_order_id).catch((e) =>
          logger.warn({ err: String(e) }, 'cancel old fixed stop failed'),
        );
      }
      const ts = await alpaca.submitTrailingStop({
        symbol: r.symbol,
        side: 'sell',
        qty: action.qty,
        trailPercent: action.trailPct,
      });
      db.prepare(
        `UPDATE positions_meta SET current_stop_alpaca_order_id = ?, current_stop_type = 'trailing', current_stop_price = NULL WHERE symbol = ?`,
      ).run(ts.id, r.symbol);
      db.prepare(
        `INSERT INTO orders (alpaca_order_id, symbol, side, type, qty, status, submitted_at)
         VALUES (?, ?, 'sell', 'trailing_stop', ?, ?, ?)`,
      ).run(ts.id, r.symbol, action.qty, ts.status, now.getTime());
      upgrades++;
      logger.info({ symbol: r.symbol, trailPct: action.trailPct }, 'upgraded fixed stop to trailing');
    } catch (err) {
      logger.error({ err: String(err), symbol: r.symbol }, 'trailing stop upgrade failed');
    }
  }

  return upgrades;
}

function ensureDailyState(today: string) {
  const db = getRawSqlite();
  db.prepare('INSERT OR IGNORE INTO daily_state (date) VALUES (?)').run(today);
}

function computeQty(
  p: TradeProposal,
  price: number,
  portfolio: { positions: Array<{ symbol: string; qty: number }> },
): number {
  if (p.side === 'sell') {
    const pos = portfolio.positions.find((x) => x.symbol === p.symbol);
    return pos?.qty ?? 0;
  }
  if (p.qty !== undefined) return p.qty;
  // Notional path: orders.ts handles fractional via submitNotionalBracket. We
  // pass the floor as a fallback for the legacy submitBracket path.
  if (p.notionalUsd !== undefined && price > 0) return Math.max(0, Math.floor(p.notionalUsd / price));
  return 0;
}
