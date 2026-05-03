import { describe, it, expect, beforeEach } from 'vitest';
import { planManagement, type ManagedPosition } from '../src/trading/manage.js';
import { clearConfigCacheForTests, loadConfig } from '../src/trading/config.js';

const env = {
  TRADING_MODE: 'paper',
  TRAILING_STOP_PCT: '3',
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => clearConfigCacheForTests());

describe('planManagement', () => {
  it('upgrades to trailing once price has risen enough', () => {
    const cfg = loadConfig(env);
    const pos: ManagedPosition = {
      symbol: 'AAPL',
      entryPrice: 100,
      qty: 10,
      currentPrice: 110, // up 10%
      highestPriceSeen: 110,
      currentStopType: 'fixed',
      currentStopPrice: 97.5, // 2.5% below entry
      trailingStopPct: 3,
    };
    // trailing floor at 110 * 0.97 = 106.7 > 97.5 → upgrade
    const action = planManagement(pos, cfg);
    expect(action.kind).toBe('upgrade-to-trailing');
    if (action.kind === 'upgrade-to-trailing') {
      expect(action.trailPct).toBe(3);
      expect(action.qty).toBe(10);
    }
  });

  it('does not upgrade when trailing floor is below the fixed stop', () => {
    const cfg = loadConfig(env);
    const pos: ManagedPosition = {
      symbol: 'AAPL',
      entryPrice: 100,
      qty: 10,
      currentPrice: 100, // flat
      highestPriceSeen: 100,
      currentStopType: 'fixed',
      currentStopPrice: 97.5,
      trailingStopPct: 3,
    };
    // trailing floor at 100 * 0.97 = 97 < 97.5 fixed → noop
    const action = planManagement(pos, cfg);
    expect(action.kind).toBe('noop');
  });

  it('uses highest_price_seen, not just current price', () => {
    const cfg = loadConfig(env);
    const pos: ManagedPosition = {
      symbol: 'AAPL',
      entryPrice: 100,
      qty: 10,
      currentPrice: 105,
      highestPriceSeen: 115, // already saw a peak earlier
      currentStopType: 'fixed',
      currentStopPrice: 97.5,
      trailingStopPct: 3,
    };
    // trailing floor = max(115, 105) * 0.97 = 111.55 > 97.5 → upgrade
    const action = planManagement(pos, cfg);
    expect(action.kind).toBe('upgrade-to-trailing');
  });

  it('is a noop when already trailing', () => {
    const cfg = loadConfig(env);
    const pos: ManagedPosition = {
      symbol: 'AAPL',
      entryPrice: 100,
      qty: 10,
      currentPrice: 200,
      highestPriceSeen: 200,
      currentStopType: 'trailing',
      currentStopPrice: null,
      trailingStopPct: 3,
    };
    expect(planManagement(pos, cfg).kind).toBe('noop');
  });
});
