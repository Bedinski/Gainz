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
import {
  computeDrawdown,
  formatDrawdownLine,
  loadActiveDipEvents,
  updateDipEvents,
} from '../strategies/dip-recovery/detector.js';
import { analyzeDip } from '../strategies/dip-recovery/analyze.js';
import { runDipExits } from '../strategies/dip-recovery/exit.js';
import { classifyRegime, formatRegimeLine } from '../strategies/regime.js';
import {
  checkDrawdownCircuitBreaker,
  loadEquityHistory,
  recordEquity,
} from './circuit-breaker.js';
import { reconcilePositions } from './reconcile.js';
import { sendAlert } from '../lib/alerts.js';
import { SYMBOL_SECTOR } from '../signals/congress/committees.js';
import type { DipEntryProposal, Regime, TradeProposal } from './types.js';

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
  // iter3 dip strategy
  dipEventsActive?: number;
  dipEventsInserted?: number;
  dipEventsRecovered?: number;
  dipEventsExpired?: number;
  dipEntries?: number;
  dipExits?: number;
  // iter4
  regime?: Regime;
  drainMode?: boolean;
  circuitBreakerTriggered?: boolean;
  reconciliationMismatches?: number;
  /** False when Alpaca's clock reports the market is closed. Cycle still runs
   *  the full pipeline; orders submitted in this state queue for the next
   *  regular session. Surfaced so the post-cycle log distinguishes "ran
   *  during market hours" from "ran after hours for review/queuing". */
  marketOpen?: boolean;
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

  // 0. bot enabled? + drain mode triage.
  // mode='off' is a soft kill (same effect as enabled=0); mode='drain' lets
  // the cycle continue but the guardrail rejects every new buy so existing
  // positions can exit cleanly (close-only).
  const bot = db
    .prepare('SELECT enabled, mode FROM bot_state WHERE id = 1')
    .get() as { enabled: number; mode?: string } | undefined;
  if (bot && !bot.enabled) return SKIP_OUTPUT('bot disabled', ranAt);
  if (bot?.mode === 'off') return SKIP_OUTPUT('bot mode=off', ranAt);
  const drainMode = bot?.mode === 'drain';

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
  // After-hours mode: even when the market is closed we run the full cycle —
  // analysis (signals, news refresh, Claude shortlist + deep + debate),
  // decision-row write, AND trading actions. Alpaca queues stop-buys + limit
  // orders for the next regular session, and trailing-stop upgrades lock in
  // a base price relative to the close, which is exactly what the operator
  // wants for "adjust the floor while I'm thinking about it." Sell-side
  // market orders may bounce from Alpaca with extended-hours-restriction
  // errors; those are logged via executeOrder's try/catch and don't break
  // the cycle.
  const marketOpen = clock.is_open;
  if (!marketOpen) {
    logger.info({ ranAt }, 'market closed: running full cycle (orders queue at Alpaca for next session)');
  }

  // 2-3. portfolio + market
  const portfolio = await fetchPortfolioSnapshot(
    deps.alpaca,
    daily?.realized_pnl ?? 0,
    daily?.trade_count ?? 0,
  );

  // iter4 C3: record equity datapoint + drawdown circuit breaker check.
  // Fires BEFORE market/Claude work so a triggered breaker short-circuits the
  // expensive parts of the cycle.
  recordEquity(now, portfolio.equityUsd, portfolio.cashUsd);
  if (cfg.CIRCUIT_BREAKER_ENABLED) {
    const verdict = checkDrawdownCircuitBreaker(loadEquityHistory(), cfg, now);
    if (verdict.triggered) {
      db.prepare('UPDATE daily_state SET halted = 1, halt_reason = ? WHERE date = ?').run(
        verdict.reason.slice(0, 500),
        today,
      );
      await sendAlert(
        {
          severity: 'critical',
          title: 'Circuit breaker fired',
          body: verdict.reason,
          dedupeKey: `circuit-breaker:${today}`,
        },
        cfg,
      ).catch((err) => logger.error({ err: String(err) }, 'circuit-breaker alert dispatch failed'));
      return {
        ...SKIP_OUTPUT('circuit breaker', ranAt),
        circuitBreakerTriggered: true,
        drainMode,
      };
    }
  }
  // Fetch market data for the allowlist plus any dip-strategy symbols (typically
  // SPY/QQQ). Dedup so a symbol that lives in both lists is fetched once.
  const marketSymbols = Array.from(
    new Set([
      ...cfg.SYMBOL_ALLOWLIST.map((s) => s.toUpperCase()),
      ...(cfg.DIP_STRATEGY_ENABLED ? cfg.DIP_SYMBOLS.map((s) => s.toUpperCase()) : []),
    ]),
  );
  const market = await fetchMarketSnapshot(deps.alpaca, marketSymbols);

  // iter4 B2: macro regime classification from the snapshot. Reuses SPY bars
  // already pulled. Pure function — adds zero new HTTP calls.
  const regimeReading = classifyRegime(market, cfg);
  const regimeLine = formatRegimeLine(regimeReading);

  // iter4 C1: existing sector exposure across all open positions. One query
  // per cycle; results shared across every guardrail evaluation below.
  const sectorRows = db
    .prepare(
      `SELECT COALESCE(sector, '') AS sector, COALESCE(SUM(qty * entry_price), 0) AS exposure
       FROM positions_meta
       WHERE qty > 0
       GROUP BY sector`,
    )
    .all() as Array<{ sector: string; exposure: number }>;
  const sectorExposureUsd: Record<string, number> = {};
  for (const r of sectorRows) {
    if (r.sector) sectorExposureUsd[r.sector] = r.exposure;
  }

  // settled cash for the cash-account guardrail (T+1)
  let settledCashAvailable: number | undefined;
  try {
    settledCashAvailable = await deps.alpaca.getSettledCash();
  } catch (err) {
    logger.warn({ err: String(err) }, 'getSettledCash failed; skipping settled-cash check');
  }

  // 4. congress signals — cached congress trades table; the prompt renders
  //    a congress block per allowlisted symbol.
  const congress = loadCongressSignals(cfg.SYMBOL_ALLOWLIST, cfg.CONGRESS_LOOKBACK_DAYS);

  // 4b. news (refresh + load if enabled). News pull covers allowlist + dip
  // symbols so political_shock items can gate dip detection.
  const newsScope = Array.from(
    new Set([
      ...cfg.SYMBOL_ALLOWLIST,
      ...(cfg.DIP_STRATEGY_ENABLED ? cfg.DIP_SYMBOLS : []),
    ]),
  );
  if (cfg.ALPACA_NEWS_ENABLED) {
    try {
      await refreshAlpacaNews({ symbols: newsScope, lookbackHours: cfg.NEWS_LOOKBACK_HOURS });
    } catch (err) {
      logger.warn({ err: String(err) }, 'news refresh failed; using cached items only');
    }
  }
  const news = loadNewsSignals(newsScope, {}, cfg);

  // 4c. dip strategy: lifecycle + market-state lines for the prompt.
  // Compute drawdowns ONCE per dip symbol and reuse across the three call
  // sites (lifecycle update, prompt market-state block, dip-entry loop). The
  // function is pure, so sharing the result is a byte-equivalent dedupe.
  let marketStateLines: string[] = [];
  let dipLifecycle: { inserted: number; updated: number; recovered: number; expired: number } = {
    inserted: 0,
    updated: 0,
    recovered: 0,
    expired: 0,
  };
  const drawdownMap: Record<string, ReturnType<typeof computeDrawdown>> = {};
  if (cfg.DIP_STRATEGY_ENABLED) {
    for (const sym of cfg.DIP_SYMBOLS) {
      const snap = market[sym];
      drawdownMap[sym] = snap
        ? computeDrawdown(snap.bars, { windowDays: cfg.DIP_DETECTION_WINDOW_DAYS })
        : null;
    }
    const r = updateDipEvents({ cfg, market, news, now, drawdowns: drawdownMap });
    dipLifecycle = {
      inserted: r.inserted.length,
      updated: r.updated.length,
      recovered: r.recovered.length,
      expired: r.expired.length,
    };
    marketStateLines = cfg.DIP_SYMBOLS.map((sym) => {
      const snap = market[sym];
      if (!snap) return `${sym} drawdown: no snapshot`;
      return formatDrawdownLine(sym, drawdownMap[sym] ?? null);
    });
  }

  // iter4 B2: prepend the regime summary so it shows up in the prompt's
  // "Market state" block whether or not the dip strategy is enabled.
  marketStateLines = [regimeLine, ...marketStateLines];

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
  interface PipelineProposal {
    proposal: TradeProposal;
    strategyTag: 'momentum' | 'dip_recovery';
    dipEventId?: number;
    dipTargetPrice?: number;
    dipTimeExitAt?: number;
  }
  let proposals: TradeProposal[] = [];
  let pipeline: PipelineProposal[] = [];
  let rawResponse = '';
  let model = cfg.CLAUDE_MODEL;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let parseError: string | undefined;
  let shortlistSize: number | undefined;
  let dipEntries = 0;

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
        marketStateLines,
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
        marketStateLines,
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
          marketStateLines,
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

  // wrap momentum proposals into the pipeline shape
  pipeline = proposals.map((p) => ({ proposal: p, strategyTag: 'momentum' as const }));

  // 5b. dip-recovery bucket: for each active dip event whose rebound has confirmed,
  // ask Claude (separate prompt) whether to enter. Inert when DIP_STRATEGY_ENABLED=false.
  if (cfg.DIP_STRATEGY_ENABLED) {
    const activeEvents = loadActiveDipEvents(cfg.DIP_SYMBOLS).filter((e) => e.status === 'active');
    for (const event of activeEvents) {
      const snap = market[event.symbol];
      if (!snap) continue;
      const dd = drawdownMap[event.symbol] ?? null;
      if (!dd) continue;
      if (dd.reboundBars < cfg.DIP_REBOUND_CONFIRMATION_BARS) continue;

      try {
        const r = await analyzeDip({
          cfg,
          claude: deps.claude,
          portfolio,
          event,
          drawdown: dd,
          marketEntry: snap,
          news,
          nowIso: ranAt,
        });
        rawResponse += `\n\n[dip ${event.symbol}] ${r.rawResponse}`;
        promptTokens = (promptTokens ?? 0) + (r.promptTokens ?? 0);
        completionTokens = (completionTokens ?? 0) + (r.completionTokens ?? 0);
        if (r.parseError) parseError = (parseError ?? '') + `\n[dip ${event.symbol}] ${r.parseError}`;
        if (!r.proposal || r.proposal.decision !== 'enter') continue;
        const dipProp: TradeProposal = {
          symbol: r.proposal.symbol,
          side: 'buy',
          notionalUsd: r.proposal.notionalUsd ?? cfg.DIP_BUDGET_USD,
          entryType: 'market', // dip strategy enters at market on rebound confirmation
          stopLossPct: cfg.STOP_LOSS_MAX_PCT, // wide stop — exit is target/time, not stop
          trailingStopPct: cfg.TRAILING_MAX_PCT, // ditto
          reasoning: r.proposal.reasoning,
          signals: r.proposal.signals,
        };
        proposals.push(dipProp);
        pipeline.push({
          proposal: dipProp,
          strategyTag: 'dip_recovery',
          dipEventId: event.id,
          dipTargetPrice: event.recoveryTargetPrice,
          dipTimeExitAt: event.expiresAt,
        });
        dipEntries++;
      } catch (err) {
        logger.warn({ err: String(err), symbol: event.symbol }, 'dip analysis failed; skipping');
      }
    }
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

  // 6. guardrails per proposal. Per-strategy existing exposure is computed
  // once per cycle so all dip proposals share the same starting budget.
  const dipExposureUsd = (
    db
      .prepare(
        `SELECT COALESCE(SUM(qty * entry_price), 0) AS exposure FROM positions_meta WHERE strategy_tag = 'dip_recovery'`,
      )
      .get() as { exposure: number }
  ).exposure;

  let approved = 0;
  let rejected = 0;
  let ordersSubmitted = 0;
  let debateSkipped = 0;
  let dipExitsCount = 0;
  for (const item of pipeline) {
    const proposal = item.proposal;
    const earningsDays = daysUntilEarnings(proposal.symbol, now);
    const symbolUpper = proposal.symbol.toUpperCase();
    const snap = market[symbolUpper];
    const proposalSector = SYMBOL_SECTOR[symbolUpper];
    const outcome = evaluateProposal(proposal, {
      cfg,
      portfolio,
      isHaltedToday: false,
      tradesToday: portfolio.tradeCountToday,
      upcomingEarningsDays: earningsDays,
      settledCashAvailable,
      strategyTag: item.strategyTag,
      strategyExistingExposureUsd: item.strategyTag === 'dip_recovery' ? dipExposureUsd : undefined,
      // iter4 wiring:
      drainMode,
      atr14: snap?.atr14,
      latestPrice: snap?.latestPrice,
      sectorExposureUsd,
      proposalSector,
      regime: regimeReading.regime,
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
    let debateVerdict:
      | {
          decision: 'proceed' | 'skip';
          multiModel: boolean;
          bullModel: string;
          bearModel: string;
          judgeModel?: string;
        }
      | undefined;
    if (
      !deps.singleStage &&
      cfg.DEBATE_ENABLED &&
      finalProposal.side === 'buy' &&
      finalProposal.signals
    ) {
      try {
        const verdict = await debate({ claude: deps.claude, proposal: finalProposal, cfg });
        debateVerdict = {
          decision: verdict.decision,
          multiModel: verdict.models.multiModel,
          bullModel: verdict.models.bull,
          bearModel: verdict.models.bear,
          judgeModel: verdict.models.judge,
        };
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

    // 7. execute. Reuse the `snap` already resolved before the guardrail call.
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

    // iter4 D3: enriched audit. Recompute the same vol-sizing / VaR numbers
    // the guardrail used so the audit row reflects the actual sized trade.
    const auditEffectiveStopFrac =
      finalProposal.stopLossPct !== undefined && snap?.atr14 && snap?.latestPrice
        ? Math.max(finalProposal.stopLossPct / 100, (cfg.ATR_MULT * snap.atr14) / snap.latestPrice)
        : undefined;
    const auditVar2Sigma =
      finalProposal.notionalUsd !== undefined && snap?.atr14 && snap?.latestPrice
        ? finalProposal.notionalUsd * 2 * (snap.atr14 / snap.latestPrice)
        : undefined;
    const originalNotional = proposal.notionalUsd;
    const finalNotional = finalProposal.notionalUsd;
    const auditVolClamped =
      cfg.VOL_SIZING_ENABLED &&
      originalNotional !== undefined &&
      finalNotional !== undefined &&
      finalNotional < originalNotional;

    const auditStr = composeDecisionAudit(finalProposal, {
      strategyTag: item.strategyTag,
      dipEventId: item.dipEventId,
      dipDrawdownPct:
        item.strategyTag === 'dip_recovery'
          ? loadActiveDipEvents([finalProposal.symbol]).find((e) => e.id === item.dipEventId)?.drawdownPct
          : undefined,
      dipTargetPrice: item.dipTargetPrice,
      dipTimeExitAt: item.dipTimeExitAt,
      nowMs: now.getTime(),
      regime: regimeReading.regime,
      sector: proposalSector,
      var2SigmaUsd: auditVar2Sigma,
      effectiveStopFrac: auditEffectiveStopFrac,
      volSizingClamped: auditVolClamped,
      debate: debateVerdict,
    });
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

      // Only write a positions_meta row when the entry actually filled. A
      // pending stop-buy (status='accepted'/'new', filledQty undefined) means
      // we don't own the shares yet — recording the row anyway would let a
      // future manageOpenPositions cycle see a "position", upgrade the
      // protective stop to a trailing stop, and leave an orphan sell on
      // Alpaca for shares the operator never owned. The row is created later
      // by manageOpenPositions's reconcile when the fill actually appears in
      // Alpaca's positions list.
      const entryFilled =
        (typeof result.filledQty === 'number' && result.filledQty > 0) ||
        result.status === 'filled' ||
        result.status === 'partially_filled';
      if (finalProposal.side === 'buy' && !result.dryRun && result.alpacaOrderId && entryFilled) {
        const fixedStop = Math.min(
          snap.latestPrice * (1 - finalProposal.stopLossPct! / 100),
          snap.latestPrice - cfg.ATR_MULT * snap.atr14,
        );
        const recordedQty = result.filledQty ?? qty;
        db.prepare(
          `INSERT INTO positions_meta (
             symbol, opened_at, entry_price, qty, atr_at_entry,
             current_stop_alpaca_order_id, current_stop_type, current_stop_price,
             trailing_stop_pct, highest_price_seen,
             strategy_tag, target_price, time_exit_at, dip_event_id, sector
           )
           VALUES (?, ?, ?, ?, ?, ?, 'fixed', ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(symbol) DO UPDATE SET
             qty = qty + excluded.qty,
             current_stop_price = MIN(current_stop_price, excluded.current_stop_price),
             trailing_stop_pct = excluded.trailing_stop_pct,
             highest_price_seen = MAX(highest_price_seen, excluded.highest_price_seen),
             target_price = COALESCE(excluded.target_price, positions_meta.target_price),
             time_exit_at = COALESCE(excluded.time_exit_at, positions_meta.time_exit_at),
             dip_event_id = COALESCE(excluded.dip_event_id, positions_meta.dip_event_id),
             sector = COALESCE(positions_meta.sector, excluded.sector)`,
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
          item.strategyTag,
          item.dipTargetPrice ?? null,
          item.dipTimeExitAt ?? null,
          item.dipEventId ?? null,
          proposalSector ?? null,
        );
        // Mark the dip event as 'entered' and link the position so the
        // detector won't insert a second event for the same drawdown.
        if (item.strategyTag === 'dip_recovery' && item.dipEventId) {
          db.prepare(
            `UPDATE dip_events SET status = 'entered', position_symbol = ? WHERE id = ?`,
          ).run(finalProposal.symbol, item.dipEventId);
        }
      }
      if (finalProposal.side === 'sell') {
        db.prepare('DELETE FROM positions_meta WHERE symbol = ?').run(finalProposal.symbol);
      }
      // Diagnostic: pending stop-buy that hasn't filled. Defer positions_meta
      // until reconcile sees the actual fill; operators sometimes see a buy
      // proposal "approved" and then no position appear, so log the reason.
      if (
        finalProposal.side === 'buy' &&
        !result.dryRun &&
        result.alpacaOrderId &&
        !entryFilled
      ) {
        logger.info(
          { symbol: finalProposal.symbol, status: result.status, alpacaOrderId: result.alpacaOrderId },
          'entry order accepted but not filled; positions_meta deferred until fill',
        );
      }
    } else {
      logger.error({ result, proposal: finalProposal }, 'order failed');
    }
  }

  // 8a. manage momentum positions: fixed stop → trailing stop upgrade.
  //     Strategy-aware: dip_recovery positions are skipped (their exit is
  //     deterministic via runDipExits below). Runs after-hours too — the
  //     operator wants to adjust the trailing-stop floor any time it makes
  //     sense relative to the most recent price.
  const managementUpgrades = await manageOpenPositions(deps.alpaca, cfg, market, now);

  // 8b. dip-recovery exits: target_price / time_exit_at deterministic exits.
  if (cfg.DIP_STRATEGY_ENABLED) {
    const exits = await runDipExits(deps.alpaca, cfg, market, now);
    dipExitsCount = exits.length;
  }

  // count active dip events for the result summary
  const activeDipCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM dip_events WHERE status IN ('active','entered')`,
      )
      .get() as { c: number }
  ).c;

  // iter4 C4: position reconciliation. Detect-only — drift triggers a critical
  // alert but doesn't auto-correct. Run at end-of-cycle so any orders we just
  // submitted have had a chance to fill (best-effort; reconciliation runs are
  // also a standalone cron in worker.ts).
  let reconciliationMismatches = 0;
  try {
    const recon = await reconcilePositions(deps.alpaca, cfg, now, { autoCorrect: true });
    reconciliationMismatches = recon.mismatches.length;
    if (recon.severity !== 'ok') {
      await sendAlert(
        {
          severity: recon.severity === 'critical' ? 'critical' : 'warn',
          title: `Reconciliation drift (${recon.mismatches.length} mismatch${recon.mismatches.length === 1 ? '' : 'es'})`,
          body: JSON.stringify(recon.mismatches, null, 2).slice(0, 4000),
          dedupeKey: `reconcile:${today}:${recon.severity}`,
        },
        cfg,
      ).catch((err) => logger.error({ err: String(err) }, 'reconciliation alert dispatch failed'));
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'reconciliation run threw; skipping');
  }

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
    dipEventsActive: activeDipCount,
    dipEventsInserted: dipLifecycle.inserted,
    dipEventsRecovered: dipLifecycle.recovered,
    dipEventsExpired: dipLifecycle.expired,
    dipEntries,
    dipExits: dipExitsCount,
    regime: regimeReading.regime,
    drainMode,
    circuitBreakerTriggered: false,
    reconciliationMismatches,
    marketOpen,
  };
}

async function manageOpenPositions(
  alpaca: AlpacaClient,
  cfg: Config,
  market: Awaited<ReturnType<typeof fetchMarketSnapshot>>,
  now: Date,
): Promise<number> {
  const db = getRawSqlite();

  // Phantom-row prune: a positions_meta row that doesn't correspond to any
  // live Alpaca position is stale (entry order canceled / never filled / hand-
  // edited DB / etc). Acting on it would cancel-and-re-issue a trailing stop
  // for shares we don't own — the orphan-trailing-stop bug. Cross-reference
  // Alpaca's position list, prune mismatches, and best-effort cancel any stop
  // order this row was tracking so it doesn't sit orphaned at the broker.
  let livePositions: Awaited<ReturnType<AlpacaClient['getPositions']>> = [];
  let livePositionsAvailable = false;
  try {
    livePositions = await alpaca.getPositions();
    livePositionsAvailable = true;
  } catch (err) {
    logger.warn({ err: String(err) }, 'getPositions failed; skipping phantom-row prune this cycle');
  }
  const liveSymbols = new Set(livePositions.map((p) => p.symbol.toUpperCase()));

  // Strategy-aware: dip_recovery positions are exited via runDipExits and
  // must skip the trailing-stop upgrade path.
  const rows = db
    .prepare(`SELECT * FROM positions_meta WHERE strategy_tag = 'momentum' OR strategy_tag IS NULL`)
    .all() as Array<{
    symbol: string;
    entry_price: number;
    qty: number;
    current_stop_alpaca_order_id: string | null;
    current_stop_type: 'fixed' | 'trailing';
    current_stop_price: number | null;
    trailing_stop_pct: number | null;
    highest_price_seen: number;
  }>;

  // Only prune when getPositions() actually returned. On failure we leave
  // positions_meta alone — the alternative (treat the failure as "Alpaca has
  // zero positions") would nuke every legit row.
  if (livePositionsAvailable) {
    for (const r of rows) {
      if (liveSymbols.has(r.symbol.toUpperCase())) continue;
      logger.warn(
        { symbol: r.symbol, stopOrderId: r.current_stop_alpaca_order_id ?? null },
        'positions_meta row has no matching Alpaca position; pruning + canceling tracked stop',
      );
      if (r.current_stop_alpaca_order_id) {
        await alpaca
          .cancelOrder(r.current_stop_alpaca_order_id)
          .catch((err) =>
            logger.warn(
              { err: String(err), symbol: r.symbol, orderId: r.current_stop_alpaca_order_id },
              'cancel orphan stop failed; operator should cancel manually',
            ),
          );
      }
      db.prepare('DELETE FROM positions_meta WHERE symbol = ?').run(r.symbol);
    }
  }

  // Re-read after the prune so the trailing-stop loop only walks live rows.
  const liveRows = db
    .prepare(`SELECT * FROM positions_meta WHERE strategy_tag = 'momentum' OR strategy_tag IS NULL`)
    .all() as typeof rows;
  let upgrades = 0;

  for (const r of liveRows) {
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
