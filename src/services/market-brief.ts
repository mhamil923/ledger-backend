// Daily market brief: Claude reads the live web (Anthropic web search) on top
// of everything Ledger already knows — the event calendar, headlines, Fear &
// Greed, and every measured setup firing on your watchlist — and writes a
// brief with the trades worth taking today.
//
// Guardrails, same philosophy as the per-symbol analysis:
//   • Trade numbers (entry/stop/targets) and odds come ONLY from the quant
//     engine's backtested candidates — Claude chooses and explains, it never
//     invents a price level or a win rate.
//   • Conviction can't exceed what the setup has measured on that chart.
//   • A high-impact event right before entry caps conviction (enter after it).

import type Anthropic from '@anthropic-ai/sdk';
import { query } from '../db.js';
import { getAnthropicClient, resolveModel, type ModelTier } from './anthropic.js';
import { getMarketCalendar, type MarketEvent } from './market-calendar.js';
import { getMarketNews, type NewsItem } from './market-news.js';
import { getCryptoFearGreed } from './sentiment.js';
import { getQuantCandles } from './market-data.js';
import { convictionFromStats, runQuant, type Candidate, type QuantHorizon, type QuantReport } from './quant.js';

export interface BriefOpportunity {
  candidate_id: string;
  symbol: string;
  asset_type: 'stock' | 'crypto' | 'etf';
  horizon: QuantHorizon;
  direction: 'long' | 'short';
  setup_label: string;
  entry_kind: Candidate['entry_kind'];
  entry_zone: [number, number];
  stop_loss: number;
  targets: number[];
  price: number;
  backtest: { n: number; win_rate: number; win_rate_lower: number; avg_r: number };
  conviction: number;
  thesis: string;
  catalyst: string;
  risks: string;
  event_risk: string | null;
}

export interface MarketBrief {
  headline: string;
  market_regime: 'risk_on' | 'risk_off' | 'mixed';
  summary_markdown: string;
  drivers: Array<{ title: string; detail: string; effect: 'bullish' | 'bearish' | 'mixed'; assets: string }>;
  event_watch: Array<{ title: string; when: string; why_it_matters: string; playbook: string }>;
  opportunities: BriefOpportunity[];
  watch: Array<{ symbol: string; note: string }>;
  avoid: Array<{ symbol: string; reason: string }>;
  sources: Array<{ title: string; url: string }>;
  fear_greed: { value: number; label: string } | null;
  scanned: number;
  measured_candidates: number;
  notes: string[];
}

export interface BriefRow {
  id: string;
  created_at: string;
  model: string;
  data: MarketBrief;
}

const HORIZON_LABEL: Record<QuantHorizon, string> = { intraday: 'day trade', short_term: 'swing (days–2 wks)', medium_term: 'position (weeks–months)' };
const HORIZON_DAYS: Record<QuantHorizon, number> = { intraday: 1, short_term: 14, medium_term: 120 };

