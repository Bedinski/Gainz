import type { Config } from './config.js';

export interface ManagedPosition {
  symbol: string;
  entryPrice: number;
  qty: number;
  currentPrice: number;
  highestPriceSeen: number;
  currentStopType: 'fixed' | 'trailing';
  currentStopPrice: number | null;
  trailingStopPct: number;
}

export interface UpgradeAction {
  kind: 'upgrade-to-trailing';
  symbol: string;
  trailPct: number;
  qty: number;
  newHighestPriceSeen: number;
}

export interface NoopAction {
  kind: 'noop';
  symbol: string;
  reason: string;
  newHighestPriceSeen: number;
}

export type ManageAction = UpgradeAction | NoopAction;

/**
 * Decides whether a position's fixed stop should be replaced by a trailing
 * stop. Pure function — no side effects, no Alpaca calls. Caller is
 * responsible for cancel-and-replace + DB persistence.
 *
 * Trigger: position is up enough that a trailing stop at `trailingStopPct`
 * from the highest price seen would be tighter (i.e., higher) than the
 * current fixed stop.
 */
export function planManagement(pos: ManagedPosition, _cfg: Config): ManageAction {
  const newHigh = Math.max(pos.highestPriceSeen, pos.currentPrice);

  if (pos.currentStopType === 'trailing') {
    return { kind: 'noop', symbol: pos.symbol, reason: 'already trailing', newHighestPriceSeen: newHigh };
  }

  if (pos.currentStopPrice === null || pos.currentStopPrice === undefined) {
    return { kind: 'noop', symbol: pos.symbol, reason: 'no current stop on file', newHighestPriceSeen: newHigh };
  }

  const trailPct = pos.trailingStopPct;
  const trailingFloor = newHigh * (1 - trailPct / 100);

  if (trailingFloor > pos.currentStopPrice) {
    return {
      kind: 'upgrade-to-trailing',
      symbol: pos.symbol,
      trailPct,
      qty: pos.qty,
      newHighestPriceSeen: newHigh,
    };
  }

  return {
    kind: 'noop',
    symbol: pos.symbol,
    reason: `trailing floor ${trailingFloor.toFixed(2)} <= fixed stop ${pos.currentStopPrice.toFixed(2)}`,
    newHighestPriceSeen: newHigh,
  };
}
