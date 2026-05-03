# Gainz

AI-driven personal stock-trading app. Claude proposes trades on a 15-min cadence, hard-coded guardrails enforce limits, Alpaca executes.

> **Paper trading only by default.** Live trading requires both `TRADING_MODE=live` and `LIVE_TRADING_CONFIRMED=yes-i-mean-it`.

## Strategy at a glance

- **Entry:** stop-buy at +0.3% above current price (configurable). Forces the market to confirm the thesis before capital commits.
- **Exit:** Alpaca bracket order with a fixed stop-loss at `max(2.5%, 1.5× ATR(14))` below fill. Once the position is in profit, the cycle's `manage` step replaces the fixed stop with a 3% trailing stop so winners can run.
- **No shorting, no margin, no options.** Long-only on a configurable symbol allowlist.
- **Augmented with congressional STOCK Act filings** as a non-price signal (default source: free Senate/House Stock Watcher feeds).

See `src/trading/cycle.ts` for orchestration and `src/trading/guardrails.ts` for the safety rules.

## Development

```bash
npm install
cp .env.example .env.local       # fill in ALPACA + BOT_TOKEN
npm run db:migrate
npm test                         # unit tests, no network
npm run simulate                 # one fixture-driven cycle, no broker calls
npm run replay -- AAPL 2025-04-01 2025-04-30   # historical bars, real Alpaca paper key
npm run dev                      # Next.js UI on :3000
npm run dev:worker               # cron worker, in another terminal
```

## Deploying to Fly

```bash
fly launch --no-deploy
fly volumes create gainz_data --size 1
fly secrets set ALPACA_KEY_ID=... ALPACA_SECRET_KEY=... BOT_TOKEN=...
fly deploy
fly ssh console
# inside: run the Claude Agent SDK login flow once, token persists at /data/claude-auth/
```

## Promoting to live (after several days of clean paper)

```bash
fly secrets set TRADING_MODE=live LIVE_TRADING_CONFIRMED=yes-i-mean-it
# Start with very tight MAX_POSITION_USD / MAX_DAILY_LOSS_USD.
```
