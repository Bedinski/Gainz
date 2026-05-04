import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const decisions = sqliteTable('decisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
  model: text('model').notNull(),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  rawResponse: text('raw_response').notNull(),
  parsedProposalsJson: text('parsed_proposals_json').notNull(),
  marketSnapshotJson: text('market_snapshot_json').notNull(),
  congressSignalsJson: text('congress_signals_json').notNull(),
  errorMessage: text('error_message'),
});

export const proposals = sqliteTable('proposals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  decisionId: integer('decision_id').notNull().references(() => decisions.id),
  symbol: text('symbol').notNull(),
  side: text('side', { enum: ['buy', 'sell'] }).notNull(),
  qty: real('qty'),
  notionalUsd: real('notional_usd'),
  entryType: text('entry_type', { enum: ['market', 'stop', 'limit'] }),
  entryTriggerPrice: real('entry_trigger_price'),
  stopLossPct: real('stop_loss_pct'),
  trailingStopPct: real('trailing_stop_pct'),
  reasoning: text('reasoning'),
  guardrailStatus: text('guardrail_status', { enum: ['approved', 'rejected', 'clamped'] }).notNull(),
  guardrailReason: text('guardrail_reason'),
});

export const orders = sqliteTable('orders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  proposalId: integer('proposal_id').references(() => proposals.id),
  alpacaOrderId: text('alpaca_order_id'),
  parentAlpacaOrderId: text('parent_alpaca_order_id'),
  symbol: text('symbol').notNull(),
  side: text('side', { enum: ['buy', 'sell'] }).notNull(),
  type: text('type', {
    enum: ['market', 'stop', 'stop_limit', 'trailing_stop', 'limit'],
  }).notNull(),
  qty: real('qty').notNull(),
  notionalUsd: real('notional_usd'),
  status: text('status').notNull(),
  filledAvgPrice: real('filled_avg_price'),
  submittedAt: integer('submitted_at', { mode: 'timestamp_ms' }).notNull(),
  filledAt: integer('filled_at', { mode: 'timestamp_ms' }),
  decisionAudit: text('decision_audit'),
});

export const positionsMeta = sqliteTable('positions_meta', {
  symbol: text('symbol').primaryKey(),
  openedAt: integer('opened_at', { mode: 'timestamp_ms' }).notNull(),
  entryPrice: real('entry_price').notNull(),
  qty: real('qty').notNull(),
  atrAtEntry: real('atr_at_entry').notNull(),
  currentStopAlpacaOrderId: text('current_stop_alpaca_order_id'),
  currentStopType: text('current_stop_type', { enum: ['fixed', 'trailing'] }).notNull(),
  currentStopPrice: real('current_stop_price'),
  trailingStopPct: real('trailing_stop_pct'),
  highestPriceSeen: real('highest_price_seen').notNull(),
  // iter3: which strategy opened this position. Drives exit dispatch.
  strategyTag: text('strategy_tag', { enum: ['momentum', 'dip_recovery'] })
    .notNull()
    .default('momentum'),
  // iter3: target-based exit (dip strategy populates; momentum leaves null).
  targetPrice: real('target_price'),
  // iter3: bailout deadline (ms). Dip strategy populates; momentum leaves null.
  timeExitAt: integer('time_exit_at', { mode: 'timestamp_ms' }),
  dipEventId: integer('dip_event_id'),
});

export const dailyState = sqliteTable('daily_state', {
  date: text('date').primaryKey(), // YYYY-MM-DD in CRON_TZ
  realizedPnl: real('realized_pnl').notNull().default(0),
  // iter3: realized P&L from dip-recovery strategy only (subset of realizedPnl)
  dipRealizedPnl: real('dip_realized_pnl').notNull().default(0),
  tradeCount: integer('trade_count').notNull().default(0),
  halted: integer('halted', { mode: 'boolean' }).notNull().default(false),
  haltReason: text('halt_reason'),
});

export const dipEvents = sqliteTable(
  'dip_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    symbol: text('symbol').notNull(),
    detectedAt: integer('detected_at', { mode: 'timestamp_ms' }).notNull(),
    peakPrice: real('peak_price').notNull(),
    peakDate: text('peak_date').notNull(),
    troughPrice: real('trough_price').notNull(),
    troughDate: text('trough_date').notNull(),
    drawdownPct: real('drawdown_pct').notNull(),
    recoveryTargetPrice: real('recovery_target_price').notNull(),
    status: text('status', {
      enum: ['active', 'entered', 'recovered', 'expired', 'failed'],
    }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    associatedNewsIds: text('associated_news_ids'), // JSON array of news_items.id
    positionSymbol: text('position_symbol'), // FK-by-convention to positions_meta.symbol
    notes: text('notes'),
  },
  (t) => ({
    statusSym: index('dip_events_status').on(t.status, t.symbol),
  }),
);

export const botState = sqliteTable('bot_state', {
  id: integer('id').primaryKey(), // singleton row, id=1
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const congressTrades = sqliteTable(
  'congress_trades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source', { enum: ['stockwatcher', 'capitoltrades', 'quiver'] }).notNull(),
    sourceId: text('source_id').notNull(),
    filerName: text('filer_name').notNull(),
    filerChamber: text('filer_chamber', { enum: ['senate', 'house'] }),
    filerParty: text('filer_party'),
    filerState: text('filer_state'),
    filerCommittees: text('filer_committees'),
    filerIsPolitician: integer('filer_is_politician', { mode: 'boolean' }).notNull().default(true),
    symbol: text('symbol').notNull(),
    transactionType: text('transaction_type', { enum: ['buy', 'sell', 'exchange'] }).notNull(),
    transactionDate: text('transaction_date').notNull(), // YYYY-MM-DD
    disclosureDate: text('disclosure_date'),
    amountMinUsd: real('amount_min_usd'),
    amountMaxUsd: real('amount_max_usd'),
    committeeFitBoost: integer('committee_fit_boost').notNull().default(0),
    clusterSize: integer('cluster_size').notNull().default(1),
    rawJson: text('raw_json').notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    sourceUnique: uniqueIndex('congress_source_unique').on(t.source, t.sourceId),
    symbolDate: index('congress_symbol_date').on(t.symbol, t.transactionDate),
  }),
);

export const newsItems = sqliteTable(
  'news_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: text('source_id').notNull(),
    symbol: text('symbol').notNull(),
    headline: text('headline').notNull(),
    summary: text('summary'),
    url: text('url'),
    source: text('source').notNull(), // e.g. "Benzinga"
    category: text('category', {
      enum: [
        'earnings',
        'guidance',
        'm_and_a',
        'regulatory',
        'exec_change',
        'analyst',
        'recap',
        'political_shock',
        'other',
        'unclassified',
      ],
    })
      .notNull()
      .default('unclassified'),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }).notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
    classifiedAt: integer('classified_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    pk: uniqueIndex('news_source_symbol_unique').on(t.sourceId, t.symbol),
    symbolPub: index('news_symbol_published').on(t.symbol, t.publishedAt),
    symbolCat: index('news_symbol_category').on(t.symbol, t.category),
  }),
);

export const earningsCalendar = sqliteTable(
  'earnings_calendar',
  {
    symbol: text('symbol').notNull(),
    earningsDate: text('earnings_date').notNull(), // YYYY-MM-DD
    timeOfDay: text('time_of_day', { enum: ['bmo', 'amc', 'unknown'] }).notNull().default('unknown'),
    source: text('source').notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pk: uniqueIndex('earnings_pk').on(t.symbol, t.earningsDate),
  }),
);
