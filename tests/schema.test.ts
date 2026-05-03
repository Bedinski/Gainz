import { describe, it, expect } from 'vitest';
import { decisionResponseSchema, extractJson, toCamel } from '../src/claude/schema.js';

describe('extractJson', () => {
  it('parses raw JSON', () => {
    expect(extractJson('{"proposals":[]}')).toEqual({ proposals: [] });
  });

  it('parses fenced JSON', () => {
    expect(
      extractJson('Here is my answer:\n\n```json\n{"proposals":[]}\n```\n'),
    ).toEqual({ proposals: [] });
  });

  it('parses JSON embedded in prose', () => {
    expect(
      extractJson('Sure, my response is {"proposals":[]} and that is all.'),
    ).toEqual({ proposals: [] });
  });

  it('throws on no JSON', () => {
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('decisionResponseSchema', () => {
  it('parses a valid response and uppercases the symbol', () => {
    const parsed = decisionResponseSchema.parse({
      proposals: [
        { symbol: 'aapl', side: 'buy', notional_usd: 500, stop_loss_pct: 2.5, reasoning: 'ok' },
      ],
    });
    expect(parsed.proposals[0]!.symbol).toBe('AAPL');
  });

  it('rejects negative notional', () => {
    expect(() =>
      decisionResponseSchema.parse({
        proposals: [{ symbol: 'AAPL', side: 'buy', notional_usd: -1 }],
      }),
    ).toThrow();
  });

  it('rejects unknown side', () => {
    expect(() =>
      decisionResponseSchema.parse({
        proposals: [{ symbol: 'AAPL', side: 'short' }],
      }),
    ).toThrow();
  });
});

describe('toCamel', () => {
  it('maps snake_case to camelCase', () => {
    const camel = toCamel({
      symbol: 'AAPL',
      side: 'buy',
      notional_usd: 500,
      stop_loss_pct: 2.5,
      trailing_stop_pct: 3,
      entry_type: 'stop',
    });
    expect(camel).toMatchObject({
      symbol: 'AAPL',
      side: 'buy',
      notionalUsd: 500,
      stopLossPct: 2.5,
      trailingStopPct: 3,
      entryType: 'stop',
    });
  });
});
