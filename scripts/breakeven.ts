// Break-even calculator for every coin you hold on Coinbase.
// Pulls your full transaction history (buys, sells, converts, advanced-trade
// fills, rewards, transfers) and works out, per coin:
//   - how much cash you've put in vs taken out
//   - your break-even price, and how far the coin has to rise to get there
//   - what adding more money at today's price does to that break-even
// Usage:
//   npm run breakeven            # every coin you hold
//   npm run breakeven HBAR XLM   # just these
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { coinbaseFetch } from '../src/services/coinbase-trade.js';

interface V2Account {
  id: string;
  name: string;
  type: string; // wallet | fiat | vault
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
  details?: { title?: string; subtitle?: string };
}
interface Page<T> {
  data: T[];
  pagination?: { next_uri?: string | null };
}
interface Fill {
  product_id: string;
  side: 'BUY' | 'SELL';
  commission: string;
  trade_time: string;
}

const STABLE = new Set(['USD', 'USDC', 'USDT', 'DAI', 'PYUSD', 'GUSD', 'EUR', 'GBP']);
// Free coins: they add quantity at zero cost.
const REWARD_TYPES = new Set([
  'staking_reward', 'inflation_reward', 'interest', 'earn_payout', 'reward',
  'learning_reward', 'incentives_rewards_payout', 'incentives_shared_reward',
  'coinbase_one_reward', 'airdrop', 'staking_transfer_reward', 'subscription_rebate',
]);
// Moves between your own Coinbase wallets/vaults/staking — not buys or sells.
const INTERNAL_TYPES = new Set([
  'transfer', 'vault_withdrawal', 'exchange_deposit', 'exchange_withdrawal',
  'pro_deposit', 'pro_withdrawal', 'staking_transfer', 'unstaking_transfer',
  'wrap_asset', 'unwrap_asset', 'retail_simple_dust',
]);

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
    const r = await coinbaseFetch<{ fills: Fill[]; cursor?: string }>(
      'GET',
      `/api/v3/brokerage/orders/historical/fills?${qs.toString()}`,
    );
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

