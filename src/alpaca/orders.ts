import type { Config } from '../trading/config.js';
import type { TradeProposal } from '../trading/types.js';
import { logger } from '../lib/logger.js';
import type { AlpacaClient } from './client.js';

export interface ExecuteResult {
  ok: boolean;
  alpacaOrderId?: string;
  parentAlpacaOrderId?: string;
  filledAvgPrice?: number;
  status: string;
  error?: string;
  dryRun?: boolean;
}

/**
 * Translates a (clamped) TradeProposal into the appropriate Alpaca order.
 *
 * Buys: bracket order with parent stop-buy (or market/limit per entryType)
 *       and a fixed stop-loss child. The cycle-end manage step later
 *       upgrades the fixed stop to trailing once in profit.
 *
 * Sells: cancel any open trailing stop for the symbol, then market sell
 *        the position quantity (requires caller to pass qty).
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

    // buy: bracket with stop-loss child
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
