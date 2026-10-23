// Envelope budget math, following Actual Budget's envelope budget
// (packages/loot-core/src/server/budget/envelope.ts):
//
//   balance(cat, m)  = carryover(cat, m) + budgeted(cat, m) + activity(cat, m)
//   carryover(cat,m) = balance(cat, m-1) if positive,
//                      or if the category has rollover_overspending on;
//                      otherwise 0 (the overspend hits To Budget instead)
//   To Budget(m)     = To Budget(m-1) + income(m) - budgeted(m)
//                      - overspending not rolled over from m-1
//                      - uncategorized spending in m
//
// Activity is the signed sum of categorized, non-transfer transactions on
// on-budget accounts, so refunds put money back into their category.
// Uncategorized money in counts as income; uncategorized money out comes
// straight out of To Budget, so the number never claims money you've spent.

import { pool } from '../db.js';
import { config } from '../config.js';

export function currentMonth(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.BUDGET_TZ,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  return `${y}-${m}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = shiftMonth(m, 1)) out.push(m);
  return out;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface BudgetSettings {
  start_month: string;
  starting_funds: number;
  processed_at: Date | null;
}

export async function getSettings(userId: string): Promise<BudgetSettings> {
  const res = await pool.query<{ start_month: string; starting_funds: string; processed_at: Date | null }>(
    `SELECT start_month, starting_funds::text, processed_at FROM budget_settings WHERE user_id = $1`,
    [userId],
  );
  if (res.rows[0]) {
    return {
      start_month: res.rows[0].start_month,
      starting_funds: Number(res.rows[0].starting_funds),
      processed_at: res.rows[0].processed_at,
    };
  }
  const start = currentMonth();
  await pool.query(
    `INSERT INTO budget_settings (user_id, start_month) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
    [userId, start],
  );
  return { start_month: start, starting_funds: 0, processed_at: null };
}

/** Brokerages and exchanges whose deposits count as "moved into trading". */
export const INVESTING_PATTERNS = [
  'coinbase',
  'robinhood',
  'alpaca',
  'webull',
  'fidelity',
  'schwab',
  'vanguard',
  'e*trade',
  'etrade',
  'kraken',
  'gemini',
  'interactive brokers',
  'polymarket',
];

