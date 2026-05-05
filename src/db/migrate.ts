import { getRawSqlite } from './client.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  raw_response TEXT NOT NULL,
  parsed_proposals_json TEXT NOT NULL,
  market_snapshot_json TEXT NOT NULL,
  congress_signals_json TEXT NOT NULL,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  qty REAL,
  notional_usd REAL,
  entry_type TEXT CHECK (entry_type IN ('market','stop','limit')),
  entry_trigger_price REAL,
  stop_loss_pct REAL,
  trailing_stop_pct REAL,
  reasoning TEXT,
  guardrail_status TEXT NOT NULL CHECK (guardrail_status IN ('approved','rejected','clamped')),
  guardrail_reason TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER REFERENCES proposals(id),
  alpaca_order_id TEXT,
  parent_alpaca_order_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  type TEXT NOT NULL CHECK (type IN ('market','stop','stop_limit','trailing_stop','limit')),
  qty REAL NOT NULL,
  notional_usd REAL,
  status TEXT NOT NULL,
  filled_avg_price REAL,
  submitted_at INTEGER NOT NULL,
  filled_at INTEGER,
  decision_audit TEXT
);

CREATE TABLE IF NOT EXISTS positions_meta (
  symbol TEXT PRIMARY KEY,
  opened_at INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  qty REAL NOT NULL,
  atr_at_entry REAL NOT NULL,
  current_stop_alpaca_order_id TEXT,
  current_stop_type TEXT NOT NULL CHECK (current_stop_type IN ('fixed','trailing')),
  current_stop_price REAL,
  trailing_stop_pct REAL,
  highest_price_seen REAL NOT NULL,
  strategy_tag TEXT NOT NULL DEFAULT 'momentum' CHECK (strategy_tag IN ('momentum','dip_recovery')),
  target_price REAL,
  time_exit_at INTEGER,
  dip_event_id INTEGER,
  -- iter4: GICS sector tag for portfolio-level sector exposure cap
  sector TEXT
);

CREATE TABLE IF NOT EXISTS daily_state (
  date TEXT PRIMARY KEY,
  realized_pnl REAL NOT NULL DEFAULT 0,
  dip_realized_pnl REAL NOT NULL DEFAULT 0,
  trade_count INTEGER NOT NULL DEFAULT 0,
  halted INTEGER NOT NULL DEFAULT 0,
  halt_reason TEXT
);

CREATE TABLE IF NOT EXISTS dip_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  peak_price REAL NOT NULL,
  peak_date TEXT NOT NULL,
  trough_price REAL NOT NULL,
  trough_date TEXT NOT NULL,
  drawdown_pct REAL NOT NULL,
  recovery_target_price REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','entered','recovered','expired','failed')),
  expires_at INTEGER NOT NULL,
  associated_news_ids TEXT,
  position_symbol TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS dip_events_status ON dip_events(status, symbol);

CREATE TABLE IF NOT EXISTS bot_state (
  id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  -- iter4: 'normal' | 'drain' (close-only, reject new buys) | 'off' (same as enabled=0)
  mode TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal','drain','off'))
);

-- iter4: rolling per-cycle equity snapshot for the 30d drawdown circuit breaker.
CREATE TABLE IF NOT EXISTS equity_history (
  recorded_at INTEGER PRIMARY KEY, -- ms epoch; one row per cycle
  date TEXT NOT NULL,              -- YYYY-MM-DD for cheap day-grouped queries
  equity_usd REAL NOT NULL,
  cash_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS equity_history_date ON equity_history(date);

-- iter4: position-vs-broker reconciliation runs.
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at INTEGER NOT NULL,
  mismatches INTEGER NOT NULL DEFAULT 0,
  severity TEXT NOT NULL DEFAULT 'ok' CHECK (severity IN ('ok','warn','critical')),
  mismatches_json TEXT
);
CREATE INDEX IF NOT EXISTS reconciliation_runs_at ON reconciliation_runs(run_at);

-- iter4: daily post-mortem output. One row per trading day.
CREATE TABLE IF NOT EXISTS postmortems (
  date TEXT PRIMARY KEY, -- YYYY-MM-DD
  generated_at INTEGER NOT NULL,
  summary_md TEXT NOT NULL,
  lessons_json TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER
);

-- iter4: alert dispatch log. Used for dedupe (key+TTL) and audit.
CREATE TABLE IF NOT EXISTS alerts_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at INTEGER NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','critical')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  transports TEXT NOT NULL, -- comma-separated (e.g. 'smtp,webhook')
  error TEXT
);
CREATE INDEX IF NOT EXISTS alerts_dedupe ON alerts_sent(dedupe_key, sent_at);

