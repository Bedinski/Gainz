import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StockWatcherProvider } from '../src/signals/congress/stockwatcher.js';

const senatePayload = [
  {
    transaction_date: '2026-04-22',
    disclosure_date: '2026-04-29',
    ticker: 'NVDA',
    type: 'Purchase',
    amount: '$50,001 - $100,000',
    senator: 'Jane Doe',
    party: 'R',
    state: 'TX',
  },
  {
    transaction_date: '2026-04-15',
    disclosure_date: '2026-04-25',
    ticker: '--',
    type: 'Sale (Full)',
    amount: '$15,001 - $50,000',
    senator: 'No Ticker',
  },
];

const housePayload = [
  {
    transaction_date: '2026-04-15',
    disclosure_date: '2026-04-25',
    ticker: 'AAPL',
    type: 'sale_partial',
    amount: '$15,001 - $50,000',
    representative: 'John Smith',
    party: 'D',
    state: 'CA',
  },
];

describe('StockWatcherProvider', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      const body = u.includes('senate') ? senatePayload : housePayload;
      return new Response(JSON.stringify(body), { status: 200 });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('parses + filters lookback', async () => {
    const p = new StockWatcherProvider();
    const trades = await p.fetchRecent({ lookbackDays: 365 });
    expect(trades.length).toBe(2); // skips '--' ticker row
    const nvda = trades.find((t) => t.symbol === 'NVDA')!;
    expect(nvda.transactionType).toBe('buy');
    expect(nvda.filerChamber).toBe('senate');
    expect(nvda.filerName).toBe('Jane Doe');
    expect(nvda.amountMinUsd).toBe(50001);
    expect(nvda.amountMaxUsd).toBe(100000);

    const aapl = trades.find((t) => t.symbol === 'AAPL')!;
    expect(aapl.transactionType).toBe('sell');
    expect(aapl.filerChamber).toBe('house');
  });

  it('filters out trades older than lookback', async () => {
    const p = new StockWatcherProvider();
    // lookback = 1 day, but fixtures are from 2026-04 — past relative to a normal Date.now,
    // so we instead check the boundary by mocking Date.now.
    const real = Date.now;
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2030-01-01').getTime());
    try {
      const trades = await p.fetchRecent({ lookbackDays: 30 });
      expect(trades.length).toBe(0);
    } finally {
      vi.spyOn(Date, 'now').mockImplementation(real);
    }
  });
});
