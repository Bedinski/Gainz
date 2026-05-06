import { getDb, getRawSqlite } from '@/db/client';
import { applySchema } from '@/db/migrate';
import { loadConfig } from '@/trading/config';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

interface DecisionRow {
  id: number;
  timestamp: number;
  model: string;
  parsed_proposals_json: string;
  error_message: string | null;
}

interface ProposalRow {
  symbol: string;
  side: string;
  guardrail_status: string;
  decision_id: number;
}

interface PositionMetaRow {
  symbol: string;
  entry_price: number;
  qty: number;
  current_stop_type: string;
  current_stop_price: number | null;
  highest_price_seen: number;
  strategy_tag: string;
  target_price: number | null;
  time_exit_at: number | null;
  dip_event_id: number | null;
}

interface DailyRow {
  realized_pnl: number;
  dip_realized_pnl: number;
  trade_count: number;
  halted: number;
  halt_reason: string | null;
}

interface DipEventRow {
  id: number;
  symbol: string;
  detected_at: number;
  peak_price: number;
  trough_price: number;
  drawdown_pct: number;
  recovery_target_price: number;
  status: 'active' | 'entered' | 'recovered' | 'expired' | 'failed';
  expires_at: number;
  position_symbol: string | null;
  notes: string | null;
}

interface PendingOrderRow {
  id: number;
  alpaca_order_id: string | null;
  symbol: string;
  side: string;
  type: string;
  qty: number;
  notional_usd: number | null;
  status: string;
  submitted_at: number;
}