const usd = (x: number): string =>
  (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const price = (x: number): string =>
  '$' + (x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toPrecision(4));
const pct = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

interface Result {
  code: string;
  qty: number;
  computedQty: number;
  price: number;
  value: number;
  cashIn: number;
  cashOut: number;
  net: number;
  avgCostBasis: number;
  breakeven: number;
  riseNeeded: number;
  pl: number;
  freeQty: number;
  extInQty: number;
  extInUsd: number;
  extOutQty: number;
  fees: number;
  unknownTypes: string[];
}

function analyse(code: string, qty: number, p: number, txs: V2Tx[], fees: { buy: number; sell: number }): Result {
  txs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  let q = 0, cost = 0, cashIn = 0, cashOut = 0, freeQty = 0, extInQty = 0, extInUsd = 0, extOutQty = 0;
  const unknown = new Set<string>();
  for (const t of txs) {
    if (t.status && !['completed', 'pending'].includes(t.status)) continue;
    const amt = Number(t.amount.amount);
    const val = Math.abs(Number(t.native_amount?.amount ?? 0));
    if (!Number.isFinite(amt) || amt === 0) continue;
    if (INTERNAL_TYPES.has(t.type)) continue;
    if (amt > 0) {
      q += amt;
      if (REWARD_TYPES.has(t.type)) {
        freeQty += amt;
      } else if (t.type === 'send' || t.type === 'receive') {
        // Arrived from outside Coinbase: count it at its value on arrival.
        extInQty += amt;
        extInUsd += val;
        cost += val;
        cashIn += val;
      } else {
        if (!['buy', 'advanced_trade_fill', 'trade', 'convert', 'swap'].includes(t.type)) unknown.add(t.type);
        cost += val;
        cashIn += val;
      }
    } else {
      const out = -amt;
      const frac = q > 0 ? Math.min(1, out / q) : 0;
      cost -= cost * frac;
      q -= out;
      if (t.type === 'send') {
        extOutQty += out; // sent to an outside wallet — not a sale
      } else {
        if (!['sell', 'advanced_trade_fill', 'trade', 'convert', 'swap'].includes(t.type)) unknown.add(t.type);
        cashOut += val;
      }
    }
  }
  // Advanced-trade fees aren't in the fill amounts.
  cashIn += fees.buy;
  cost += fees.buy;
  cashOut -= fees.sell;
  // Coins sent out to your own wallet still count as yours for break-even
  // purposes only if they come back; they're excluded from qty here.
  const net = cashIn - cashOut;
  const value = qty * p;
  const breakeven = qty > 0 ? net / qty : 0;
  return {
    code, qty, computedQty: q, price: p, value, cashIn, cashOut, net,
    avgCostBasis: qty > 0 ? cost / Math.max(q, 1e-12) : 0,
    breakeven, riseNeeded: breakeven > 0 ? breakeven / p - 1 : 0, pl: value - net,
    freeQty, extInQty, extInUsd, extOutQty, fees: fees.buy + fees.sell, unknownTypes: [...unknown],
  };
}

/** Cash to add at price p so the break-even lands t above p. */
function cashForTarget(net: number, qty: number, p: number, t: number): number {
  return (net - p * (1 + t) * qty) / t;
}

async function main(): Promise<void> {
  const want = process.argv.slice(2).map((s) => s.toUpperCase());
  console.log('Pulling your Coinbase accounts…');
  const accounts = await allPages<V2Account>('/v2/accounts?limit=100');
  const codeOf = (a: V2Account): string => (typeof a.currency === 'string' ? a.currency : a.currency.code).toUpperCase();

  // Group wallets by coin (a coin can have a wallet + vault + staked wallet).
  const byCode = new Map<string, V2Account[]>();
  for (const a of accounts) {
    const c = codeOf(a);
    if (a.type === 'fiat' || STABLE.has(c)) continue;
    if (want.length && !want.includes(c)) continue;
    byCode.set(c, [...(byCode.get(c) ?? []), a]);
  }
  const held = [...byCode.entries()].filter(([, accs]) => accs.reduce((s, a) => s + Number(a.balance.amount), 0) > 0);
  if (held.length === 0) {
    console.log(want.length ? `You don't currently hold ${want.join(', ')} on Coinbase.` : 'No coins held on Coinbase.');
    return;
  }

  console.log('Pulling advanced-trade fees…');
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

  const results: Result[] = [];
  for (const [code, accs] of held) {
    process.stdout.write(`  ${code}: history… `);
    const txs: V2Tx[] = [];
    for (const a of accs) txs.push(...(await allPages<V2Tx>(`/v2/accounts/${a.id}/transactions?limit=100`)));
    const p = await spot(code);
    const qty = accs.reduce((s, a) => s + Number(a.balance.amount), 0);
    console.log(`${txs.length} transactions`);
    if (p == null) {
      console.log(`    (no USD price for ${code} — skipped)`);
      continue;
    }
    results.push(analyse(code, qty, p, txs, feeBy.get(code) ?? { buy: 0, sell: 0 }));
  }
  results.sort((a, b) => b.net - a.net);

  const lines: string[] = [];
  const say = (s = ''): void => { lines.push(s); console.log(s); };
  say();
  say('================ CRYPTO BREAK-EVEN ' + new Date().toLocaleString() + ' ================');
  say('Break-even = (cash you put in − cash you took out) ÷ coins you hold now.');
  say('That is the price where selling everything gets all your money back.');
  let totNet = 0, totVal = 0;
  for (const r of results) {
    totNet += r.net; totVal += r.value;
    say();
    say(`── ${r.code} ──────────────────────────────────────────────`);
    say(`  Holding        ${r.qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${r.code}  @ ${price(r.price)}  = ${usd(r.value)}`);
    say(`  Put in         ${usd(r.cashIn)}${r.fees ? `  (incl. ${usd(r.fees)} trade fees)` : ''}`);
    say(`  Taken out      ${usd(r.cashOut)}`);
    say(`  Net invested   ${usd(r.net)}`);
    say(`  Up / down      ${usd(r.pl)}  (${r.net > 0 ? pct(r.pl / r.net) : 'n/a'})`);
    if (r.net <= 0) {
      say(`  ✅ Already playing with house money — you've taken out more than you put in.`);
    } else if (r.pl >= 0) {
      say(`  ✅ Above break-even (${price(r.breakeven)}). Nothing needed.`);
    } else {
      say(`  Break-even     ${price(r.breakeven)}  → ${r.code} needs to rise ${pct(r.riseNeeded)} from here`);
      say(`  If you add more at today's price, your break-even becomes:`);
      for (const add of [100, 250, 500, 1000, 2500]) {
        const be = (r.net + add) / (r.qty + add / r.price);
        say(`     +${usd(add).padEnd(10)} → ${price(be).padEnd(11)} (needs ${pct(be / r.price - 1)})`);
      }
      const goals = [0.5, 0.25, 0.1].filter((t) => t < r.riseNeeded);
      for (const t of goals) {
        say(`     To need only ${pct(t)}: add about ${usd(cashForTarget(r.net, r.qty, r.price, t))}`);
      }
      say(`     (Buying at today's price can never get break-even all the way down to today's price —`);
      say(`      each dollar added gets you closer, but only a price rise closes the last gap.)`);
    }
    const notes: string[] = [];
    if (r.freeQty > 0) notes.push(`${r.freeQty.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${r.code} came from rewards/staking (counted as free)`);
    if (r.extInQty > 0) notes.push(`${r.extInQty.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${r.code} arrived from outside Coinbase, counted at its ${usd(r.extInUsd)} value on arrival`);
    if (r.extOutQty > 0) notes.push(`${r.extOutQty.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${r.code} was sent off Coinbase — if you still own it elsewhere, your real break-even is lower`);
    if (Math.abs(r.computedQty - r.qty) > Math.max(1e-6, r.qty * 0.01))
      notes.push(`history adds up to ${r.computedQty.toFixed(4)} but balance is ${r.qty.toFixed(4)} — some history may be missing`);
    if (r.unknownTypes.length) notes.push(`treated as buys/sells: ${r.unknownTypes.join(', ')}`);
    for (const n of notes) say(`  note: ${n}`);
  }
  say();
  say('── ALL COINS ──────────────────────────────────────────────');
  say(`  Net invested ${usd(totNet)} · worth ${usd(totVal)} · ${usd(totVal - totNet)}${totNet > 0 ? ` (${pct((totVal - totNet) / totNet)})` : ''}`);
  say();
  say('Not financial advice — adding money to a losing position only pays off if the coin recovers.');

  const out = resolve(process.cwd(), '..', 'crypto-breakeven-report.txt');
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`\nSaved to ${out}`);
}

main().catch((e) => {
  console.error('\nFailed:', e instanceof Error ? e.message : e);
  if (String(e).includes('401')) console.error('Your Coinbase API key needs "View" permission.');
  process.exit(1);
});