const BRIEF_TOOL = {
  name: 'submit_brief',
  description: 'Submit the finished market brief.',
  input_schema: {
    type: 'object' as const,
    required: ['headline', 'market_regime', 'summary_markdown', 'drivers', 'event_watch', 'opportunities', 'watch', 'avoid'],
    properties: {
      headline: { type: 'string', description: 'One line, max ~90 chars: the single most important thing for markets right now.' },
      market_regime: { type: 'string', enum: ['risk_on', 'risk_off', 'mixed'] },
      summary_markdown: { type: 'string', description: '200–400 words. What is driving stocks and crypto, what changed, what the next few days hinge on. Plain English, concrete numbers, no hype.' },
      drivers: {
        type: 'array', maxItems: 6,
        items: {
          type: 'object', required: ['title', 'detail', 'effect', 'assets'],
          properties: {
            title: { type: 'string' }, detail: { type: 'string' },
            effect: { type: 'string', enum: ['bullish', 'bearish', 'mixed'] },
            assets: { type: 'string', description: 'What it moves, e.g. "stocks", "crypto", "BTC, COIN"' },
          },
        },
      },
      event_watch: {
        type: 'array', maxItems: 6,
        description: 'The scheduled events from the calendar that matter most this week.',
        items: {
          type: 'object', required: ['title', 'when', 'why_it_matters', 'playbook'],
          properties: {
            title: { type: 'string' }, when: { type: 'string', description: 'e.g. "Wed 8:30 am ET"' },
            why_it_matters: { type: 'string' },
            playbook: { type: 'string', description: 'What a hotter/cooler or better/worse result likely means, and how to position around it (e.g. "wait for the release before entering").' },
          },
        },
      },
      opportunities: {
        type: 'array', maxItems: 5,
        description: 'Best trades from CANDIDATES ONLY, best first. Empty array if nothing is worth taking — that is a valid, good answer.',
        items: {
          type: 'object', required: ['candidate_id', 'thesis', 'catalyst', 'conviction', 'risks'],
          properties: {
            candidate_id: { type: 'string', description: 'Exact id from the CANDIDATES list.' },
            thesis: { type: 'string', description: '2–3 sentences: why this measured setup lines up with the news/macro picture right now.' },
            catalyst: { type: 'string', description: 'What should make it move (or "none — purely technical").' },
            conviction: { type: 'integer', minimum: 1, maximum: 5 },
            risks: { type: 'string', description: 'What would kill the trade, including scheduled events.' },
          },
        },
      },
      watch: {
        type: 'array', maxItems: 6,
        description: 'Watchlist symbols with something important going on but no measured trade yet.',
        items: { type: 'object', required: ['symbol', 'note'], properties: { symbol: { type: 'string' }, note: { type: 'string' } } },
      },
      avoid: {
        type: 'array', maxItems: 6,
        description: 'Watchlist symbols to stay away from right now and why (earnings tomorrow, breaking bad news, regulatory risk, broken trend).',
        items: { type: 'object', required: ['symbol', 'reason'], properties: { symbol: { type: 'string' }, reason: { type: 'string' } } },
      },
    },
  },
};

const SYSTEM = `You are the market strategist inside Ledger, a personal trading app. Each brief must help the user take FEWER, BETTER trades.

Process:
1. Use web search (a few targeted searches) to learn what is moving markets RIGHT NOW: overnight/this-week macro news, Fed expectations (market-implied odds), the main stock-market narrative, crypto-specific catalysts (ETF flows, regulation, hacks, unlocks, upgrades) and fresh news on the user's watchlist symbols — prioritise the CANDIDATES.
2. Combine that with the CALENDAR, HEADLINES, SENTIMENT and CANDIDATES given below.
3. Call submit_brief exactly once.

Hard rules:
- Opportunities may ONLY reference candidate_ids from the CANDIDATES list. Their prices and win rates were measured on real history; never state different numbers.
- Prefer candidates whose measured edge AND the current news/macro picture point the same way. If the news contradicts a setup (e.g. a long setup into breaking bad news or right before a hot-inflation risk), leave it out or put the symbol in "avoid".
- Zero opportunities is a correct answer when nothing lines up. Never pad.
- A high-impact event (Fed, CPI, jobs, PCE, big earnings) before entry means: say "enter after the release" in risks.
- Be specific and plain-spoken. No hype, no guarantees — trading always carries risk of loss.`;

function fmt(n: number): string {
  const a = Math.abs(n);
  return a >= 100 ? n.toFixed(2) : a >= 1 ? n.toFixed(3) : n.toPrecision(4);
}

interface Scanned {
  symbol: string;
  asset_type: 'stock' | 'crypto' | 'etf';
  quant: QuantReport;
  earnings: MarketEvent | null;
}