export default function DashboardPage() {
  const cfg = loadConfig();
  getDb();
  applySchema();
  const db = getRawSqlite();

  const today = new Date().toISOString().slice(0, 10);
  const daily = db
    .prepare(
      'SELECT realized_pnl, dip_realized_pnl, trade_count, halted, halt_reason FROM daily_state WHERE date = ?',
    )
    .get(today) as DailyRow | undefined;

  const dipEvents = db
    .prepare(
      `SELECT id, symbol, detected_at, peak_price, trough_price, drawdown_pct,
              recovery_target_price, status, expires_at, position_symbol, notes
       FROM dip_events
       WHERE status IN ('active','entered')
       ORDER BY detected_at DESC
       LIMIT 10`,
    )
    .all() as DipEventRow[];

  const decisions = db
    .prepare(
      'SELECT id, timestamp, model, parsed_proposals_json, error_message FROM decisions ORDER BY timestamp DESC LIMIT 20',
    )
    .all() as DecisionRow[];

  const recentProposals = db
    .prepare(
      'SELECT symbol, side, guardrail_status, decision_id FROM proposals ORDER BY id DESC LIMIT 30',
    )
    .all() as ProposalRow[];

  const positions = db.prepare('SELECT * FROM positions_meta').all() as PositionMetaRow[];

  // Pending buy orders that haven't filled yet — stop-buys waiting for trigger,
  // notional brackets accepted but not yet filled, etc. These are real "plays
  // in motion" that don't appear in positions_meta until the entry actually
  // executes (per the deferred-positions_meta-on-fill fix).
  const pendingOrders = db
    .prepare(
      `SELECT id, alpaca_order_id, symbol, side, type, qty, notional_usd, status, submitted_at
         FROM orders
        WHERE status IN ('new', 'accepted', 'pending_new', 'partially_filled')
          AND side = 'buy'
        ORDER BY id DESC
        LIMIT 20`,
    )
    .all() as PendingOrderRow[];

  const activePlaysTotal = positions.length + pendingOrders.length + dipEvents.length;

  const botRow = db.prepare('SELECT enabled FROM bot_state WHERE id = 1').get() as { enabled: number } | undefined;
  const botEnabled = botRow?.enabled !== 0;

  return (
    <main>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>Gainz</h1>
        <div className="muted mono">
          mode:{' '}
          <span className={`badge ${cfg.TRADING_MODE === 'live' ? 'badge-live' : 'badge-paper'}`}>
            {cfg.TRADING_MODE}
          </span>{' '}
          {cfg.SAFE_MODE && <span className="badge badge-clamped">SAFE_MODE</span>}{' '}
          bot: <strong>{botEnabled ? 'on' : 'off'}</strong>
        </div>
      </div>

      <section className="card">
        <h3>Today</h3>
        <div className="row">
          <div>
            <div className="muted">Realized P&L</div>
            <div style={{ fontSize: 22 }}>${(daily?.realized_pnl ?? 0).toFixed(2)}</div>
          </div>
          <div>
            <div className="muted">Trades</div>
            <div style={{ fontSize: 22 }}>
              {daily?.trade_count ?? 0} / {cfg.MAX_TRADES_PER_DAY}
            </div>
          </div>
          <div>
            <div className="muted">Status</div>
            <div style={{ fontSize: 22 }}>
              {daily?.halted ? <span className="badge badge-rejected">halted</span> : 'running'}
            </div>
            {daily?.halt_reason && <div className="muted mono" style={{ fontSize: 11 }}>{daily.halt_reason}</div>}
          </div>
          <div>
            <div className="muted">Plays in motion</div>
            <div style={{ fontSize: 22 }}>{activePlaysTotal}</div>
            <div className="muted mono" style={{ fontSize: 11 }}>
              {positions.length} pos · {pendingOrders.length} pending · {dipEvents.length} dip
            </div>
          </div>
        </div>
      </section>

      {cfg.DIP_STRATEGY_ENABLED && (
        <section className="card">
          <h2>Active dip events ({dipEvents.length})</h2>
          <p className="muted" style={{ fontSize: 12 }}>
            TACO-trade dip-recovery. Dip realized P&amp;L today: ${(daily?.dip_realized_pnl ?? 0).toFixed(2)}.
          </p>
          {dipEvents.length === 0 ? (
            <p className="muted">no active dip events</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>id</th>
                  <th>symbol</th>
                  <th>detected</th>
                  <th>peak → trough</th>
                  <th>drawdown</th>
                  <th>target</th>
                  <th>bailout</th>
                  <th>status</th>
                </tr>
              </thead>
              <tbody>
                {dipEvents.map((e) => {
                  const daysToExpiry = Math.max(0, Math.round((e.expires_at - Date.now()) / 86_400_000));
                  return (
                    <tr key={e.id}>
                      <td className="mono">#{e.id}</td>
                      <td className="mono">{e.symbol}</td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        {new Date(e.detected_at).toISOString().slice(0, 10)}
                      </td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        ${e.peak_price.toFixed(2)} → ${e.trough_price.toFixed(2)}
                      </td>
                      <td>-{e.drawdown_pct.toFixed(1)}%</td>
                      <td>${e.recovery_target_price.toFixed(2)}</td>
                      <td>{daysToExpiry}d</td>
                      <td>
                        <span className={`badge badge-${e.status === 'entered' ? 'approved' : 'clamped'}`}>
                          {e.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section className="card">
        <h2>Pending entry orders ({pendingOrders.length})</h2>
        <p className="muted" style={{ fontSize: 12 }}>
          Buy orders submitted to Alpaca but not yet filled — typically stop-buys waiting for the
          +0.3% trigger to confirm a breakout. Become positions once they fill.
        </p>
        {pendingOrders.length === 0 ? (
          <p className="muted">none</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>symbol</th>
                <th>type</th>
                <th>qty</th>
                <th>notional</th>
                <th>status</th>
                <th>submitted</th>
                <th>alpaca id</th>
              </tr>
            </thead>
            <tbody>
              {pendingOrders.map((o) => (
                <tr key={o.id}>
                  <td className="mono">{o.symbol}</td>
                  <td>{o.type}</td>
                  <td>{o.qty}</td>
                  <td>{o.notional_usd !== null ? `$${o.notional_usd.toFixed(0)}` : '—'}</td>
                  <td>
                    <span className="badge badge-clamped">{o.status}</span>
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {new Date(o.submitted_at).toISOString().replace('T', ' ').slice(0, 19)}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {o.alpaca_order_id ? o.alpaca_order_id.slice(0, 8) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Open positions ({positions.length})</h2>
        {positions.length === 0 ? (
          <p className="muted">none</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>symbol</th>
                <th>strategy</th>
                <th>qty</th>
                <th>entry</th>
                <th>peak</th>
                <th>stop / target</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.symbol}>
                  <td className="mono">{p.symbol}</td>
                  <td>
                    <span className={`badge badge-${p.strategy_tag === 'dip_recovery' ? 'clamped' : 'approved'}`}>
                      {p.strategy_tag ?? 'momentum'}
                    </span>
                  </td>
                  <td>{p.qty}</td>
                  <td>${p.entry_price.toFixed(2)}</td>
                  <td>${p.highest_price_seen.toFixed(2)}</td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {p.strategy_tag === 'dip_recovery' && p.target_price !== null
                      ? `target $${p.target_price.toFixed(2)}`
                      : p.current_stop_type === 'trailing'
                        ? 'trailing'
                        : p.current_stop_price !== null
                          ? `stop $${p.current_stop_price.toFixed(2)}`
                          : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Recent decisions</h2>
        {decisions.length === 0 ? (
          <p className="muted">no decisions yet — start the worker (npm run worker).</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>time</th>
                <th>model</th>
                <th>proposals</th>
                <th>error</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d) => {
                let count = 0;
                try {
                  const arr = JSON.parse(d.parsed_proposals_json);
                  count = Array.isArray(arr) ? arr.length : 0;
                } catch {
                  // ignore
                }
                return (
                  <tr key={d.id}>
                    <td className="mono">{new Date(d.timestamp).toISOString().replace('T', ' ').slice(0, 19)}</td>
                    <td className="mono">{d.model}</td>
                    <td>{count}</td>
                    <td className="mono" style={{ color: 'var(--danger)' }}>{d.error_message ?? ''}</td>
                    <td><Link href={`/decisions/${d.id}`}>view</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Recent proposals (last 30)</h2>
        {recentProposals.length === 0 ? (
          <p className="muted">none</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>symbol</th>
                <th>side</th>
                <th>guardrail</th>
                <th>decision</th>
              </tr>
            </thead>
            <tbody>
              {recentProposals.map((p, i) => (
                <tr key={i}>
                  <td className="mono">{p.symbol}</td>
                  <td>{p.side}</td>
                  <td>
                    <span className={`badge badge-${p.guardrail_status}`}>{p.guardrail_status}</span>
                  </td>
                  <td><Link href={`/decisions/${p.decision_id}`}>#{p.decision_id}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
