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
  status TEXT NOT NULL,
  filled_avg_price REAL,
  submitted_at INTEGER NOT NULL,
  filled_at INTEGER
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
  highest_price_seen REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_state (
  date TEXT PRIMARY KEY,
  realized_pnl REAL NOT NULL DEFAULT 0,
  trade_count INTEGER NOT NULL DEFAULT 0,
  halted INTEGER NOT NULL DEFAULT 0,
  halt_reason TEXT
);

CREATE TABLE IF NOT EXISTS bot_state (
  id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS congress_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('stockwatcher','capitoltrades','quiver')),
  source_id TEXT NOT NULL,
  filer_name TEXT NOT NULL,
  filer_chamber TEXT CHECK (filer_chamber IN ('senate','house')),
  filer_party TEXT,
  filer_state TEXT,
  filer_committees TEXT,
  symbol TEXT NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('buy','sell','exchange')),
  transaction_date TEXT NOT NULL,
  disclosure_date TEXT,
  amount_min_usd REAL,
  amount_max_usd REAL,
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
`;

export function applySchema(db = getRawSqlite()) {
  db.exec(SCHEMA_SQL);
}
