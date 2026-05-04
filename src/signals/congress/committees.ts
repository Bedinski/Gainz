/**
 * Committee jurisdictional fit mapping. When a filer sits on a committee whose
 * jurisdiction overlaps with the symbol's sector, the trade has plausibly more
 * informational content than a random pick.
 *
 * The mapping is intentionally coarse — false positives are tolerated since the
 * boost only nudges a trade through filtering, it doesn't size positions.
 */

export type Sector =
  | 'tech'
  | 'defense'
  | 'energy'
  | 'healthcare'
  | 'finance'
  | 'consumer'
  | 'communications'
  | 'industrials'
  | 'index';

export const SYMBOL_SECTOR: Record<string, Sector> = {
  AAPL: 'tech',
  MSFT: 'tech',
  GOOGL: 'tech',
  GOOG: 'tech',
  NVDA: 'tech',
  AMD: 'tech',
  AVGO: 'tech',
  META: 'communications',
  AMZN: 'consumer',
  TSLA: 'consumer',
  JPM: 'finance',
  BAC: 'finance',
  WFC: 'finance',
  GS: 'finance',
  XOM: 'energy',
  CVX: 'energy',
  LMT: 'defense',
  RTX: 'defense',
  NOC: 'defense',
  GD: 'defense',
  PFE: 'healthcare',
  JNJ: 'healthcare',
  UNH: 'healthcare',
  SPY: 'index',
  QQQ: 'index',
  IWM: 'index',
};

/**
 * Committee → sectors that committee plausibly has informational edge on.
 * Names normalized to lowercase before matching.
 */
const COMMITTEE_SECTORS: Array<{ pattern: RegExp; sectors: Sector[] }> = [
  // Defense & intelligence
  { pattern: /armed services|defense|intelligence/i, sectors: ['defense', 'tech'] },
  { pattern: /foreign relations|foreign affairs/i, sectors: ['defense', 'energy'] },
  // Energy
  { pattern: /energy|natural resources|environment/i, sectors: ['energy'] },
  // Health
  { pattern: /health|veterans|hsgac/i, sectors: ['healthcare'] },
  // Finance / banking
  { pattern: /banking|finance|financial services|appropriations|budget/i, sectors: ['finance'] },
  { pattern: /ways and means/i, sectors: ['finance', 'healthcare'] },
  // Tech / commerce / communications
  { pattern: /commerce|science|technology|judiciary/i, sectors: ['tech', 'communications'] },
  // Energy & Commerce (House) is broad
  { pattern: /energy and commerce/i, sectors: ['energy', 'healthcare', 'communications'] },
  // Transportation / industrials
  { pattern: /transportation|infrastructure|public works/i, sectors: ['industrials'] },
  // Agriculture
  { pattern: /agriculture/i, sectors: ['consumer'] },
];

/**
 * Returns true if any of the filer's committees plausibly has jurisdiction
 * over the symbol's sector.
 */
export function hasCommitteeFit(symbol: string, committees: string[] | undefined): boolean {
  if (!committees || committees.length === 0) return false;
  const sector = SYMBOL_SECTOR[symbol.toUpperCase()];
  if (!sector || sector === 'index') return false;
  for (const c of committees) {
    for (const { pattern, sectors } of COMMITTEE_SECTORS) {
      if (pattern.test(c) && sectors.includes(sector)) return true;
    }
  }
  return false;
}
