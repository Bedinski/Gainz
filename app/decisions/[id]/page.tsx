import { getDb, getRawSqlite } from '@/db/client';
import { applySchema } from '@/db/migrate';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

interface DecisionRow {
  id: number;
  timestamp: number;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  raw_response: string;
  parsed_proposals_json: string;
  market_snapshot_json: string;
  congress_signals_json: string;
  error_message: string | null;
}

interface ProposalRow {
  id: number;
  symbol: string;
  side: string;
  qty: number | null;
  notional_usd: number | null;
  entry_type: string | null;
  stop_loss_pct: number | null;
  trailing_stop_pct: number | null;
  reasoning: string | null;
  guardrail_status: string;
  guardrail_reason: string | null;
}

interface OrderRow {
  id: number;
  alpaca_order_id: string | null;
  symbol: string;
  side: string;
  type: string;
  qty: number;
  notional_usd: number | null;
  status: string;
  filled_avg_price: number | null;
  proposal_id: number | null;
  decision_audit: string | null;
}

export default async function DecisionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  getDb();
  applySchema();
  const db = getRawSqlite();

  const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(Number(id)) as DecisionRow | undefined;
  if (!decision) notFound();

  const proposals = db.prepare('SELECT * FROM proposals WHERE decision_id = ? ORDER BY id').all(decision.id) as ProposalRow[];
  const proposalIds = proposals.map((p) => p.id);
  const orders = proposalIds.length
    ? (db.prepare(
        `SELECT * FROM orders WHERE proposal_id IN (${proposalIds.map(() => '?').join(',')})`,
      ).all(...proposalIds) as OrderRow[])
    : [];

  return (
    <main>
      <h1>Decision #{decision.id}</h1>
      <p className="muted mono">
        {new Date(decision.timestamp).toISOString()} · {decision.model}
        {decision.prompt_tokens !== null && ` · ${decision.prompt_tokens}/${decision.completion_tokens} tok`}
      </p>

      {decision.error_message && (
        <div className="card" style={{ borderColor: 'var(--danger)' }}>
          <h3 style={{ color: 'var(--danger)' }}>Parse error</h3>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{decision.error_message}</pre>
        </div>
      )}

      <section className="card">
        <h2>Proposals ({proposals.length})</h2>
        {proposals.map((p) => (
          <div key={p.id} style={{ borderTop: '1px solid var(--border)', padding: '12px 0' }}>
            <div>
              <strong className="mono">{p.symbol}</strong> {p.side}
              {p.notional_usd !== null && <span className="muted mono"> ${p.notional_usd.toFixed(0)}</span>}
              {p.qty !== null && <span className="muted mono"> qty={p.qty}</span>}
              <span style={{ marginLeft: 8 }} className={`badge badge-${p.guardrail_status}`}>{p.guardrail_status}</span>
            </div>
            <div className="muted mono" style={{ fontSize: 11 }}>
              entry={p.entry_type ?? '—'}  stop={p.stop_loss_pct ?? '—'}%  trail={p.trailing_stop_pct ?? '—'}%
            </div>
            {p.reasoning && <div className="muted">{p.reasoning}</div>}
            {p.guardrail_reason && <div style={{ color: 'var(--warn)', fontSize: 12 }}>guardrail: {p.guardrail_reason}</div>}
            {orders.filter((o) => o.proposal_id === p.id).map((o) => (
              <div key={o.id} style={{ marginTop: 4 }}>
                <div className="mono" style={{ fontSize: 11 }}>
                  order: {o.type} qty={o.qty} {o.notional_usd ? `($${o.notional_usd.toFixed(0)})` : ''} status={o.status} {o.alpaca_order_id ? `id=${o.alpaca_order_id}` : ''}
                </div>
                {o.decision_audit && (
                  <div className="mono" style={{ fontSize: 11, color: 'var(--muted, #888)', marginTop: 2 }}>
                    audit: {o.decision_audit}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Raw Claude response</h2>
        <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 400, overflow: 'auto' }}>
          {decision.raw_response}
        </pre>
      </section>

      <details className="card">
        <summary>Market snapshot</summary>
        <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11, maxHeight: 400, overflow: 'auto' }}>
          {JSON.stringify(JSON.parse(decision.market_snapshot_json), null, 2)}
        </pre>
      </details>

      <details className="card">
        <summary>Congress signals</summary>
        <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11, maxHeight: 400, overflow: 'auto' }}>
          {JSON.stringify(JSON.parse(decision.congress_signals_json), null, 2)}
        </pre>
      </details>
    </main>
  );
}
