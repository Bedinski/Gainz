import { z } from 'zod';

/**
 * Proper string-to-boolean coercer. `boolFromEnv` is broken for our
 * use: it does `Boolean(value)`, which makes any non-empty string true —
 * including the literal "false". Anyone with `SAFE_MODE=false` in their .env
 * would otherwise get SAFE_MODE on. Treat the standard truthy spellings as
 * true and everything else as false.
 */
const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    return /^(1|true|yes|on)$/i.test(v.trim());
  });

/**
 * Optional positive number that treats empty-string env values as absent.
 * `z.coerce.number()` would otherwise turn "" into 0, which then fails
 * `.positive()` — anyone leaving `TAKE_PROFIT_PCT=` blank in .env hits this.
 */
const optionalPositive = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? undefined : v),
  z.coerce.number().positive().optional(),
);

const envSchema = z.object({
  TRADING_MODE: z.enum(['paper', 'live']).default('paper'),
  LIVE_TRADING_CONFIRMED: z.string().optional(),
  SAFE_MODE: boolFromEnv.default(false),

  ALPACA_KEY_ID: z.string().optional(),
  ALPACA_SECRET_KEY: z.string().optional(),

  BOT_TOKEN: z.string().optional(),

  CRON_SCHEDULE: z.string().default('*/15 9-16 * * 1-5'),
  CRON_TZ: z.string().default('America/New_York'),

  SQLITE_PATH: z.string().default('./data/gainz.db'),

  SYMBOL_ALLOWLIST: z
    .string()
    .default('AAPL,MSFT,NVDA,GOOGL,AMZN,META,TSLA,AMD,AVGO,JPM')
    .transform((s) => s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)),

  MAX_POSITION_USD: z.coerce.number().positive().default(2000),
  MAX_ORDER_USD: z.coerce.number().positive().default(1000),
  MAX_DAILY_LOSS_USD: z.coerce.number().positive().default(500),
  MAX_TRADES_PER_DAY: z.coerce.number().int().positive().default(10),

  STOP_LOSS_PCT: z.coerce.number().positive().default(2.5),
  STOP_LOSS_MIN_PCT: z.coerce.number().positive().default(1.5),
  STOP_LOSS_MAX_PCT: z.coerce.number().positive().default(8),
  ATR_MULT: z.coerce.number().positive().default(1.5),
  TRAILING_STOP_PCT: z.coerce.number().positive().default(3),
  TRAILING_MIN_PCT: z.coerce.number().positive().default(2),
  TRAILING_MAX_PCT: z.coerce.number().positive().default(8),
  TAKE_PROFIT_PCT: optionalPositive,
  ENTRY_TRIGGER_PCT: z.coerce.number().min(0).default(0.3),
  ENTRY_MAX_OFFSET_PCT: z.coerce.number().min(0).default(1),
  ENTRY_ORDER_TTL_MIN: z.coerce.number().int().positive().default(30),
  EXIT_LIMIT_PCT: z.coerce.number().min(0).default(0.5),
  EARNINGS_BLACKOUT_DAYS: z.coerce.number().int().min(0).default(3),

  CLAUDE_AUTH_DIR: z.string().default('./claude-auth'),
  CLAUDE_MODEL: z.string().default('claude-sonnet-4-6'),

  CONGRESS_SIGNAL_PROVIDER: z.enum(['stockwatcher', 'capitoltrades', 'quiver']).default('stockwatcher'),
  CONGRESS_LOOKBACK_DAYS: z.coerce.number().int().positive().default(30),
  CONGRESS_MAX_TRADES_PER_SYMBOL: z.coerce.number().int().positive().default(5),
  CONGRESS_REQUIRE_OWN_TRADE: boolFromEnv.default(true),
  CONGRESS_MIN_AMOUNT_USD: z.coerce.number().min(0).default(50000),
  CONGRESS_MAX_AGE_DAYS: z.coerce.number().int().positive().default(14),
  CLUSTER_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  QUIVER_API_KEY: z.string().optional(),

  ALPACA_NEWS_ENABLED: boolFromEnv.default(false),
  NEWS_LOOKBACK_HOURS: z.coerce.number().int().positive().default(24),
  NEWS_MAX_ITEMS_PER_SYMBOL: z.coerce.number().int().positive().default(3),
  NEWS_CATEGORIES_ALLOWED: z
    .string()
    .default('earnings,guidance,m_and_a,regulatory,exec_change')
    .transform((s) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)),
  NEWS_CLASSIFIER_MODEL: z.string().default('claude-haiku-4-5-20251001'),

  RESERVE_SETTLED_CASH_USD: z.coerce.number().min(0).default(50),
  MIN_SIGNAL_SCORE: z.coerce.number().int().min(0).default(3),
  MAX_CONFLICTS: z.coerce.number().int().min(0).default(0),

  PROMPT_VERSION: z.string().default('v2'),

  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (_config) return _config;
  _config = envSchema.parse(env);
  return _config;
}

export function isLiveAllowed(cfg: Config): boolean {
  return cfg.TRADING_MODE === 'live' && cfg.LIVE_TRADING_CONFIRMED === 'yes-i-mean-it';
}

export function clearConfigCacheForTests() {
  _config = null;
}
