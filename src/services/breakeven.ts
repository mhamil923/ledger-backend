// Crypto break-even + DCA planner (used by the app's "Break-even & DCA" screen
// and by scripts/breakeven.ts / crypto-breakeven.command).
//
// Break-even = (cash put in − cash taken out) ÷ coins held now: the price where
// selling everything gets all your money back. History comes from Coinbase's
// v2 transactions (buys, sells, converts, advanced-trade fills, rewards,
// transfers) plus advanced-trade fees.
//
// DCA plan: your monthly crypto budget as steady weekly buys, sized up when
// the market is fearful / the coin is cheap vs its own trend and down when
// it's greedy / stretched. Rules are fixed and shown to the user.

import { coinbaseFetch } from './coinbase-trade.js';
import { rsi, sma } from './ta.js';
import { query } from '../db.js';
import { currentMonth } from './envelope.js';

interface V2Account {
  id: string;
  name: string;
  type: string;
  currency: { code: string; name?: string } | string;
  balance: { amount: string; currency: string };
}
interface V2Tx {
  id: string;
  type: string;
  status: string;
  amount: { amount: string; currency: string };
  native_amount: { amount: string; currency: string };
  created_at: string;
}
interface Page<T> {
  data: T[];
  pagination?: { next_uri?: string | null };
}
interface Fill {
  product_id: string;
  side: 'BUY' | 'SELL';
  commission: string;
}

const STABLE = new Set(['USD', 'USDC', 'USDT', 'DAI', 'PYUSD', 'GUSD', 'EUR', 'GBP']);
const REWARD_TYPES = new Set([
  'staking_reward', 'inflation_reward', 'interest', 'earn_payout', 'reward',
  'learning_reward', 'incentives_rewards_payout', 'incentives_shared_reward',
  'coinbase_one_reward', 'airdrop', 'staking_transfer_reward', 'subscription_rebate',
]);
const INTERNAL_TYPES = new Set([
  'transfer', 'vault_withdrawal', 'exchange_deposit', 'exchange_withdrawal',
  'pro_deposit', 'pro_withdrawal', 'staking_transfer', 'unstaking_transfer',
  'wrap_asset', 'unwrap_asset', 'retail_simple_dust',
]);
const BUYISH = ['buy', 'advanced_trade_fill', 'trade', 'convert', 'swap', 'tx'];
const SELLISH = ['sell', 'advanced_trade_fill', 'trade', 'convert', 'swap', 'tx'];

/** Positions worth less than this (both put in and current value) are "dust". */
export const DUST_USD = 5;
/** DCA only into coins with at least this much in them. */
const DCA_MIN_USD = 20;

function dcaEligible(p: { dust: boolean; status: string; net: number; value: number }): boolean {
  return !p.dust && p.status !== 'exited' && (p.net > DCA_MIN_USD || p.value > DCA_MIN_USD);
}

export interface Position {
  code: string;
  qty: number;
  price: number;
  value: number;
  cash_in: number;
  cash_out: number;
  net: number;
  pl: number;
  pl_pct: number | null;
  breakeven: number;
  rise_needed: number;
  /** exited = you hold almost none of it anymore (sold or sent away). */
  status: 'house_money' | 'above' | 'below' | 'exited';
  fees: number;
  dust: boolean;
  add_scenarios: Array<{ add: number; breakeven: number; needs: number }>;
  targets: Array<{ needs: number; add: number }>;
  notes: string[];
}

export interface DcaCoin {
  code: string;
  mult: number;
  weekly: number;
  monthly: number;
  signals: string[];
  rsi: number | null;
  vs_ma: number | null;
  ma_len: number | null;
  downtrend: boolean;
  status: Position['status'];
  projections: Array<{ label: string; weeks: number; added: number; breakeven: number; needs: number }>;
  down30: { breakeven: number; end_price: number; needs: number } | null;
  up30: { breakeven: number; end_price: number; needs: number } | null;
}

export interface DcaPlan {
  monthly: number;
  budget_source: 'given' | 'investing_envelope';
  base_weekly: number;
  per_coin_weekly: number;
  mood: { value: number; label: string; mult: number } | null;
  coins: DcaCoin[];
  week_total: number;
  /** Positive = over the normal weekly pace this week, negative = under. */
  vs_normal: number;
  /** If over pace and no cash saved up: same split, scaled to the normal pace. */
  scaled: Array<{ code: string; weekly: number }> | null;
}

export interface CryptoPlan {
  generated_at: string;
  positions: Position[];
  totals: { net: number; value: number; pl: number; pl_pct: number | null };
  investing_envelope: number | null;
  /** Coins eligible for DCA (not dust). */
  dca_eligible: string[];
  dca: DcaPlan | null;
}

