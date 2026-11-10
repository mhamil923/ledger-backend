// Market-moving events calendar.
//
// Sources (all free):
//   • Fed (FOMC) meetings + minutes — official schedule, hard-coded below
//     (federalreserve.gov; 2027 dates are the Fed's tentative schedule).
//   • NYSE holidays / early closes — official NYSE Group calendar.
//   • Options expiration (3rd Friday; quad witching in Mar/Jun/Sep/Dec) and
//     crypto month-end expiries (CME bitcoin futures + Deribit options,
//     last Friday) — computed.
//   • Economic data releases (CPI, jobs, PCE, GDP, retail sales, PMIs, jobless
//     claims, Fed speakers…) with forecast/previous — Forex Factory's public
//     weekly feed (this week + next week).
//   • Earnings — Finnhub earnings calendar, for your watchlist plus the
//     mega-caps that move the whole market.

import { config } from '../config.js';
import { query } from '../db.js';

export type EventCategory = 'fed' | 'macro' | 'earnings' | 'options' | 'holiday' | 'crypto';
export type Impact = 'high' | 'medium' | 'low';

export interface MarketEvent {
  id: string;
  /** ISO timestamp (UTC). All-day events use 12:00 ET of that day. */
  at: string;
  all_day: boolean;
  title: string;
  category: EventCategory;
  impact: Impact;
  country: string | null;
  forecast: string | null;
  previous: string | null;
  symbol: string | null;
  /** Which markets it tends to move. */
  affects: Array<'stocks' | 'crypto'>;
  detail: string | null;
  source: string;
  /** Symbol is on your watchlist. */
  mine: boolean;
}

// ---------------------------------------------------------------------------
// Fixed schedules
// ---------------------------------------------------------------------------

// Two-day meetings; the decision + statement is 2:00 pm ET on the second day,
// press conference 2:30 pm. sep = Summary of Economic Projections (dot plot).
const FOMC: Array<{ start: string; end: string; sep: boolean }> = [
  { start: '2026-01-27', end: '2026-01-28', sep: false },
  { start: '2026-03-17', end: '2026-03-18', sep: true },
  { start: '2026-04-28', end: '2026-04-29', sep: false },
  { start: '2026-06-16', end: '2026-06-17', sep: true },
  { start: '2026-07-28', end: '2026-07-29', sep: false },
  { start: '2026-09-15', end: '2026-09-16', sep: true },
  { start: '2026-10-27', end: '2026-10-28', sep: false },
  { start: '2026-12-08', end: '2026-12-09', sep: true },
  { start: '2027-01-26', end: '2027-01-27', sep: false },
  { start: '2027-03-16', end: '2027-03-17', sep: true },
  { start: '2027-04-27', end: '2027-04-28', sep: false },
  { start: '2027-06-08', end: '2027-06-09', sep: true },
  { start: '2027-07-27', end: '2027-07-28', sep: false },
  { start: '2027-09-14', end: '2027-09-15', sep: true },
  { start: '2027-10-26', end: '2027-10-27', sep: false },
  { start: '2027-12-07', end: '2027-12-08', sep: true },
];

const NYSE_CLOSED: Record<string, string> = {
  '2026-01-01': "New Year's Day", '2026-01-19': 'Martin Luther King Jr. Day', '2026-02-16': "Washington's Birthday",
  '2026-04-03': 'Good Friday', '2026-05-25': 'Memorial Day', '2026-06-19': 'Juneteenth',
  '2026-07-03': 'Independence Day (observed)', '2026-09-07': 'Labor Day', '2026-11-26': 'Thanksgiving',
  '2026-12-25': 'Christmas',
  '2027-01-01': "New Year's Day", '2027-01-18': 'Martin Luther King Jr. Day', '2027-02-15': "Washington's Birthday",
  '2027-03-26': 'Good Friday', '2027-05-31': 'Memorial Day', '2027-06-18': 'Juneteenth (observed)',
  '2027-07-05': 'Independence Day (observed)', '2027-09-06': 'Labor Day', '2027-11-25': 'Thanksgiving',
  '2027-12-24': 'Christmas (observed)',
};
const NYSE_EARLY: Record<string, string> = {
  '2026-11-27': 'Day after Thanksgiving', '2026-12-24': 'Christmas Eve', '2027-11-26': 'Day after Thanksgiving',
};