async function scanWatchlist(userId: string, events: MarketEvent[]): Promise<Scanned[]> {
  const rows = (
    await query<{ symbol: string; asset_type: 'stock' | 'crypto' | 'etf' }>(
      `SELECT DISTINCT ON (upper(symbol)) upper(symbol) AS symbol, asset_type FROM watchlist_items WHERE user_id = $1`,
      [userId],
    )
  ).rows.slice(0, 20);
  const out: Scanned[] = [];
  // Sequential: Twelve Data's free tier rate-limits bursts.
  for (const r of rows) {
    try {
      const c = await getQuantCandles(r.symbol, r.asset_type);
      if (!c) continue;
      const earnings = events.find((e) => e.category === 'earnings' && e.symbol === r.symbol && Date.parse(e.at) > Date.now()) ?? null;
      out.push({ symbol: r.symbol, asset_type: r.asset_type, quant: runQuant(c), earnings });
    } catch (err) {
      console.warn(`brief: scan ${r.symbol} failed (non-fatal):`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

function candId(s: string, c: Candidate): string {
  return `${s}:${c.horizon}:${c.setup_id}`;
}

function buildContext(
  scanned: Scanned[],
  events: MarketEvent[],
  news: NewsItem[],
  fg: { value: number; label: string } | null,
): { text: string; cands: Map<string, { s: Scanned; c: Candidate }> } {
  const now = Date.now();
  const lines: string[] = [`AS OF: ${new Date().toISOString()}`];
  lines.push(`CRYPTO FEAR & GREED: ${fg ? `${fg.value} (${fg.label})` : 'unavailable'}`);

  lines.push('', 'CALENDAR — next 7 days (UTC):');
  const week = events.filter((e) => Date.parse(e.at) >= now - 3_600_000 && Date.parse(e.at) <= now + 7 * 86_400_000 && e.impact !== 'low');
  if (!week.length) lines.push('  (calendar unavailable)');
  for (const e of week.slice(0, 40)) {
    lines.push(`  ${e.at.slice(0, 16).replace('T', ' ')} [${e.impact}] ${e.title}${e.forecast ? ` | forecast ${e.forecast}` : ''}${e.previous ? ` | prev ${e.previous}` : ''}`);
  }

  lines.push('', 'HEADLINES (last ~3 days, newest first):');
  for (const n of news.slice(0, 30)) {
    lines.push(`  ${n.at.slice(0, 16).replace('T', ' ')} ${n.source}: ${n.headline}${n.symbols.length ? ` [${n.symbols.join(', ')}]` : ''}`);
  }

  lines.push('', 'WATCHLIST SNAPSHOT (daily chart):');
  for (const s of scanned) {
    const d = s.quant.daily?.indicators;
    if (!d) continue;
    lines.push(
      `  ${s.symbol} (${s.asset_type}): ${fmt(d.price)}, ${d.regime}, RSI ${d.rsi14.toFixed(0)}, ADX ${d.adx14.toFixed(0)}, ATR ${d.atr_pct.toFixed(1)}%/day` +
        (s.earnings ? ` | EARNINGS ${s.earnings.at.slice(0, 10)}` : ''),
    );
  }

  const cands = new Map<string, { s: Scanned; c: Candidate }>();
  lines.push('', 'CANDIDATES — measured setups firing now (the ONLY trades you may propose):');
  for (const s of scanned) {
    for (const c of s.quant.candidates) {
      if (!(c.stats.avg_r > 0 && c.stats.n >= 8)) continue;
      const id = candId(s.symbol, c);
      cands.set(id, { s, c });
      lines.push(
        `  ${id} — ${c.direction.toUpperCase()} ${HORIZON_LABEL[c.horizon]}, ${c.label}, ${c.entry_kind}: entry ${fmt(c.entry_zone[0])}–${fmt(c.entry_zone[1])}, stop ${fmt(c.stop_loss)}, targets ${c.targets.map(fmt).join('/')} | ` +
          `past ${c.stats.n} setups: hit T1 ${Math.round(c.stats.win_rate * 100)}% (conservative ${Math.round(c.stats.win_rate_lower * 100)}%), avg ${c.stats.avg_r.toFixed(2)}R | ${c.why}`,
      );
    }
  }
  if (!cands.size) lines.push('  none — no measured setup with a positive edge is firing on the watchlist right now.');
  return { text: lines.join('\n'), cands };
}

function eventRiskFor(s: Scanned, horizon: QuantHorizon, events: MarketEvent[]): { label: string | null; cap: number | null } {
  const now = Date.now();
  const kind = s.asset_type === 'crypto' ? 'crypto' : 'stocks';
  if (s.earnings) {
    const days = (Date.parse(s.earnings.at) - now) / 86_400_000;
    if (days <= HORIZON_DAYS[horizon]) return { label: `${s.symbol} earnings ${s.earnings.at.slice(0, 10)} inside the trade window`, cap: 2 };
  }
  const windowH = horizon === 'intraday' ? 24 : horizon === 'short_term' ? 48 : 0;
  if (!windowH) return { label: null, cap: null };
  const hit = events.find(
    (e) => e.impact === 'high' && (!e.country || e.country === 'US') && e.affects.includes(kind) &&
      Date.parse(e.at) > now && Date.parse(e.at) - now <= windowH * 3_600_000,
  );
  if (!hit) return { label: null, cap: null };
  const h = (Date.parse(hit.at) - now) / 3_600_000;
  return { label: `${hit.title} in ${h < 24 ? `${Math.max(1, Math.round(h))}h` : `${(h / 24).toFixed(1)} days`}`, cap: horizon === 'intraday' ? 2 : 3 };
}

export async function generateBrief(userId: string, tier: ModelTier = 'fast'): Promise<BriefRow> {
  const [events, news, fgRaw] = await Promise.all([
    getMarketCalendar(userId, 14, 0).catch(() => [] as MarketEvent[]),
    getMarketNews(userId, 60).catch(() => [] as NewsItem[]),
    getCryptoFearGreed().catch(() => null),
  ]);
  const fg = fgRaw ? { value: fgRaw.fear_greed_index, label: fgRaw.fear_greed_label } : null;
  const scanned = await scanWatchlist(userId, events);
  const { text, cands } = buildContext(scanned, events, news, fg);

  const client = getAnthropicClient();
  const model = resolveModel(tier);
  // The installed SDK predates server tools in its types; the API accepts them.
  const tools = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 6 },
    BRIEF_TOOL,
  ] as unknown as Anthropic.Tool[];

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: text }];
  let msg: Anthropic.Message | null = null;
  let inTok = 0, outTok = 0;
  const allBlocks: unknown[] = [];
  for (let turn = 0; turn < 4; turn++) {
    msg = await client.messages.create({ model, max_tokens: 6000, system: SYSTEM, tools, messages });
    inTok += msg.usage.input_tokens;
    outTok += msg.usage.output_tokens;
    allBlocks.push(...msg.content);
    const done = msg.content.some((b) => b.type === 'tool_use' && b.name === 'submit_brief');
    if (done) break;
    messages.push({ role: 'assistant', content: msg.content as Anthropic.ContentBlockParam[] });
    if ((msg.stop_reason as string) === 'pause_turn' && turn < 2) continue; // long web-search turn; let it resume
    messages.push({ role: 'user', content: 'Now call submit_brief with the finished brief.' });
    msg = await client.messages.create({
      model, max_tokens: 6000, system: SYSTEM, tools, messages,
      tool_choice: { type: 'tool', name: 'submit_brief' },
    });
    inTok += msg.usage.input_tokens;
    outTok += msg.usage.output_tokens;
    allBlocks.push(...msg.content);
    break;
  }
  const tool = allBlocks.find(
    (b): b is Anthropic.ToolUseBlock => (b as Anthropic.ToolUseBlock).type === 'tool_use' && (b as Anthropic.ToolUseBlock).name === 'submit_brief',
  );
  if (!tool) throw new Error('The model did not return a brief.');
  const raw = tool.input as Record<string, unknown>;

  // Sources the model actually read.
  const sources = new Map<string, string>();
  for (const b of allBlocks as Array<Record<string, unknown>>) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content as Array<{ url?: string; title?: string }>) if (r.url) sources.set(r.url, r.title ?? r.url);
    }
    if (b.type === 'text' && Array.isArray(b.citations)) {
      for (const c of b.citations as Array<{ url?: string; title?: string }>) if (c.url) sources.set(c.url, c.title ?? c.url);
    }
  }

  // Ground opportunities in the measured candidates.
  const notes: string[] = [];
  const opportunities: BriefOpportunity[] = [];
  const str = (x: unknown): string => (typeof x === 'string' ? x : '');
  for (const o of (Array.isArray(raw.opportunities) ? raw.opportunities : []) as Array<Record<string, unknown>>) {
    const id = str(o.candidate_id);
    const hit = cands.get(id);
    if (!hit) {
      notes.push(`Dropped "${id}" — not a measured setup.`);
      continue;
    }
    const { s, c } = hit;
    let conviction = Math.max(1, Math.min(5, Math.round(Number(o.conviction) || 1)));
    const measured = convictionFromStats(c.stats);
    if (conviction > measured) conviction = measured;
    const ev = eventRiskFor(s, c.horizon, events);
    if (ev.cap != null && conviction > ev.cap) {
      notes.push(`${s.symbol}: ${ev.label} — conviction capped at ${ev.cap}.`);
      conviction = ev.cap;
    }
    opportunities.push({
      candidate_id: id,
      symbol: s.symbol,
      asset_type: s.asset_type,
      horizon: c.horizon,
      direction: c.direction,
      setup_label: c.label,
      entry_kind: c.entry_kind,
      entry_zone: c.entry_zone,
      stop_loss: c.stop_loss,
      targets: c.targets,
      price: s.quant.daily?.indicators.price ?? s.quant.hourly?.indicators.price ?? c.entry_zone[1],
      backtest: { n: c.stats.n, win_rate: c.stats.win_rate, win_rate_lower: c.stats.win_rate_lower, avg_r: c.stats.avg_r },
      conviction,
      thesis: str(o.thesis),
      catalyst: str(o.catalyst),
      risks: str(o.risks),
      event_risk: ev.label,
    });
  }

  const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  const regime = raw.market_regime === 'risk_on' || raw.market_regime === 'risk_off' ? raw.market_regime : 'mixed';
  const brief: MarketBrief = {
    headline: str(raw.headline) || 'Market brief',
    market_regime: regime,
    summary_markdown: str(raw.summary_markdown),
    drivers: arr<MarketBrief['drivers'][number]>(raw.drivers).filter((d) => d && d.title),
    event_watch: arr<MarketBrief['event_watch'][number]>(raw.event_watch).filter((d) => d && d.title),
    opportunities,
    watch: arr<MarketBrief['watch'][number]>(raw.watch).filter((d) => d && d.symbol),
    avoid: arr<MarketBrief['avoid'][number]>(raw.avoid).filter((d) => d && d.symbol),
    sources: [...sources.entries()].slice(0, 15).map(([url, title]) => ({ url, title })),
    fear_greed: fg,
    scanned: scanned.length,
    measured_candidates: cands.size,
    notes,
  };

  const ins = await query<{ id: string; created_at: string }>(
    `INSERT INTO market_briefs (user_id, model, data, input_tokens, output_tokens)
     VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING id, created_at`,
    [userId, model, JSON.stringify(brief), inTok, outTok],
  );
  return { id: ins.rows[0]!.id, created_at: ins.rows[0]!.created_at, model, data: brief };
}

export async function latestBrief(userId: string): Promise<BriefRow | null> {
  const r = await query<BriefRow>(
    `SELECT id, created_at, model, data FROM market_briefs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return r.rows[0] ?? null;
}