// ---------------------------------------------------------------------------
// Coinbase history
// ---------------------------------------------------------------------------

async function allPages<T>(firstPath: string): Promise<T[]> {
  const out: T[] = [];
  let path: string | null = firstPath;
  for (let i = 0; path && i < 200; i++) {
    const page: Page<T> = await coinbaseFetch<Page<T>>('GET', path);
    out.push(...(page.data ?? []));
    path = page.pagination?.next_uri || null;
  }
  return out;
}

async function allFills(): Promise<Fill[]> {
  const out: Fill[] = [];
  let cursor = '';
  for (let i = 0; i < 200; i++) {
    const qs = new URLSearchParams({ limit: '250' });
    if (cursor) qs.set('cursor', cursor);
    const r = await coinbaseFetch<{ fills: Fill[]; cursor?: string }>('GET', `/api/v3/brokerage/orders/historical/fills?${qs.toString()}`);
    out.push(...(r.fills ?? []));
    if (!r.cursor || !r.fills?.length) break;
    cursor = r.cursor;
  }
  return out;
}

async function spot(code: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.coinbase.com/v2/prices/${code}-USD/spot`);
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { amount?: string } };
    const p = Number(j.data?.amount);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

const fmtQty = (x: number): string => x.toLocaleString('en-US', { maximumFractionDigits: 4 });
const fmtUsd = (x: number): string => '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function analyse(code: string, qty: number, p: number, txs: V2Tx[], fees: { buy: number; sell: number }): Position {
  txs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  let q = 0, cashIn = 0, cashOut = 0, freeQty = 0, extInQty = 0, extInUsd = 0, extOutQty = 0;
  const unknown = new Set<string>();
  for (const t of txs) {
    if (t.status && !['completed', 'pending'].includes(t.status)) continue;
    const amt = Number(t.amount.amount);
    const val = Math.abs(Number(t.native_amount?.amount ?? 0));
    if (!Number.isFinite(amt) || amt === 0 || INTERNAL_TYPES.has(t.type)) continue;
    if (amt > 0) {
      q += amt;
      if (REWARD_TYPES.has(t.type)) freeQty += amt;
      else if (t.type === 'send' || t.type === 'receive') {
        extInQty += amt;
        extInUsd += val;
        cashIn += val;
      } else {
        if (!BUYISH.includes(t.type)) unknown.add(t.type);
        cashIn += val;
      }
    } else {
      const out = -amt;
      q -= out;
      if (t.type === 'send') extOutQty += out;
      else {
        if (!SELLISH.includes(t.type)) unknown.add(t.type);
        cashOut += val;
      }
    }
  }
  cashIn += fees.buy;
  cashOut -= fees.sell;
  const net = cashIn - cashOut;
  const value = qty * p;
  const breakeven = qty > 0 ? net / qty : 0;
  const pl = value - net;
  const rise = breakeven > 0 ? breakeven / p - 1 : 0;
  const exited = value < DUST_USD && net >= DUST_USD;
  const status: Position['status'] = exited ? 'exited' : net <= 0 ? 'house_money' : pl >= 0 ? 'above' : 'below';

  const add_scenarios = status === 'below'
    ? [100, 250, 500, 1000, 2500].map((add) => {
        const be = (net + add) / (qty + add / p);
        return { add, breakeven: be, needs: be / p - 1 };
      })
    : [];
  const targets = status === 'below'
    ? [0.5, 0.25, 0.1].filter((t) => t < rise).map((t) => ({ needs: t, add: (net - p * (1 + t) * qty) / t }))
    : [];

  const notes: string[] = [];
  if (freeQty > 0) notes.push(`${fmtQty(freeQty)} ${code} came from rewards/staking (counted as free).`);
  if (extInQty > 0) notes.push(`${fmtQty(extInQty)} ${code} arrived from outside Coinbase, counted at its ${fmtUsd(extInUsd)} value on arrival.`);
  if (extOutQty > 0) notes.push(`${fmtQty(extOutQty)} ${code} was sent off Coinbase — if you still own it elsewhere, your real break-even is lower.`);
  if (exited) notes.unshift(`You hold almost no ${code} now — the ${fmtUsd(net)} gap is money lost on coins you sold${extOutQty > 0 ? ' or sent to another wallet' : ''}. Break-even doesn't apply.`);
  if (Math.abs(q - qty) > Math.max(1e-6, qty * 0.01)) notes.push(`History adds up to ${fmtQty(q)} but your balance is ${fmtQty(qty)} — some history may be missing.`);
  if (unknown.size) notes.push(`Counted as buys/sells: ${[...unknown].join(', ')}.`);

  return {
    code, qty, price: p, value, cash_in: cashIn, cash_out: cashOut, net, pl,
    pl_pct: net > 0 ? pl / net : null, breakeven, rise_needed: rise, status,
    fees: fees.buy + fees.sell, dust: net < DUST_USD && value < DUST_USD,
    add_scenarios, targets, notes,
  };
}