// Companies whose earnings move the whole market (and crypto risk appetite).
const MARKET_MOVERS = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM', 'COIN', 'MSTR'];

// ---------------------------------------------------------------------------
// Time helpers (Eastern time with DST)
// ---------------------------------------------------------------------------

function nyOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t: string): number => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
  return Math.round((asUtc - utcMs) / 60_000);
}

/** "2026-11-12", 8, 30 (Eastern) → ISO UTC. */
export function etToIso(date: string, hh: number, mm = 0): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = nyOffsetMinutes(guess + 5 * 3_600_000);
  return new Date(guess - off * 60_000).toISOString();
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, n: number): string {
  return ymd(new Date(Date.parse(date + 'T12:00:00Z') + n * 86_400_000));
}

/** nth weekday (0=Sun) of a month; n=-1 → last. */
function nthWeekday(year: number, month0: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month0, 1));
    const delta = (weekday - first.getUTCDay() + 7) % 7;
    return ymd(new Date(Date.UTC(year, month0, 1 + delta + (n - 1) * 7)));
  }
  const last = new Date(Date.UTC(year, month0 + 1, 0));
  const delta = (last.getUTCDay() - weekday + 7) % 7;
  return ymd(new Date(Date.UTC(year, month0, last.getUTCDate() - delta)));
}

