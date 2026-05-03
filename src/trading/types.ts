export type Side = 'buy' | 'sell';
export type EntryType = 'market' | 'stop' | 'limit';

export interface TradeProposal {
  symbol: string;
  side: Side;
  qty?: number;
  notionalUsd?: number;
  entryType?: EntryType;
  entryTriggerPrice?: number;
  stopLossPct?: number;
  trailingStopPct?: number;
  reasoning?: string;
}

export interface PortfolioPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPlPct: number;
}

export interface PortfolioSnapshot {
  cashUsd: number;
  equityUsd: number;
  positions: PortfolioPosition[];
  realizedPnlToday: number;
  tradeCountToday: number;
}

export interface MarketSnapshotEntry {
  symbol: string;
  latestPrice: number;
  bars: { high: number; low: number; close: number; open: number; volume: number; t: string }[];
  atr14: number;
}

export type MarketSnapshot = Record<string, MarketSnapshotEntry>;

export interface CongressTradeSignal {
  symbol: string;
  filerName: string;
  filerChamber?: 'senate' | 'house';
  filerParty?: string;
  filerState?: string;
  filerCommittees?: string[];
  transactionType: 'buy' | 'sell' | 'exchange';
  transactionDate: string;
  disclosureDate?: string;
  amountMinUsd?: number;
  amountMaxUsd?: number;
}

export type CongressSignals = Record<string, CongressTradeSignal[]>;

export interface GuardrailOutcome {
  status: 'approved' | 'rejected' | 'clamped';
  reason?: string;
  clampedProposal?: TradeProposal;
}