export async function ensureDefaultCategories(userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO categories (user_id, name, group_name, is_income, sort_order)
     VALUES ($1, 'Income', 'Income', true, -1000)
     ON CONFLICT (user_id, (lower(name))) DO NOTHING`,
    [userId],
  );
  // An "Investing" envelope ties the budget to the trading side: money sent
  // to a brokerage or exchange lands here, and the dashboard reports it as
  // capital moved into trading.
  const inv = await pool.query<{ id: string }>(
    `INSERT INTO categories (user_id, name, group_name, sort_order)
     VALUES ($1, 'Investing', 'Savings', 900)
     ON CONFLICT (user_id, (lower(name))) DO NOTHING
     RETURNING id`,
    [userId],
  );
  const id = inv.rows[0]?.id;
  if (id) {
    for (const p of INVESTING_PATTERNS) {
      await pool.query(
        `INSERT INTO category_rules (user_id, field, op, value, category_id, source)
         VALUES ($1, 'any', 'contains', $2, $3, 'category_pattern')`,
        [userId, p, id],
      );
    }
  }
}

/**
 * When a month at or before today has nothing budgeted yet, copy last month's
 * amounts forward so the budget never starts blank.
 */
export async function autofillMonth(userId: string, month: string, startMonth: string): Promise<boolean> {
  if (month > currentMonth() || month <= startMonth) return false;
  const existing = await pool.query(
    `SELECT 1 FROM category_budgets cb JOIN categories c ON c.id = cb.category_id
     WHERE c.user_id = $1 AND cb.month = $2 LIMIT 1`,
    [userId, month],
  );
  if (existing.rows.length > 0) return false;
  const res = await copyMonth(userId, shiftMonth(month, -1), month, false);
  return res > 0;
}

/** Copy budgeted amounts from one month to another. Returns rows written. */
export async function copyMonth(
  userId: string,
  from: string,
  to: string,
  overwrite: boolean,
): Promise<number> {
  const res = await pool.query(
    `INSERT INTO category_budgets (category_id, month, budgeted)
     SELECT cb.category_id, $3, cb.budgeted
     FROM category_budgets cb
     JOIN categories c ON c.id = cb.category_id
     WHERE c.user_id = $1 AND cb.month = $2 AND c.is_income = false AND c.hidden = false
       AND cb.budgeted <> 0
     ON CONFLICT (category_id, month) DO ${overwrite ? 'UPDATE SET budgeted = EXCLUDED.budgeted, updated_at = now()' : 'NOTHING'}`,
    [userId, from, to],
  );
  return res.rowCount ?? 0;
}

export interface EnvelopeCategory {
  id: string;
  name: string;
  group_name: string;
  is_income: boolean;
  rollover_overspending: boolean;
  hidden: boolean;
  sort_order: number;
  budgeted: number;
  activity: number;
  carryover: number;
  balance: number;
  bill: {
    id: string;
    cadence: string;
    amount: number;
    next_due_date: string | null;
    monthly_equivalent: number;
  } | null;
  match_patterns: string[];
}

export interface EnvelopeMonth {
  month: string;
  start_month: string;
  starting_funds: number;
  before_start: boolean;
  to_budget: number;
  summary: {
    carried_in: number;
    income: number;
    budgeted: number;
    spent: number;
    overspent_last_month: number;
    uncategorized_spent: number;
    uncategorized_count: number;
    transfers_excluded: number;
    available_in_categories: number;
  };
  groups: Array<{ name: string; budgeted: number; activity: number; balance: number; categories: EnvelopeCategory[] }>;
  income_categories: Array<{ id: string; name: string; activity: number }>;
}

const MONTHLY_EQ: Record<string, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  annual: 1 / 12,
  custom: 1,
};

export function billMonthlyEquivalent(amount: number, cadence: string): number {
  return round2(amount * (MONTHLY_EQ[cadence] ?? 1));
}

const GROUP_ORDER = (name: string): number =>
  name === 'Bills' ? 0 : name === 'Everyday' ? 1 : name === 'Savings' ? 8 : name === 'Income' ? 9 : 5;

export async function computeEnvelope(userId: string, month: string): Promise<EnvelopeMonth> {
  const settings = await getSettings(userId);
  const start = settings.start_month;
  const tz = config.BUDGET_TZ;

  const [catsRes, budgetsRes, activityRes, looseRes, billsRes, patternsRes] = await Promise.all([
    pool.query<{
      id: string;
      name: string;
      group_name: string;
      is_income: boolean;
      rollover_overspending: boolean;
      hidden: boolean;
      sort_order: number;
    }>(
      `SELECT id, name, group_name, is_income, rollover_overspending, hidden, sort_order
       FROM categories WHERE user_id = $1`,
      [userId],
    ),
    pool.query<{ category_id: string; month: string; budgeted: string }>(
      `SELECT cb.category_id, cb.month, cb.budgeted::text
       FROM category_budgets cb JOIN categories c ON c.id = cb.category_id
       WHERE c.user_id = $1 AND cb.month >= $2 AND cb.month <= $3`,
      [userId, start, month],
    ),
    // Categorized activity per category per month (on-budget, not transfers).
    pool.query<{ category_id: string; month: string; total: string }>(
      `SELECT t.category_id, to_char(t.posted_at AT TIME ZONE $4, 'YYYY-MM') AS month,
              SUM(t.amount)::text AS total
       FROM transactions t JOIN bank_accounts ba ON ba.id = t.account_id
       WHERE t.user_id = $1 AND ba.on_budget AND NOT t.is_transfer
         AND t.category_id IS NOT NULL
         AND to_char(t.posted_at AT TIME ZONE $4, 'YYYY-MM') BETWEEN $2 AND $3
       GROUP BY 1, 2`,
      [userId, start, month, tz],
    ),
    // Uncategorized money in/out and transfers per month.
    pool.query<{ month: string; uncat_in: string; uncat_out: string; uncat_out_count: string; transfers: string }>(
      `SELECT to_char(t.posted_at AT TIME ZONE $4, 'YYYY-MM') AS month,
              COALESCE(SUM(t.amount) FILTER (WHERE NOT t.is_transfer AND t.category_id IS NULL AND t.amount > 0), 0)::text AS uncat_in,
              COALESCE(SUM(t.amount) FILTER (WHERE NOT t.is_transfer AND t.category_id IS NULL AND t.amount < 0), 0)::text AS uncat_out,
              COUNT(*) FILTER (WHERE NOT t.is_transfer AND t.category_id IS NULL AND t.amount < 0)::text AS uncat_out_count,
              COALESCE(SUM(ABS(t.amount)) FILTER (WHERE t.is_transfer AND t.amount < 0), 0)::text AS transfers
       FROM transactions t JOIN bank_accounts ba ON ba.id = t.account_id
       WHERE t.user_id = $1 AND ba.on_budget
         AND to_char(t.posted_at AT TIME ZONE $4, 'YYYY-MM') BETWEEN $2 AND $3
       GROUP BY 1`,
      [userId, start, month, tz],
    ),
    pool.query<{ id: string; category_id: string; cadence: string; amount: string; next_due_date: string | null }>(
      `SELECT id, category_id, cadence, amount::text, next_due_date::text
       FROM bills WHERE user_id = $1 AND active = true AND category_id IS NOT NULL`,
      [userId],
    ),
    pool.query<{ category_id: string; value: string }>(
      `SELECT category_id, value FROM category_rules
       WHERE user_id = $1 AND source = 'category_pattern' AND category_id IS NOT NULL
       ORDER BY created_at`,
      [userId],
    ),
  ]);

  const key = (c: string, m: string): string => `${c}|${m}`;
  const budgeted = new Map<string, number>();
  for (const r of budgetsRes.rows) budgeted.set(key(r.category_id, r.month), Number(r.budgeted));
  const activity = new Map<string, number>();
  for (const r of activityRes.rows) activity.set(key(r.category_id, r.month), Number(r.total));
  const loose = new Map(looseRes.rows.map((r) => [r.month, r]));

  const cats = catsRes.rows;
  const spendCats = cats.filter((c) => !c.is_income);
  const incomeCats = cats.filter((c) => c.is_income);

  const beforeStart = month < start;
  let toBudget = 0;
  let carriedIn = 0;
  let overspentLast = 0;
  let incomeM = 0;
  let budgetedM = 0;
  let spentM = 0;
  let uncatOutM = 0;
  let uncatCountM = 0;
  let transfersM = 0;
  const balances = new Map<string, number>(); // balance at end of previous month
  const detail = new Map<string, { budgeted: number; activity: number; carryover: number; balance: number }>();

  if (!beforeStart) {
    toBudget = settings.starting_funds;
    for (const m of monthsBetween(start, month)) {
      const l = loose.get(m);
      const income =
        Number(l?.uncat_in ?? 0) +
        incomeCats.reduce((s, c) => s + (activity.get(key(c.id, m)) ?? 0), 0);
      const uncatOut = Number(l?.uncat_out ?? 0); // negative
      let budgetedTotal = 0;
      let overspent = 0; // negative balances from last month not rolled over
      let spent = 0;
      for (const c of spendCats) {
        const prev = balances.get(c.id) ?? 0;
        let carry = prev;
        if (prev < 0 && !c.rollover_overspending) {
          overspent += prev;
          carry = 0;
        }
        const b = budgeted.get(key(c.id, m)) ?? 0;
        const a = activity.get(key(c.id, m)) ?? 0;
        const bal = carry + b + a;
        balances.set(c.id, bal);
        budgetedTotal += b;
        spent += a;
        if (m === month) detail.set(c.id, { budgeted: b, activity: a, carryover: carry, balance: bal });
      }
      if (m === month) {
        carriedIn = toBudget;
        overspentLast = overspent;
        incomeM = income;
        budgetedM = budgetedTotal;
        spentM = spent;
        uncatOutM = uncatOut;
        uncatCountM = Number(l?.uncat_out_count ?? 0);
        transfersM = Number(l?.transfers ?? 0);
      }
      toBudget = toBudget + income - budgetedTotal + overspent + uncatOut;
    }
  }

  const billByCat = new Map(billsRes.rows.map((b) => [b.category_id, b]));
  const patternsByCat = new Map<string, string[]>();
  for (const p of patternsRes.rows) {
    const list = patternsByCat.get(p.category_id) ?? [];
    list.push(p.value);
    patternsByCat.set(p.category_id, list);
  }

  const groupsMap = new Map<string, EnvelopeCategory[]>();
  for (const c of spendCats) {
    const d = detail.get(c.id) ?? { budgeted: 0, activity: 0, carryover: 0, balance: 0 };
    if (c.hidden && d.balance === 0 && d.activity === 0) continue;
    const bill = billByCat.get(c.id);
    const row: EnvelopeCategory = {
      id: c.id,
      name: c.name,
      group_name: c.group_name,
      is_income: false,
      rollover_overspending: c.rollover_overspending,
      hidden: c.hidden,
      sort_order: c.sort_order,
      budgeted: round2(d.budgeted),
      activity: round2(d.activity),
      carryover: round2(d.carryover),
      balance: round2(d.balance),
      bill: bill
        ? {
            id: bill.id,
            cadence: bill.cadence,
            amount: Number(bill.amount),
            next_due_date: bill.next_due_date,
            monthly_equivalent: billMonthlyEquivalent(Number(bill.amount), bill.cadence),
          }
        : null,
      match_patterns: patternsByCat.get(c.id) ?? [],
    };
    const list = groupsMap.get(c.group_name) ?? [];
    list.push(row);
    groupsMap.set(c.group_name, list);
  }
  const groups = [...groupsMap.entries()]
    .sort((a, b) => GROUP_ORDER(a[0]) - GROUP_ORDER(b[0]) || a[0].localeCompare(b[0]))
    .map(([name, list]) => {
      list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
      return {
        name,
        budgeted: round2(list.reduce((s, c) => s + c.budgeted, 0)),
        activity: round2(list.reduce((s, c) => s + c.activity, 0)),
        balance: round2(list.reduce((s, c) => s + c.balance, 0)),
        categories: list,
      };
    });

  const l = loose.get(month);
  return {
    month,
    start_month: start,
    starting_funds: settings.starting_funds,
    before_start: beforeStart,
    to_budget: round2(toBudget),
    summary: {
      carried_in: round2(carriedIn),
      income: round2(incomeM),
      budgeted: round2(budgetedM),
      spent: round2(-spentM),
      overspent_last_month: round2(-overspentLast),
      uncategorized_spent: round2(-uncatOutM),
      uncategorized_count: uncatCountM,
      transfers_excluded: round2(transfersM),
      available_in_categories: round2(groups.reduce((s, g) => s + g.balance, 0)),
    },
    groups,
    income_categories: incomeCats.map((c) => ({
      id: c.id,
      name: c.name,
      activity: round2(
        (activity.get(key(c.id, month)) ?? 0) + (l && c.name.toLowerCase() === 'income' ? Number(l.uncat_in) : 0),
      ),
    })),
  };
}
