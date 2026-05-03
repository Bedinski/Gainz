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
}

interface DailyRow {
  realized_pnl: number;
  trade_count: number;
  halted: number;
  halt_reason: string | null;
}

export default function DashboardPage() {
  const cfg = loadConfig();
  getDb();
  applySchema();
  const db = getRawSqlite();

  const today = new Date().toISOString().slice(0, 10);
  const daily = db
    .prepare('SELECT realized_pnl, trade_count, halted, halt_reason FROM daily_state WHERE date = ?')
    .get(today) as DailyRow | undefined;

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
        </div>
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
                <th>qty</th>
                <th>entry</th>
                <th>peak</th>
                <th>stop type</th>
                <th>stop price</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.symbol}>
                  <td className="mono">{p.symbol}</td>
                  <td>{p.qty}</td>
                  <td>${p.entry_price.toFixed(2)}</td>
                  <td>${p.highest_price_seen.toFixed(2)}</td>
                  <td>{p.current_stop_type}</td>
                  <td>{p.current_stop_price !== null ? `$${p.current_stop_price.toFixed(2)}` : 'trailing'}</td>
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
