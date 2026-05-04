import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRestClient } from '../src/alpaca/client.js';
import { fetchMarketSnapshot } from '../src/alpaca/market.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';
import type { AlpacaClient } from '../src/alpaca/client.js';

const env = {
  TRADING_MODE: 'paper',
  SYMBOL_ALLOWLIST: 'AAPL,NVDA,SPY',
  ALPACA_KEY_ID: 'k',
  ALPACA_SECRET_KEY: 's',
  SQLITE_PATH: ':memory:',
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  clearConfigCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AlpacaClient batch endpoints', () => {
  it('getBarsBatch hits /v2/stocks/bars once and demultiplexes the response', async () => {
    const cfg = loadConfig(env);
    const client = createRestClient(cfg);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          bars: {
            AAPL: [{ t: '2026-04-01T00:00:00Z', o: 180, h: 185, l: 175, c: 182, v: 1_000_000 }],
            NVDA: [{ t: '2026-04-01T00:00:00Z', o: 900, h: 920, l: 890, c: 910, v: 500_000 }],
          },
          next_page_token: null,
        };
      },
    } as unknown as Response);

    const bars = await client.getBarsBatch(['AAPL', 'NVDA', 'TSLA'], {
      timeframe: '1Day',
      start: '2026-03-01T00:00:00Z',
      limit: 30,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain('/v2/stocks/bars?');
    expect(url).toContain('symbols=AAPL%2CNVDA%2CTSLA');
    expect(bars.AAPL).toHaveLength(1);
    expect(bars.NVDA).toHaveLength(1);
    // Symbols absent from response still appear with empty array.
    expect(bars.TSLA).toEqual([]);
  });

  it('getBarsBatch follows next_page_token to assemble multi-page responses', async () => {
    const cfg = loadConfig(env);
    const client = createRestClient(cfg);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        async json() {
          return {
            bars: { AAPL: [{ t: '2026-04-01T00:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 }] },
            next_page_token: 'tok',
          };
        },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        async json() {
          return {
            bars: { AAPL: [{ t: '2026-04-02T00:00:00Z', o: 2, h: 2, l: 2, c: 2, v: 2 }] },
          };
        },
      } as unknown as Response);

    const bars = await client.getBarsBatch(['AAPL'], { timeframe: '1Day', start: '2026-03-01' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bars.AAPL).toHaveLength(2);
    expect(bars.AAPL![0]!.c).toBe(1);
    expect(bars.AAPL![1]!.c).toBe(2);
  });

  it('getLatestQuotesBatch returns one quote per requested symbol, falling back to zeroes', async () => {
    const cfg = loadConfig(env);
    const client = createRestClient(cfg);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          quotes: {
            AAPL: { ap: 182.1, bp: 181.95, t: '2026-04-01T15:00:00Z' },
          },
        };
      },
    } as unknown as Response);

    const quotes = await client.getLatestQuotesBatch(['AAPL', 'NVDA']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain('/v2/stocks/quotes/latest?');
    expect(url).toContain('symbols=AAPL%2CNVDA');
    expect(quotes.AAPL!.ap).toBe(182.1);
    // Symbols absent from response fall back to zeros (downstream uses bar close).
    expect(quotes.NVDA!.ap).toBe(0);
  });
});

describe('fetchMarketSnapshot uses batched calls', () => {
  it('makes exactly one getBarsBatch + one getLatestQuotesBatch call regardless of symbol count', async () => {
    let barsCalls = 0;
    let quotesCalls = 0;
    let perSymbolCalls = 0;
    const bars = [
      { t: '2026-04-01T00:00:00Z', o: 100, h: 102, l: 98, c: 101, v: 1000 },
      { t: '2026-04-02T00:00:00Z', o: 101, h: 105, l: 100, c: 104, v: 1500 },
    ];
    const client: AlpacaClient = {
      getClock: async () => ({ is_open: true, next_open: '', next_close: '' }),
      getAccount: async () => ({ cash: '0', equity: '0', portfolio_value: '0' }),
      getSettledCash: async () => 0,
      getPositions: async () => [],
      getOrders: async () => [],
      getBars: async () => {
        perSymbolCalls++;
        return bars;
      },
      getBarsBatch: async (symbols) => {
        barsCalls++;
        return Object.fromEntries(symbols.map((s) => [s, bars]));
      },
      getLatestQuote: async () => {
        perSymbolCalls++;
        return { ap: 104, bp: 103.95, t: '' };
      },
      getLatestQuotesBatch: async (symbols) => {
        quotesCalls++;
        return Object.fromEntries(symbols.map((s) => [s, { ap: 104, bp: 103.95, t: '' }]));
      },
      submitBracket: async () => ({ id: '', status: '', legs: [] }),
      submitNotionalBracket: async () => ({ parentOrderId: '', parentStatus: '' }),
      submitTrailingStop: async () => ({ id: '', status: '' }),
      submitMarket: async () => ({ id: '', status: '' }),
      submitStop: async () => ({ id: '', status: '' }),
      cancelOrder: async () => undefined,
      getOrder: async () => ({ id: '', status: '', filled_avg_price: null, filled_qty: null, filled_at: null }),
    };

    const snapshot = await fetchMarketSnapshot(client, ['AAPL', 'NVDA', 'SPY', 'QQQ']);

    expect(barsCalls).toBe(1);
    expect(quotesCalls).toBe(1);
    expect(perSymbolCalls).toBe(0); // never falls back to single-symbol path
    expect(Object.keys(snapshot).sort()).toEqual(['AAPL', 'NVDA', 'QQQ', 'SPY']);
    expect(snapshot.AAPL!.bars).toHaveLength(2);
    expect(snapshot.AAPL!.latestPrice).toBe(104);
  });

  it('returns empty snapshot for empty symbol list without making any calls', async () => {
    let calls = 0;
    const client: AlpacaClient = {
      getClock: async () => ({ is_open: true, next_open: '', next_close: '' }),
      getAccount: async () => ({ cash: '0', equity: '0', portfolio_value: '0' }),
      getSettledCash: async () => 0,
      getPositions: async () => [],
      getOrders: async () => [],
      getBars: async () => {
        calls++;
        return [];
      },
      getBarsBatch: async () => {
        calls++;
        return {};
      },
      getLatestQuote: async () => {
        calls++;
        return { ap: 0, bp: 0, t: '' };
      },
      getLatestQuotesBatch: async () => {
        calls++;
        return {};
      },
      submitBracket: async () => ({ id: '', status: '', legs: [] }),
      submitNotionalBracket: async () => ({ parentOrderId: '', parentStatus: '' }),
      submitTrailingStop: async () => ({ id: '', status: '' }),
      submitMarket: async () => ({ id: '', status: '' }),
      submitStop: async () => ({ id: '', status: '' }),
      cancelOrder: async () => undefined,
      getOrder: async () => ({ id: '', status: '', filled_avg_price: null, filled_qty: null, filled_at: null }),
    };

    const snapshot = await fetchMarketSnapshot(client, []);
    expect(snapshot).toEqual({});
    expect(calls).toBe(0);
  });
});
