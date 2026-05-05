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
  category:
    | 'earnings'
    | 'guidance'
    | 'm_and_a'
    | 'regulatory'
    | 'exec_change'
    | 'analyst'
    | 'recap'
    | 'political_shock'
    | 'other'
    | 'unclassified';
  publishedAt: number;
}

export type NewsSignals = Record<string, NewsSignalItem[]>;

export type StrategyTag = 'momentum' | 'dip_recovery';

/**
 * iter4: bot operating mode.
 *  - 'normal': cycle runs; new buys allowed.
 *  - 'drain':  cycle runs; buys rejected at the guardrail; sells, stop upgrades,
 *              and dip exits proceed. Lets you cleanly close out the book.
 *  - 'off':    cycle short-circuits at the gate (same effect as enabled=0).
 */
export type BotMode = 'normal' | 'drain' | 'off';

/**
 * iter4: macro regime classification used to scale risk.
 */
export type Regime = 'risk_on' | 'chop' | 'risk_off';

export type DipEventStatus = 'active' | 'entered' | 'recovered' | 'expired' | 'failed';

export interface DipEvent {
  id: number;
  symbol: string; // 'SPY' | 'QQQ' typically
  detectedAt: number;
  peakPrice: number;
  peakDate: string;
  troughPrice: number;
  troughDate: string;
  drawdownPct: number; // peak-to-trough, positive number (e.g. 7.1 means -7.1%)
  recoveryTargetPrice: number;
  status: DipEventStatus;
  expiresAt: number;
  associatedNewsIds?: number[];
  positionSymbol?: string;
  notes?: string;
}

export interface DipEntryProposal {
  symbol: string;
  decision: 'enter' | 'wait';
  notionalUsd?: number;
  reasoning?: string;
  signals?: ProposalSignals;
}

export type CongressSignals = Record<string, CongressTradeSignal[]>;

export interface GuardrailOutcome {
  status: 'approved' | 'rejected' | 'clamped';
  reason?: string;
  clampedProposal?: TradeProposal;
}