function scheduled(from: string, to: string): MarketEvent[] {
  const out: MarketEvent[] = [];
  const both: MarketEvent['affects'] = ['stocks', 'crypto'];
  const ev = (e: Omit<MarketEvent, 'country' | 'forecast' | 'previous' | 'symbol' | 'mine' | 'detail'> & Partial<MarketEvent>): void => {
    const day = e.at.slice(0, 10);
    if (day < from || day > to) return;
    out.push({ country: 'US', forecast: null, previous: null, symbol: null, mine: false, detail: null, ...e });
  };

  for (const m of FOMC) {
    ev({
      id: `fomc-${m.end}`, at: etToIso(m.end, 14, 0), all_day: false,
      title: m.sep ? 'Fed rate decision + dot plot + Fed chair press conference' : 'Fed rate decision + Fed chair press conference',
      category: 'fed', impact: 'high', affects: both, source: 'federalreserve.gov',
      detail: `FOMC meets ${m.start}–${m.end}. Statement 2:00 pm ET, press conference 2:30 pm ET.` +
        (m.sep ? ' Includes new economic projections (dot plot) — often the biggest Fed day of the quarter.' : ''),
    });
    const minutes = addDays(m.end, 21);
    ev({
      id: `fomc-minutes-${minutes}`, at: etToIso(minutes, 14, 0), all_day: false,
      title: `Fed minutes (from the ${m.end.slice(5)} meeting)`, category: 'fed', impact: 'medium',
      affects: both, source: 'federalreserve.gov', detail: 'Released three weeks after each meeting, 2:00 pm ET.',
    });
  }

  for (const [date, name] of Object.entries(NYSE_CLOSED)) {
    ev({ id: `closed-${date}`, at: etToIso(date, 12), all_day: true, title: `US markets closed — ${name}`,
      category: 'holiday', impact: 'low', affects: ['stocks'], source: 'NYSE',
      detail: 'Stock and bond markets closed. Crypto trades 24/7 but liquidity is thin.' });
  }
  for (const [date, name] of Object.entries(NYSE_EARLY)) {
    ev({ id: `early-${date}`, at: etToIso(date, 13), all_day: false, title: `US markets close early (1 pm ET) — ${name}`,
      category: 'holiday', impact: 'low', affects: ['stocks'], source: 'NYSE', detail: 'Thin volume; moves can be exaggerated.' });
  }

  const start = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  for (let y = start.getUTCFullYear(), mo = start.getUTCMonth(); y < end.getUTCFullYear() || (y === end.getUTCFullYear() && mo <= end.getUTCMonth()); mo === 11 ? (y++, mo = 0) : mo++) {
    let opex = nthWeekday(y, mo, 5, 3);
    if (NYSE_CLOSED[opex]) opex = addDays(opex, -1);
    const quad = mo % 3 === 2;
    ev({
      id: `opex-${opex}`, at: etToIso(opex, 16), all_day: false,
      title: quad ? 'Quad witching — quarterly stock options & futures expire' : 'Monthly stock options expiration',
      category: 'options', impact: quad ? 'high' : 'medium', affects: ['stocks'], source: 'computed',
      detail: quad
        ? 'Stock, index options and futures all expire. Expect heavy volume and pinning near big strike prices; index rebalances often land the same day.'
        : 'Big options positions expire; prices often get "pinned" near large strikes into the close, then move freely the next week.',
    });
    const lastFri = nthWeekday(y, mo, 5, -1);
    ev({
      id: `cryptoexp-${lastFri}`, at: new Date(Date.parse(lastFri + 'T08:00:00Z')).toISOString(), all_day: false,
      title: 'Crypto month-end expiry — Deribit options (08:00 UTC) + CME bitcoin futures',
      category: 'crypto', impact: quad ? 'high' : 'medium', affects: ['crypto'], source: 'computed',
      detail: 'Large bitcoin/ether options expire. Price tends to drift toward the "max pain" strike into expiry, and volatility often picks up after.',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Economic data (Forex Factory weekly feed)
// ---------------------------------------------------------------------------

interface FFRow { title: string; country: string; date: string; impact: string; forecast?: string; previous?: string }

let ffCache: { at: number; rows: FFRow[] } | null = null;

async function fetchFF(): Promise<FFRow[]> {
  if (ffCache && Date.now() - ffCache.at < 60 * 60_000) return ffCache.rows;
  const rows: FFRow[] = [];
  let ok = false;
  for (const w of ['thisweek', 'nextweek']) {
    try {
      const res = await fetch(`https://nfs.faireconomy.media/ff_calendar_${w}.json`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Ledger personal finance app)' },
      });
      if (!res.ok) continue;
      const j = (await res.json()) as FFRow[];
      if (Array.isArray(j)) { rows.push(...j); ok = true; }
    } catch {
      // keep going
    }
  }
  // The feed rate-limits; if it fails, keep serving the last good copy.
  if (ok) ffCache = { at: Date.now(), rows };
  return ok ? rows : ffCache?.rows ?? [];
}

// What each kind of release is and why it moves markets.
const MACRO_NOTES: Array<[RegExp, string]> = [
  [/\bCPI\b|consumer price/i, 'Inflation. Hotter than forecast → rate cuts look further away → stocks and crypto usually drop; cooler → rally.'],
  [/PCE/i, "The Fed's preferred inflation gauge. Same read as CPI: hot = bearish for risk, cool = bullish."],
  [/PPI|producer price/i, 'Wholesale inflation — an early hint for CPI.'],
  [/non-?farm|NFP|employment change/i, 'Monthly jobs report. Too strong can mean "higher for longer" rates; too weak raises recession fears. Big volatility at 8:30 am ET.'],
  [/unemployment rate/i, 'Rising unemployment pushes the Fed toward cuts but signals a slowing economy.'],
  [/jobless claims|unemployment claims/i, 'Weekly layoffs. A sudden jump is an early recession warning.'],
  [/GDP/i, 'Economic growth. Big misses move recession odds.'],
  [/retail sales/i, 'Consumer spending — about 70% of the US economy.'],
  [/ISM|PMI/i, 'Business surveys. Above 50 = expanding, below 50 = contracting.'],
  [/fed chair|powell|fomc member|fed .*speaks|speaks/i, 'Fed officials can shift rate expectations in one sentence.'],
  [/federal funds rate|rate decision/i, 'The Fed’s interest-rate decision.'],
  [/consumer sentiment|consumer confidence/i, 'How confident households feel; includes inflation expectations.'],
  [/JOLTS|job openings/i, 'Labor demand — the Fed watches it for wage pressure.'],
  [/treasury|bond auction/i, 'Weak demand at auctions pushes yields up, which pressures stocks and crypto.'],
];

function macroNote(title: string): string | null {
  return MACRO_NOTES.find(([re]) => re.test(title))?.[1] ?? null;
}

async function macroEvents(from: string, to: string): Promise<MarketEvent[]> {
  const rows = await fetchFF();
  const out: MarketEvent[] = [];
  for (const r of rows) {
    const t = Date.parse(r.date);
    if (!Number.isFinite(t)) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    if (day < from || day > to) continue;
    const imp = r.impact?.toLowerCase();
    if (imp === 'holiday' || imp === 'non-economic') continue;
    // US data moves everything; other countries only when it's high impact.
    if (r.country !== 'USD' && imp !== 'high') continue;
    // The Fed decision itself comes from the official schedule above.
    if (r.country === 'USD' && /federal funds rate|fomc statement|fomc press/i.test(r.title)) continue;
    const impact: Impact = imp === 'high' ? 'high' : imp === 'medium' ? 'medium' : 'low';
    if (r.country === 'USD' && impact === 'low') continue;
    out.push({
      id: `ff-${r.country}-${r.date}-${r.title}`,
      at: new Date(t).toISOString(),
      all_day: false,
      title: r.country === 'USD' ? r.title : `${r.country}: ${r.title}`,
      category: /speaks|fed chair|fomc member/i.test(r.title) ? 'fed' : 'macro',
      impact,
      country: r.country === 'USD' ? 'US' : r.country,
      forecast: r.forecast || null,
      previous: r.previous || null,
      symbol: null,
      affects: ['stocks', 'crypto'],
      detail: macroNote(r.title),
      source: 'Forex Factory',
      mine: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Earnings (Finnhub)
// ---------------------------------------------------------------------------

let earnCache: { key: string; at: number; rows: Array<{ symbol: string; date: string; hour?: string; epsEstimate?: number | null; revenueEstimate?: number | null }> } | null = null;

async function earningsEvents(from: string, to: string, watch: Set<string>): Promise<MarketEvent[]> {
  if (!config.FINNHUB_API_KEY) return [];
  const key = `${from}:${to}`;
  if (!earnCache || earnCache.key !== key || Date.now() - earnCache.at > 6 * 3_600_000) {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${config.FINNHUB_API_KEY}`);
      if (res.ok) {
        const j = (await res.json()) as { earningsCalendar?: NonNullable<typeof earnCache>['rows'] };
        earnCache = { key, at: Date.now(), rows: j.earningsCalendar ?? [] };
      }
    } catch {
      // fall through with whatever we had
    }
  }
  const out: MarketEvent[] = [];
  for (const e of earnCache?.rows ?? []) {
    const sym = e.symbol?.toUpperCase();
    if (!sym) continue;
    const mine = watch.has(sym);
    const mover = MARKET_MOVERS.includes(sym);
    if (!mine && !mover) continue;
    const when = e.hour === 'bmo' ? 'before the open' : e.hour === 'amc' ? 'after the close' : null;
    const at = e.hour === 'bmo' ? etToIso(e.date, 7) : e.hour === 'amc' ? etToIso(e.date, 16, 5) : etToIso(e.date, 12);
    const eps = e.epsEstimate != null ? `EPS est. ${e.epsEstimate}` : null;
    const rev = e.revenueEstimate ? `revenue est. $${(e.revenueEstimate / 1e9).toFixed(2)}B` : null;
    out.push({
      id: `earn-${sym}-${e.date}`,
      at,
      all_day: !when,
      title: `${sym} earnings${when ? ` (${when})` : ''}`,
      category: 'earnings',
      impact: mover ? 'high' : 'medium',
      country: 'US',
      forecast: [eps, rev].filter(Boolean).join(' · ') || null,
      previous: null,
      symbol: sym,
      affects: mover && ['COIN', 'MSTR', 'NVDA'].includes(sym) ? ['stocks', 'crypto'] : ['stocks'],
      detail: mover
        ? `${sym} is big enough to move the whole market${['COIN', 'MSTR'].includes(sym) ? ' — and crypto sentiment' : ''}. Expect a large gap either way.`
        : 'Holding through earnings turns a trade into a bet on the report — the stock can gap past your stop.',
      source: 'Finnhub',
      mine,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------

async function watchSymbols(userId: string): Promise<Set<string>> {
  try {
    const r = await query<{ symbol: string }>(`SELECT DISTINCT upper(symbol) AS symbol FROM watchlist_items WHERE user_id = $1`, [userId]);
    return new Set(r.rows.map((x) => x.symbol));
  } catch {
    return new Set();
  }
}

export async function getMarketCalendar(userId: string, days = 30, pastDays = 1): Promise<MarketEvent[]> {
  const from = ymd(new Date(Date.now() - pastDays * 86_400_000));
  const to = ymd(new Date(Date.now() + days * 86_400_000));
  const watch = await watchSymbols(userId);
  const [macro, earn] = await Promise.all([macroEvents(from, to), earningsEvents(from, to, watch)]);
  const all = [...scheduled(from, to), ...macro, ...earn];
  // De-dupe by id, sort by time.
  const seen = new Map<string, MarketEvent>();
  for (const e of all) seen.set(e.id, e);
  return [...seen.values()].sort((a, b) => a.at.localeCompare(b.at) || impactRank(b.impact) - impactRank(a.impact));
}

function impactRank(i: Impact): number {
  return i === 'high' ? 3 : i === 'medium' ? 2 : 1;
}

/**
 * High-impact events inside a trade's holding window that can blow through a
 * stop: Fed decisions, CPI/PCE/jobs, quad witching (stocks), crypto month-end
 * expiry (crypto), and this symbol's own earnings.
 */
export async function getEventRisk(
  userId: string,
  symbol: string,
  assetType: 'stock' | 'crypto' | 'etf',
  windowDays = 30,
): Promise<MarketEvent[]> {
  const events = await getMarketCalendar(userId, windowDays, 0);
  const now = Date.now();
  const kind = assetType === 'crypto' ? 'crypto' : 'stocks';
  return events.filter((e) => {
    if (Date.parse(e.at) < now) return false;
    if (e.category === 'earnings') return e.symbol === symbol.toUpperCase() || (e.impact === 'high' && e.affects.includes(kind));
    if (e.impact !== 'high') return false;
    if (e.country && e.country !== 'US') return false;
    return e.affects.includes(kind);
  });
}

export function formatEventsForPrompt(events: MarketEvent[], limit = 12): string {
  if (!events.length) return 'UPCOMING HIGH-IMPACT EVENTS: none scheduled in the next 30 days.';
  const now = Date.now();
  const lines = events.slice(0, limit).map((e) => {
    const d = (Date.parse(e.at) - now) / 86_400_000;
    const when = d < 1 ? `in ${Math.max(1, Math.round(d * 24))}h` : `in ${d.toFixed(1)}d`;
    return `- ${e.at.slice(0, 16).replace('T', ' ')} UTC (${when}): ${e.title}${e.forecast ? ` — forecast ${e.forecast}` : ''}${e.previous ? `, previous ${e.previous}` : ''}`;
  });
  return 'UPCOMING HIGH-IMPACT EVENTS (a trade held through one of these can gap past its stop):\n' + lines.join('\n');
}
