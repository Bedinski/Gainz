import { getRawSqlite } from '../db/client.js';

/**
 * Returns days-until-next-earnings for a symbol, or undefined if none on file
 * within the next ~21 days.
 */
export function daysUntilEarnings(symbol: string, today = new Date()): number | undefined {
  const db = getRawSqlite();
  const row = db
    .prepare<[string, string]>(
      `SELECT earnings_date FROM earnings_calendar
       WHERE symbol = ? AND earnings_date >= ?
       ORDER BY earnings_date ASC LIMIT 1`,
    )
    .get(symbol.toUpperCase(), toIsoDate(today)) as { earnings_date: string } | undefined;
  if (!row) return undefined;
  const target = new Date(row.earnings_date + 'T00:00:00Z').getTime();
  const now = new Date(toIsoDate(today) + 'T00:00:00Z').getTime();
  return Math.round((target - now) / (24 * 60 * 60 * 1000));
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
