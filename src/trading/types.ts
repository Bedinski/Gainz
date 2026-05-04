export type Side = 'buy' | 'sell';
export type EntryType = 'market' | 'stop' | 'limit';

export type SignalStrength = 0 | 1 | 2;

export interface SignalEvidence {
  strength: SignalStrength;
  evidence: string;
}

export interface ProposalSignals {
  technical: SignalEvidence;
  congress: SignalEvidence;
  news: SignalEvidence;
  earnings_proximity: 'clear' | 'within_blackout';
  conflicts: string[];
}

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
  /**
   * Structured multi-source signal block. Required for buy proposals in the
   * iteration-2 cash-account phase; the guardrail enforces convergence
   * (MIN_SIGNAL_SCORE) and zero conflicts (MAX_CONFLICTS).
   */
  signals?: ProposalSignals;
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
  /** Filer sits on a committee with jurisdiction over the symbol's sector. */
  committeeFitBoost?: boolean;
  /** Number of distinct politician filers buying this symbol within the cluster window. */
  clusterSize?: number;
}

export interface NewsSignalItem {
  symbol: string;
  headline: string;
  summary?: string;
  url?: string;
  source: string;
  category: 'earnings' | 'guidance' | 'm_and_a' | 'regulatory' | 'exec_change' | 'analyst' | 'recap' | 'other' | 'unclassified';
  publishedAt: number;
}

export type NewsSignals = Record<string, NewsSignalItem[]>;

export type CongressSignals = Record<string, CongressTradeSignal[]>;

export interface GuardrailOutcome {
  status: 'approved' | 'rejected' | 'clamped';
  reason?: string;
  clampedProposal?: TradeProposal;
}
