import { getRawSqlite } from '../db/client.js';
import { loadConfig, type Config } from '../trading/config.js';
import { logger } from './logger.js';

export type AlertSeverity = 'info' | 'warn' | 'critical';

export interface AlertInput {
  severity: AlertSeverity;
  title: string;
  body: string;
  /**
   * Logical key used for dedupe — same key within the TTL window won't be
   * re-dispatched. Defaults to `${severity}:${title}` if not provided.
   */
  dedupeKey?: string;
}

export interface DispatchResult {
  dispatched: boolean;
  /** Reason if not dispatched (dedupe / below severity threshold / no transport). */
  reason?: string;
  transports: string[];
  errors: string[];
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warn: 1, critical: 2 };

/**
 * Dispatch an alert through configured transports (SMTP, webhook). Logs are
 * always written via pino regardless of transport availability — that's the
 * baseline guarantee. Transport failures are non-fatal: the cycle that fired
 * the alert keeps running.
 *
 * Dedupe semantics: an alert with `dedupeKey` (or default `${severity}:${title}`)
 * suppresses follow-ups for `ALERT_DEDUPE_TTL_MIN` minutes. Lets us bound
 * alert storms when, e.g., reconciliation drift persists for hours.
 */
export async function sendAlert(
  input: AlertInput,
  cfgOverride?: Config,
): Promise<DispatchResult> {
  const cfg = cfgOverride ?? loadConfig();
  const dedupeKey = input.dedupeKey ?? `${input.severity}:${input.title}`;
  const result: DispatchResult = { dispatched: false, transports: [], errors: [] };

  // Severity threshold gate.
  if (SEVERITY_RANK[input.severity] < SEVERITY_RANK[cfg.ALERT_MIN_SEVERITY]) {
    logger[severityToLevel(input.severity)](
      { alertTitle: input.title },
      `alert below ALERT_MIN_SEVERITY (${cfg.ALERT_MIN_SEVERITY}); not dispatched`,
    );
    return { ...result, reason: 'below severity threshold' };
  }

  // Dedupe lookup.
  const ttlMs = cfg.ALERT_DEDUPE_TTL_MIN * 60 * 1000;
  const cutoff = Date.now() - ttlMs;
  const db = getRawSqlite();
  const recent = db
    .prepare(
      `SELECT id FROM alerts_sent
       WHERE dedupe_key = ? AND sent_at >= ?
       ORDER BY sent_at DESC LIMIT 1`,
    )
    .get(dedupeKey, cutoff) as { id: number } | undefined;
  if (recent) {
    logger.debug({ dedupeKey }, 'alert deduped');
    return { ...result, reason: 'deduped' };
  }

  // Always log.
  logger[severityToLevel(input.severity)]({ alertTitle: input.title, alertBody: input.body }, 'ALERT');

  // SMTP transport.
  if (cfg.ALERT_SMTP_HOST && cfg.ALERT_SMTP_TO && cfg.ALERT_SMTP_FROM) {
    try {
      await sendSmtp(cfg, input);
      result.transports.push('smtp');
    } catch (err) {
      result.errors.push(`smtp: ${String(err)}`);
      logger.warn({ err: String(err) }, 'alert smtp transport failed');
    }
  }

  // Webhook transport.
  if (cfg.ALERT_WEBHOOK_URL) {
    try {
      await sendWebhook(cfg.ALERT_WEBHOOK_URL, input);
      result.transports.push('webhook');
    } catch (err) {
      result.errors.push(`webhook: ${String(err)}`);
      logger.warn({ err: String(err) }, 'alert webhook transport failed');
    }
  }

  // Persist the dispatch row regardless of transport count — even no-transport
  // alerts get audit rows so paper-soak telemetry is reviewable.
  db.prepare(
    `INSERT INTO alerts_sent (sent_at, severity, title, body, dedupe_key, transports, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(),
    input.severity,
    input.title,
    input.body,
    dedupeKey,
    result.transports.join(',') || 'log-only',
    result.errors.length ? result.errors.join('; ') : null,
  );

  result.dispatched = result.transports.length > 0 || result.errors.length === 0;
  return result;
}

async function sendWebhook(url: string, input: AlertInput): Promise<void> {
  const payload = {
    severity: input.severity,
    title: input.title,
    body: input.body,
    timestamp: new Date().toISOString(),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`webhook ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Minimal local interface for nodemailer's surface — keeps the dependency
 * optional at install time. Operators who don't configure SMTP never load the
 * package; tests don't either.
 */
interface MinimalNodemailer {
  createTransport: (opts: {
    host: string;
    port: number;
    secure: boolean;
    auth?: { user: string; pass: string };
  }) => { sendMail: (msg: { from: string; to: string; subject: string; text: string }) => Promise<unknown> };
}

async function sendSmtp(cfg: Config, input: AlertInput): Promise<void> {
  let nodemailer: MinimalNodemailer;
  try {
    // Hide the module specifier from the TS resolver via an indirection so the
    // package stays a true optional install. Operators without SMTP never need it.
    const moduleName = 'nodemailer';
    const mod = (await import(moduleName)) as { default?: MinimalNodemailer } & MinimalNodemailer;
    nodemailer = (mod.default ?? mod) as MinimalNodemailer;
  } catch (err) {
    throw new Error(
      `nodemailer not installed; \`npm i nodemailer\` to enable SMTP alerts (${String(err).slice(0, 100)})`,
    );
  }
  const transport = nodemailer.createTransport({
    host: cfg.ALERT_SMTP_HOST!,
    port: cfg.ALERT_SMTP_PORT ?? 587,
    secure: (cfg.ALERT_SMTP_PORT ?? 587) === 465,
    auth:
      cfg.ALERT_SMTP_USER && cfg.ALERT_SMTP_PASS
        ? { user: cfg.ALERT_SMTP_USER, pass: cfg.ALERT_SMTP_PASS }
        : undefined,
  });
  await transport.sendMail({
    from: cfg.ALERT_SMTP_FROM!,
    to: cfg.ALERT_SMTP_TO!,
    subject: `[gainz/${input.severity}] ${input.title}`,
    text: input.body,
  });
}

function severityToLevel(s: AlertSeverity): 'info' | 'warn' | 'error' {
  if (s === 'critical') return 'error';
  if (s === 'warn') return 'warn';
  return 'info';
}