let posCache: { at: number; positions: Position[] } | null = null;
let inflight: Promise<Position[]> | null = null;

export async function loadPositions(refresh = false): Promise<Position[]> {
  if (!refresh && posCache && Date.now() - posCache.at < 15 * 60_000) {
    // Re-price cached positions cheaply? Keep it simple: cache 15 min.
    return posCache.positions;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    const accounts = await allPages<V2Account>('/v2/accounts?limit=100');
    const codeOf = (a: V2Account): string => (typeof a.currency === 'string' ? a.currency : a.currency.code).toUpperCase();
    const byCode = new Map<string, V2Account[]>();
    for (const a of accounts) {
      const c = codeOf(a);
      if (a.type === 'fiat' || STABLE.has(c)) continue;
      byCode.set(c, [...(byCode.get(c) ?? []), a]);
    }
    const held = [...byCode.entries()].filter(([, accs]) => accs.reduce((s, a) => s + Number(a.balance.amount), 0) > 0);
    const fills = await allFills().catch(() => [] as Fill[]);
    const feeBy = new Map<string, { buy: number; sell: number }>();
    for (const f of fills) {
      const [base, quote] = f.product_id.split('-');
      if (!base || !quote || !STABLE.has(quote)) continue;
      const e = feeBy.get(base) ?? { buy: 0, sell: 0 };
      if (f.side === 'BUY') e.buy += Number(f.commission) || 0;
      else e.sell += Number(f.commission) || 0;
      feeBy.set(base, e);
    }
    const rows = await mapLimit(held, 4, async ([code, accs]) => {
      const txs: V2Tx[] = [];
      for (const a of accs) txs.push(...(await allPages<V2Tx>(`/v2/accounts/${a.id}/transactions?limit=100`)));
      const p = await spot(code);
      if (p == null) return null;
      const qty = accs.reduce((s, a) => s + Number(a.balance.amount), 0);
      return analyse(code, qty, p, txs, feeBy.get(code) ?? { buy: 0, sell: 0 });
    });
    const positions = rows.filter((r): r is Position => r != null).sort((a, b) => b.net - a.net);
    posCache = { at: Date.now(), positions };
    return positions;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

// ---------------------------------------------------------------------------
// DCA
// ---------------------------------------------------------------------------

async function fearGreed(): Promise<DcaPlan['mood']> {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1');
    const j = (await res.json()) as { data?: Array<{ value: string; value_classification: string }> };
    const v = Number(j.data?.[0]?.value);
    if (!Number.isFinite(v)) return null;
    const mult = v < 25 ? 1.5 : v < 45 ? 1.25 : v <= 55 ? 1 : v <= 75 ? 0.75 : 0.5;
    return { value: v, label: j.data![0]!.value_classification, mult };
  } catch {
    return null;
  }
}

const pctStr = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;

async function coinTech(code: string): Promise<{ rsi: number; vs: number; maLen: number; downtrend: boolean; adj: number; why: string[] } | null> {
  try {
    const res = await fetch(`https://api.exchange.coinbase.com/products/${code}-USD/candles?granularity=86400`);
    if (!res.ok) return null;
    const raw = (await res.json()) as number[][];
    const closes = raw.map((r) => r[4]!).reverse();
    if (closes.length < 60) return null;
    const last = closes[closes.length - 1]!;
    const maLen = closes.length >= 200 ? 200 : 100;
    const ma = sma(closes, maLen).at(-1)!;
    const ma50 = sma(closes, 50).at(-1)!;
    const r = rsi(closes, 14).at(-1)!;
    const vs = last / ma - 1;
    const downtrend = last < ma && ma50 < ma;
    let adj = 0;
    const why: string[] = [];
    if (r < 30) { adj += 0.25; why.push(`Oversold (RSI ${r.toFixed(0)})`); }
    else if (r < 40) { adj += 0.1; why.push(`Weak momentum (RSI ${r.toFixed(0)})`); }
    else if (r > 70) { adj -= 0.25; why.push(`Overbought (RSI ${r.toFixed(0)})`); }
    else if (r > 60) { adj -= 0.1; why.push(`Running hot (RSI ${r.toFixed(0)})`); }
    if (vs < -0.3) { adj += 0.15; why.push(`${pctStr(vs)} vs its ${maLen}-day average — cheap`); }
    else if (vs > 0.4) { adj -= 0.25; why.push(`${pctStr(vs)} vs its ${maLen}-day average — stretched`); }
    if (downtrend) why.push('Still in a downtrend — capped at 1.25×');
    if (!why.length) why.push(`Neutral (RSI ${r.toFixed(0)}, ${pctStr(vs)} vs ${maLen}-day avg)`);
    return { rsi: r, vs, maLen, downtrend, adj, why };
  } catch {
    return null;
  }
}

export async function investingEnvelope(): Promise<number | null> {
  try {
    const r = await query<{ b: string }>(
      `SELECT cb.budgeted::text AS b FROM categories c
       JOIN category_budgets cb ON cb.category_id = c.id
       WHERE lower(c.name) = 'investing' AND cb.month <= $1 AND cb.budgeted > 0
       ORDER BY cb.month DESC, cb.budgeted DESC LIMIT 1`,
      [currentMonth()],
    );
    const b = Number(r.rows[0]?.b);
    return Number.isFinite(b) && b > 0 ? b : null;
  } catch {
    return null;
  }
}

function simulate(p: Position, weekly: number, weeks: number, endMove: number): { be: number; added: number; endPrice: number } {
  let net = p.net, qty = p.qty;
  for (let k = 1; k <= weeks; k++) {
    const price = p.price * (1 + (endMove * k) / weeks);
    net += weekly;
    qty += weekly / price;
  }
  return { be: net / qty, added: weekly * weeks, endPrice: p.price * (1 + endMove) };
}

export async function buildDca(positions: Position[], monthly: number, source: DcaPlan['budget_source'], only?: string[]): Promise<DcaPlan | null> {
  let coins = positions.filter(dcaEligible);
  if (only?.length) coins = coins.filter((p) => only.includes(p.code));
  if (!coins.length || !(monthly > 0)) return null;
  const mood = await fearGreed();
  const base = (monthly * 12) / 52;
  const per = base / coins.length;
  const techs = await mapLimit(coins, 4, (p) => coinTech(p.code));
  const out: DcaCoin[] = coins.map((p, i) => {
    const t = techs[i];
    let mult = (mood?.mult ?? 1) * (1 + (t?.adj ?? 0));
    if (t?.downtrend) mult = Math.min(mult, 1.25);
    mult = Math.max(0.25, Math.min(2, mult));
    const weekly = per * mult;
    // Projections only mean something for coins still below break-even.
    const below = p.status === 'below';
    const projections = !below ? [] : ([['2 weeks', 2], ['1 month', 4], ['3 months', 13], ['6 months', 26]] as const).map(([label, weeks]) => {
      const s = simulate(p, per, weeks, 0);
      return { label, weeks, added: s.added, breakeven: s.be, needs: s.be / p.price - 1 };
    });
    const d = simulate(p, per, 13, -0.3);
    const u = simulate(p, per, 13, 0.3);
    return {
      code: p.code, mult, weekly, monthly: (weekly * 52) / 12,
      signals: t?.why ?? ['No chart data — normal size'],
      rsi: t?.rsi ?? null, vs_ma: t?.vs ?? null, ma_len: t?.maLen ?? null, downtrend: t?.downtrend ?? false,
      status: p.status,
      projections,
      down30: below ? { breakeven: d.be, end_price: d.endPrice, needs: d.be / d.endPrice - 1 } : null,
      up30: below ? { breakeven: u.be, end_price: u.endPrice, needs: u.be / u.endPrice - 1 } : null,
    };
  });
  const total = out.reduce((s, c) => s + c.weekly, 0);
  const diff = total - base;
  return {
    monthly, budget_source: source, base_weekly: base, per_coin_weekly: per, mood, coins: out,
    week_total: total, vs_normal: diff,
    scaled: diff > 0.5 ? out.map((c) => ({ code: c.code, weekly: (c.weekly * base) / total })) : null,
  };
}

export async function getCryptoPlan(opts: { budget?: number | null; refresh?: boolean; only?: string[] } = {}): Promise<CryptoPlan> {
  const [positions, env] = await Promise.all([loadPositions(opts.refresh), investingEnvelope()]);
  const shown = positions;
  const net = shown.reduce((s, p) => s + p.net, 0);
  const value = shown.reduce((s, p) => s + p.value, 0);
  const monthly = opts.budget && opts.budget > 0 ? opts.budget : env;
  // `only` picks which coins the DCA plan buys; every position is still listed.
  const dca = monthly ? await buildDca(shown, monthly, opts.budget && opts.budget > 0 ? 'given' : 'investing_envelope', opts.only) : null;
  return {
    generated_at: new Date((posCache?.at ?? Date.now())).toISOString(),
    positions: shown,
    totals: { net, value, pl: value - net, pl_pct: net > 0 ? (value - net) / net : null },
    investing_envelope: env,
    dca_eligible: positions.filter(dcaEligible).map((p) => p.code),
    dca,
  };
}
