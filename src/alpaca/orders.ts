import type { Config } from '../trading/config.js';
import type { TradeProposal } from '../trading/types.js';
import { logger } from '../lib/logger.js';
import type { AlpacaClient } from './client.js';

export interface ExecuteResult {
  ok: boolean;
  alpacaOrderId?: string;
  parentAlpacaOrderId?: string;
  filledAvgPrice?: number;
  filledQty?: number;
  status: string;
  error?: string;
  dryRun?: boolean;
}

/**
 * Translates a (clamped) TradeProposal into the appropriate Alpaca order.
 *
 * Buys:
 *   - Notional path (preferred for cash-account / fractional sizing): two-step
 *     `submitNotionalBracket` — parent buy by USD, protective stop attached
 *     after fill with the actual fractional qty.
 *   - Whole-share path (legacy): bracket order with parent stop-buy and a
 *     fixed stop-loss child.
 *
 * Sells: cancel any open trailing stop for the symbol, then market-sell the
 *        position quantity (caller passes qty).
 */
export async function executeOrder(
  client: AlpacaClient,
  proposal: TradeProposal,
  ctx: {
    cfg: Config;
    currentPrice: number;
    atr14: number;
    qty: number;
    cancelStopOrderId?: string;
  },
): Promise<ExecuteResult> {
  const { cfg, currentPrice, atr14, qty } = ctx;

  if (cfg.SAFE_MODE) {
    logger.info({ proposal, ctx: { currentPrice, atr14, qty } }, 'SAFE_MODE: dry-run');
    return { ok: true, status: 'dry_run', dryRun: true };
  }

  try {
    if (proposal.side === 'sell') {
      if (ctx.cancelStopOrderId) {
        await client.cancelOrder(ctx.cancelStopOrderId).catch((e) =>
          logger.warn({ err: String(e) }, 'cancel stop on sell failed (continuing)'),
        );
      }
      const r = await client.submitMarket({ symbol: proposal.symbol, side: 'sell', qty });
      return { ok: true, alpacaOrderId: r.id, status: r.status };
    }

    // buy: pick path
    const stopLossPct = proposal.stopLossPct!;
    const fixedStopPrice = currentPrice * (1 - stopLossPct / 100);
    const atrStopPrice = currentPrice - cfg.ATR_MULT * atr14;
    const stopLossPrice = Math.min(fixedStopPrice, atrStopPrice); // wider of the two — lower price

    let entryTriggerPrice: number | undefined;
    if (proposal.entryType === 'stop') {
      entryTriggerPrice = currentPrice * (1 + cfg.ENTRY_TRIGGER_PCT / 100);
    } else if (proposal.entryType === 'limit') {
      entryTriggerPrice = proposal.entryTriggerPrice ?? currentPrice;
    }

    // Use notional bracket when the proposal is sized in USD. This is the
    // mandatory path during the cash-account phase since allowlist tickers
    // can be priced above the per-position cap.
    if (proposal.notionalUsd !== undefined && proposal.qty === undefined) {
      const r = await client.submitNotionalBracket({
        symbol: proposal.symbol,
        side: 'buy',
        notionalUsd: proposal.notionalUsd,
        entryType: proposal.entryType ?? 'stop',
        entryTriggerPrice,
        stopLossPrice,
        timeInForce: 'day',
      });
      return {
        ok: true,
        alpacaOrderId: r.parentOrderId,
        parentAlpacaOrderId: r.stopOrderId,
        status: r.parentStatus,
        filledQty: r.filledQty,
        filledAvgPrice: r.filledAvgPrice,
      };
    }

    // Whole-share bracket (legacy / higher-capital path).
    const r = await client.submitBracket({
      symbol: proposal.symbol,
      side: 'buy',
      qty,
      entryType: proposal.entryType ?? 'stop',
      entryTriggerPrice,
      stopLossPrice,
      timeInForce: 'day',
    });
    const stopLeg = r.legs?.find((l) => l.order_class === 'bracket') ?? r.legs?.[0];
    return {
      ok: true,
      alpacaOrderId: r.id,
      parentAlpacaOrderId: stopLeg?.id,
      status: r.status,
    };
  } catch (err) {
    return { ok: false, status: 'error', error: String(err) };
  }
}
