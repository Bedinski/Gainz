import { computeATR } from '../trading/atr.js';
import type { MarketSnapshot, PortfolioSnapshot } from '../trading/types.js';
import type { AlpacaClient } from './client.js';

export async function fetchMarketSnapshot(
  client: AlpacaClient,
  symbols: string[],
  opts: { lookbackDays?: number } = {},
): Promise<MarketSnapshot> {
  const lookback = opts.lookbackDays ?? 60;
  const start = new Date(Date.now() - lookback * 24 * 60 * 60 * 1000).toISOString();
  const out: MarketSnapshot = {};
  if (symbols.length === 0) return out;

  // Batch the two data calls. The per-symbol shape downstream is identical to
  // the previous loop — same bars, same latestPrice fallback, same ATR.
  const [barsMap, quotesMap] = await Promise.all([
    client.getBarsBatch(symbols, { timeframe: '1Day', start, limit: lookback }),
    client.getLatestQuotesBatch(symbols),
  ]);

  for (const symbol of symbols) {
    const bars = barsMap[symbol] ?? [];
    const quote = quotesMap[symbol] ?? { ap: 0, bp: 0, t: '' };
    const latestPrice = quote.ap || (bars.at(-1)?.c ?? 0);
    const atr14 = computeATR(
      bars.map((b) => ({ high: b.h, low: b.l, close: b.c })),
      14,
    );
    out[symbol] = {
      symbol,
      latestPrice,
      atr14,
      bars: bars.map((b) => ({ t: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })),
    };
  }

  return out;
}

export async function fetchPortfolioSnapshot(
  client: AlpacaClient,
  realizedPnlToday: number,
  tradeCountToday: number,
): Promise<PortfolioSnapshot> {
  const account = await client.getAccount();
  const positions = await client.getPositions();
  return {
    cashUsd: parseFloat(account.cash),
    equityUsd: parseFloat(account.equity),
    realizedPnlToday,
    tradeCountToday,
    positions: positions.map((p) => ({
      symbol: p.symbol,
      qty: parseFloat(p.qty),
      avgEntryPrice: parseFloat(p.avg_entry_price),
      currentPrice: parseFloat(p.current_price),
      unrealizedPlPct: parseFloat(p.unrealized_plpc),
    })),
  };
}