CREATE TABLE IF NOT EXISTS congress_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('stockwatcher','capitoltrades','quiver')),
  source_id TEXT NOT NULL,
  filer_name TEXT NOT NULL,
  filer_chamber TEXT CHECK (filer_chamber IN ('senate','house')),
  filer_party TEXT,
  filer_state TEXT,
  filer_committees TEXT,
  filer_is_politician INTEGER NOT NULL DEFAULT 1,
  symbol TEXT NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('buy','sell','exchange')),
  transaction_date TEXT NOT NULL,
  disclosure_date TEXT,
  amount_min_usd REAL,
  amount_max_usd REAL,
  committee_fit_boost INTEGER NOT NULL DEFAULT 0,
  cluster_size INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS congress_source_unique ON congress_trades(source, source_id);
CREATE INDEX IF NOT EXISTS congress_symbol_date ON congress_trades(symbol, transaction_date);

CREATE TABLE IF NOT EXISTS earnings_calendar (
  symbol TEXT NOT NULL,
  earnings_date TEXT NOT NULL,
  time_of_day TEXT NOT NULL DEFAULT 'unknown' CHECK (time_of_day IN ('bmo','amc','unknown')),
  source TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS earnings_pk ON earnings_calendar(symbol, earnings_date);

CREATE TABLE IF NOT EXISTS news_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  headline TEXT NOT NULL,
  summary TEXT,
  url TEXT,
  source TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'unclassified' CHECK (
    category IN ('earnings','guidance','m_and_a','regulatory','exec_change','analyst','recap','political_shock','other','unclassified')
  ),
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  classified_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS news_source_symbol_unique ON news_items(source_id, symbol);
CREATE INDEX IF NOT EXISTS news_symbol_published ON news_items(symbol, published_at);
CREATE INDEX IF NOT EXISTS news_symbol_category ON news_items(symbol, category);
`;

/**
 * Idempotent ALTER TABLE statements for adding columns to tables created in
 * previous iterations. SQLite has no `ADD COLUMN IF NOT EXISTS`, so we run
 * each one and swallow the "duplicate column name" error. New databases get
 * these columns from CREATE TABLE; existing databases pick them up here.
 */
const ADDITIVE_MIGRATIONS: string[] = [
  // iter3: positions_meta strategy fields
  `ALTER TABLE positions_meta ADD COLUMN strategy_tag TEXT NOT NULL DEFAULT 'momentum'`,
  `ALTER TABLE positions_meta ADD COLUMN target_price REAL`,
  `ALTER TABLE positions_meta ADD COLUMN time_exit_at INTEGER`,
  `ALTER TABLE positions_meta ADD COLUMN dip_event_id INTEGER`,
  // iter3: daily_state dip P&L bucket
  `ALTER TABLE daily_state ADD COLUMN dip_realized_pnl REAL NOT NULL DEFAULT 0`,
  // iter4: positions_meta sector tag (populated from SYMBOL_SECTOR lookup)
  `ALTER TABLE positions_meta ADD COLUMN sector TEXT`,
  // iter4: bot_state mode for normal / drain / off triage
  `ALTER TABLE bot_state ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal'`,
];

export function applySchema(db = getRawSqlite()) {
  db.exec(SCHEMA_SQL);
  for (const stmt of ADDITIVE_MIGRATIONS) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = String(err);
      if (!/duplicate column name/i.test(msg)) throw err;
    }
  }
  rebuildNewsItemsIfStale(db);
}

/**
 * SQLite can't ALTER a CHECK constraint in place, so when the news classifier's
 * category vocabulary grows we have to rebuild the table. Detect the stale
 * shape via sqlite_master and rebuild only when needed; subsequent runs are
 * no-ops. Existing rows are preserved (no news data is critical, but losing it
 * on every restart would be silly).
 *
 * Trigger: news_items.category CHECK omits 'political_shock' (added when the
 * dip-recovery strategy needed political-headline gating).
 */
function rebuildNewsItemsIfStale(db: ReturnType<typeof getRawSqlite>): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='news_items'")
    .get() as { sql: string } | undefined;
  if (!row || !row.sql) return; // fresh DB — CREATE TABLE already used the new constraint
  if (row.sql.includes("'political_shock'")) return; // already current
  db.exec(`
    BEGIN;
    ALTER TABLE news_items RENAME TO news_items_old;
    CREATE TABLE news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      headline TEXT NOT NULL,
      summary TEXT,
      url TEXT,
      source TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'unclassified' CHECK (
        category IN ('earnings','guidance','m_and_a','regulatory','exec_change','analyst','recap','political_shock','other','unclassified')
      ),
      published_at INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL,
      classified_at INTEGER
    );
    INSERT INTO news_items (id, source_id, symbol, headline, summary, url, source, category, published_at, fetched_at, classified_at)
      SELECT id, source_id, symbol, headline, summary, url, source, category, published_at, fetched_at, classified_at
      FROM news_items_old;
    DROP TABLE news_items_old;
    CREATE UNIQUE INDEX IF NOT EXISTS news_source_symbol_unique ON news_items(source_id, symbol);
    CREATE INDEX IF NOT EXISTS news_symbol_published ON news_items(symbol, published_at);
    CREATE INDEX IF NOT EXISTS news_symbol_category ON news_items(symbol, category);
    COMMIT;
  `);
}
