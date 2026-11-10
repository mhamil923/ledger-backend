// Text version of the app's "Break-even & DCA" screen (crypto-breakeven.command).
// The math lives in src/services/breakeven.ts so both always agree.
// Usage:
//   npm run breakeven                    # every coin you hold
//   npm run breakeven HBAR XLM           # just these
//   npm run breakeven -- --budget 400    # DCA plan for a $400/month budget
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDca, investingEnvelope, loadPositions } from '../src/services/breakeven.js';
import { pool } from '../src/db.js';

const usd = (x: number): string =>
  (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const price = (x: number): string => '$' + (x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toPrecision(4));
const pct = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

async function askBudget(fallback: number | null): Promise<number | null> {
  if (!process.stdin.isTTY) return fallback;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const hint = fallback ? ` [Enter = ${usd(fallback)}, your Investing envelope]` : '';
  const ans = (await rl.question(`\nHow much per MONTH can go toward buying these coins?${hint} $`)).trim();
  rl.close();
  const n = Number(ans.replace(/[$,]/g, ''));
  return ans === '' ? fallback : Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let budgetArg: number | null = null;
  const want: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--budget')) {
      const v = a.includes('=') ? a.split('=')[1] : argv[++i];
      const n = Number(String(v).replace(/[$,]/g, ''));
      if (Number.isFinite(n) && n > 0) budgetArg = n;
    } else want.push(a.toUpperCase());
  }
  console.log('Pulling your Coinbase history… (tip: this is also in the app — Portfolio → Break-even & DCA)');
  let positions = await loadPositions(true);
  if (want.length) positions = positions.filter((p) => want.includes(p.code));
  if (!positions.length) {
    console.log(want.length ? `You don't currently hold ${want.join(', ')} on Coinbase.` : 'No coins held on Coinbase.');
    return;
  }

  const lines: string[] = [];
  const say = (s = ''): void => { lines.push(s); console.log(s); };
  say();
  say('================ CRYPTO BREAK-EVEN ' + new Date().toLocaleString() + ' ================');
  say('Break-even = (cash you put in − cash you took out) ÷ coins you hold now.');
  let totNet = 0, totVal = 0;
  const dust = positions.filter((p) => p.dust);
  for (const r of positions.filter((p) => !p.dust)) {
    totNet += r.net; totVal += r.value;
    say();
    say(`── ${r.code} ──────────────────────────────────────────────`);
    say(`  Holding        ${r.qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${r.code}  @ ${price(r.price)}  = ${usd(r.value)}`);
    say(`  Put in         ${usd(r.cash_in)}${r.fees ? `  (incl. ${usd(r.fees)} trade fees)` : ''}`);
    say(`  Taken out      ${usd(r.cash_out)}`);
    say(`  Up / down      ${usd(r.pl)}  (${r.pl_pct != null ? pct(r.pl_pct) : 'n/a'})`);
    if (r.status === 'house_money') say(`  ✅ Playing with house money — you've taken out more than you put in.`);
    else if (r.status === 'above') say(`  ✅ Above break-even (${price(r.breakeven)}).`);
    else {
      say(`  Break-even     ${price(r.breakeven)}  → needs ${pct(r.rise_needed)} from here`);
      for (const s of r.add_scenarios) say(`     add ${usd(s.add).padEnd(10)} → break-even ${price(s.breakeven).padEnd(11)} (needs ${pct(s.needs)})`);
      for (const t of r.targets) say(`     To need only ${pct(t.needs)}: add about ${usd(t.add)}`);
    }
    for (const n of r.notes) say(`  note: ${n}`);
  }
  if (dust.length) {
    totNet += dust.reduce((s, p) => s + p.net, 0);
    totVal += dust.reduce((s, p) => s + p.value, 0);
    say();
    say(`Small positions (under $5, hidden): ${dust.map((p) => p.code).join(', ')}`);
  }
  say();
  say(`ALL COINS: put in ${usd(totNet)} · worth ${usd(totVal)} · ${usd(totVal - totNet)}${totNet > 0 ? ` (${pct((totVal - totNet) / totNet)})` : ''}`);

  const env = await investingEnvelope();
  const monthly = budgetArg ?? (await askBudget(env));
  const plan = monthly ? await buildDca(positions, monthly, budgetArg ? 'given' : 'investing_envelope') : null;
  if (plan) {
    say();
    say('================ DCA PLAN ================');
    say(`  ${usd(plan.monthly)}/month = ${usd(plan.base_weekly)}/week normal pace (${usd(plan.per_coin_weekly)}/week per coin).`);
    say(plan.mood ? `  Market mood: Fear & Greed ${plan.mood.value} (${plan.mood.label}) → ${plan.mood.mult}× normal.` : '  Market mood unavailable — neutral.');
    for (const c of plan.coins) say(`  ${c.code.padEnd(7)} ${usd(c.weekly).padStart(9)}/week  (${c.mult.toFixed(2)}×)  ${c.signals.join('; ')}`);
    say(`  TOTAL   ${usd(plan.week_total).padStart(9)}/week`);
    if (plan.scaled) say(`  No cash saved up for fearful weeks? Stay at ${usd(plan.base_weekly)}: ${plan.scaled.map((s) => `${s.code} ${usd(s.weekly)}`).join(', ')}`);
  }
  say();
  say('Not financial advice — adding money to a losing position only pays off if the coin recovers.');
  const out = resolve(process.cwd(), '..', 'crypto-breakeven-report.txt');
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`\nSaved to ${out}`);
}

main()
  .catch((e) => {
    console.error('\nFailed:', e instanceof Error ? e.message : e);
    if (String(e).includes('401')) console.error('Your Coinbase API key needs "View" permission.');
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
