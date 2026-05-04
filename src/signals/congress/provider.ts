import type { Config } from '../../trading/config.js';

export interface RawCongressTrade {
  source: 'stockwatcher' | 'capitoltrades' | 'quiver';
  sourceId: string;
  filerName: string;
  filerChamber?: 'senate' | 'house';
  filerParty?: string;
  filerState?: string;
  filerCommittees?: string[];
  /**
   * True iff the filing is the politician's own trade. False for spouse,
   * dependent child, blind-trust, or financial-advisor managed disclosures.
   * Defaults to true if the upstream feed doesn't distinguish (provider must
   * fill this honestly when the data is available).
   */
  filerIsPolitician?: boolean;
  symbol: string;
  transactionType: 'buy' | 'sell' | 'exchange';
  transactionDate: string; // YYYY-MM-DD
  disclosureDate?: string;
  amountMinUsd?: number;
  amountMaxUsd?: number;
  raw: unknown;
}

export interface CongressSignalProvider {
  readonly name: 'stockwatcher' | 'capitoltrades' | 'quiver';
  fetchRecent(opts: { lookbackDays: number }): Promise<RawCongressTrade[]>;
}

export async function getProvider(cfg: Config): Promise<CongressSignalProvider> {
  switch (cfg.CONGRESS_SIGNAL_PROVIDER) {
    case 'stockwatcher': {
      const { StockWatcherProvider } = await import('./stockwatcher.js');
      return new StockWatcherProvider();
    }
    case 'capitoltrades': {
      const { CapitolTradesProvider } = await import('./capitoltrades.js');
      return new CapitolTradesProvider();
    }
    case 'quiver': {
      if (!cfg.QUIVER_API_KEY) throw new Error('QUIVER_API_KEY required for quiver provider');
      const { QuiverProvider } = await import('./quiver.js');
      return new QuiverProvider(cfg.QUIVER_API_KEY);
    }
  }
}
