import type { CongressSignalProvider, RawCongressTrade } from './provider.js';

/**
 * Optional provider — off by default. capitoltrades.com's ToS prohibits scraping
 * and the DOM may change. Implementation is intentionally a stub that raises
 * unless explicitly enabled by a user who has read their ToS.
 */
export class CapitolTradesProvider implements CongressSignalProvider {
  readonly name = 'capitoltrades' as const;

  async fetchRecent(_opts: { lookbackDays: number }): Promise<RawCongressTrade[]> {
    throw new Error(
      'CapitolTrades provider is not implemented by default; use stockwatcher (free) or quiver (API key).',
    );
  }
}
