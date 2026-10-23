import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { isTransferOrPayment } from '../services/transactions-classify.js';

export const budgetsRouter = Router();
budgetsRouter.use(requireAuth);

interface BudgetRow {
  id: string;
  user_id: string;
  month: string;
  monthly_income: string;
  savings_target: string;
  created_at: Date;
  updated_at: Date;
}

interface BudgetCategoryRow {
  id: string;
  budget_id: string;
  name: string;
  monthly_limit: string;
  match_patterns: string[];
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

const monthRegex = /^\d{4}-\d{2}$/;

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Compute [start, endExclusive) timestamptz range for a YYYY-MM string.
 * We use exclusive end so 'transactions.posted_at < end' avoids off-by-one
 * on the last second of the month.
 */
function monthRange(month: string): { start: Date; end: Date } {
  const [y, m] = month.split('-').map((n) => Number(n));
  const start = new Date(Date.UTC(y!, m! - 1, 1));
  const end = new Date(Date.UTC(y!, m!, 1));
  return { start, end };
}

/**
 * Convert the numeric-string columns Postgres returns into JS numbers, since
 * the frontend expects numeric fields.
 */
function budgetOut(row: BudgetRow): {
  id: string;
  month: string;
  monthly_income: number;
  savings_target: number;
  created_at: Date;
} {
  return {
    id: row.id,
    month: row.month,
    monthly_income: Number(row.monthly_income),
    savings_target: Number(row.savings_target),
    created_at: row.created_at,
  };
}

function categoryOut(row: BudgetCategoryRow): {
  id: string;
  name: string;
  monthly_limit: number;
  match_patterns: string[];
  sort_order: number;
} {
  return {
    id: row.id,
    name: row.name,
    monthly_limit: Number(row.monthly_limit),
    match_patterns: row.match_patterns,
    sort_order: row.sort_order,
  };
}

interface BillFixedExpense {
  id: string;
  name: string;
  merchant: string | null;
  monthly_equivalent: number;
  spent_this_month: number;
  cadence: string;
}

/**
 * Auto-compute this month's actuals. Merges three sources:
 *   1. Bills (fixed expenses) — matched to transactions by merchant/name
 *   2. User-defined variable categories — matched by match_patterns
 *   3. Uncategorized outflow — everything real spend that fell through
 *
 * Excludes credit-card payments and internal transfers via
 * isTransferOrPayment so we don't double-count (paying off a CC isn't spend,
 * the original charges already were).
 */
async function computeActuals(
  userId: string,
  budgetId: string,
  month: string,
): Promise<{
  by_category: Record<string, number>;
  by_bill: Record<string, number>;
  fixed_expenses: BillFixedExpense[];
  uncategorized_spent: number;
  transfers_excluded: number;
  total_income: number;
  total_spent: number;
  total_fixed_planned: number;
  total_fixed_spent: number;
}> {
  const { start, end } = monthRange(month);
  const [cats, bills, txns] = await Promise.all([
    query<BudgetCategoryRow>(
      `SELECT * FROM budget_categories WHERE budget_id = $1 ORDER BY sort_order ASC`,
      [budgetId],
    ),
    query<{
      id: string;
      name: string;
      merchant: string | null;
      amount: string;
      cadence: string;
      next_due_date: string | null;
    }>(
      `SELECT id, name, merchant, amount, cadence, next_due_date::text FROM bills
       WHERE user_id = $1 AND active = true
       ORDER BY amount DESC`,
      [userId],
    ),
    query<{
      id: string;
      amount: string;
      description: string;
      merchant: string | null;
    }>(
      `SELECT id, amount, description, merchant
       FROM transactions
       WHERE user_id = $1 AND posted_at >= $2 AND posted_at < $3`,
      [userId, start, end],
    ),
  ]);

  const monthlyEquivalentMap: Record<string, number> = {
    weekly: 52 / 12,
    biweekly: 26 / 12,
    monthly: 1,
    quarterly: 1 / 3,
    annual: 1 / 12,
    custom: 1,
  };

  const by_category: Record<string, number> = {};
  for (const c of cats.rows) by_category[c.id] = 0;
  const by_bill: Record<string, number> = {};
  for (const b of bills.rows) by_bill[b.id] = 0;
  let uncategorized_spent = 0;
  let transfers_excluded = 0;
  let total_income = 0;
  let total_spent = 0;

  for (const t of txns.rows) {
    const amt = Number(t.amount);
    if (!Number.isFinite(amt)) continue;
    if (amt > 0) {
      total_income += amt;
      continue;
    }
    // Skip credit-card payments and internal transfers — not real spend.
    if (isTransferOrPayment(t.description, t.merchant)) {
      transfers_excluded += Math.abs(amt);
      continue;
    }
    const spent = Math.abs(amt);
    total_spent += spent;

    const haystack = `${t.description ?? ''} ${t.merchant ?? ''}`.toLowerCase();

    // 1) Try to match a bill first (fixed expenses take priority).
    let matched = false;
    for (const b of bills.rows) {
      const merch = (b.merchant ?? '').toLowerCase();
      const name = b.name.toLowerCase();
      if (
        (merch && merch.length > 3 && haystack.includes(merch)) ||
        (name && name.length > 3 && haystack.includes(name))
      ) {
        by_bill[b.id] = (by_bill[b.id] ?? 0) + spent;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // 2) Fall through to user categories.
    for (const c of cats.rows) {
      for (const pattern of c.match_patterns) {
        const needle = pattern.toLowerCase();
        const isMatch = needle.includes('%')
          ? new RegExp(
              '^' +
                needle
                  .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                  .replace(/%/g, '.*') +
                '$',
              'i',
            ).test(haystack) || haystack.includes(needle.replace(/%/g, ''))
          : haystack.includes(needle);
        if (isMatch) {
          by_category[c.id] = (by_category[c.id] ?? 0) + spent;
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) uncategorized_spent += spent;
  }

  // Only include a bill as a fixed expense for THIS month if it actually
  // hits this month. Rules:
  //   monthly / biweekly / weekly → always included (they hit every month)
  //   quarterly / annual / custom → included only if next_due_date is in the
  //   budget month OR we already saw a matching charge this month (by_bill>0).
  // This keeps a $325 annual Amex fee out of every monthly budget except May.
  const alwaysMonthly = new Set(['monthly', 'biweekly', 'weekly']);
  const fixed_expenses: BillFixedExpense[] = bills.rows
    .filter((b) => {
      if (alwaysMonthly.has(b.cadence)) return true;
      // Lumpy cadence — include only if it lands in this month
      // or was already charged this month.
      if ((by_bill[b.id] ?? 0) > 0) return true;
      if (b.next_due_date && b.next_due_date.startsWith(month)) return true;
      return false;
    })
    .map((b) => {
      // For lumpy bills that hit this month, use the FULL amount, not the
      // amortized monthly-equivalent — the user needs the real number that's
      // coming out of their checking this month.
      const isLumpy = !alwaysMonthly.has(b.cadence);
      const monthlyEq = isLumpy
        ? Number(b.amount)
        : Number(b.amount) * (monthlyEquivalentMap[b.cadence] ?? 1);
      return {
        id: b.id,
        name: b.name,
        merchant: b.merchant,
        monthly_equivalent: monthlyEq,
        spent_this_month: by_bill[b.id] ?? 0,
        cadence: b.cadence,
      };
    });
  const total_fixed_planned = fixed_expenses.reduce(
    (s, b) => s + b.monthly_equivalent,
    0,
  );
  const total_fixed_spent = fixed_expenses.reduce(
    (s, b) => s + b.spent_this_month,
    0,
  );

  return {
    by_category,
    by_bill,
    fixed_expenses,
    uncategorized_spent,
    transfers_excluded,
    total_income,
    total_spent,
    total_fixed_planned,
    total_fixed_spent,
  };
}

/**
 * GET /api/budgets?month=YYYY-MM — returns the budget for that month
 * (creating a blank one on the fly if none exists), its categories, actual
 * spending per category, uncategorized spending, and a rollup with
 * projected savings.
 */
const getSchema = z.object({
  month: z
    .string()
    .regex(monthRegex, 'month must be YYYY-MM')
    .optional(),
});
budgetsRouter.get('/', async (req, res) => {
  const parsed = getSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const month = parsed.data.month ?? currentMonth();

  // Upsert an empty budget for this month if none exists. Keeps GET
  // idempotent from the client's POV — the budget always "exists".
  const budgetRes = await query<BudgetRow>(
    `INSERT INTO budgets (user_id, month) VALUES ($1, $2)
     ON CONFLICT (user_id, month) DO UPDATE SET month = EXCLUDED.month
     RETURNING *`,
    [userId, month],
  );
  const budget = budgetRes.rows[0]!;

  const catsRes = await query<BudgetCategoryRow>(
    `SELECT * FROM budget_categories WHERE budget_id = $1 ORDER BY sort_order ASC`,
    [budget.id],
  );
  const actuals = await computeActuals(userId, budget.id, month);

  const income = Number(budget.monthly_income);
  const totalVariableBudgeted = catsRes.rows.reduce(
    (s, c) => s + Number(c.monthly_limit),
    0,
  );
  const savingsTarget = Number(budget.savings_target);
  // total_spent now excludes transfers/CC payments (fix for double-count).
  const projectedSavings = income - actuals.total_spent;
  // "Room to spend" is what's left after income minus fixed bills minus
  // variable category budgets minus savings target. Negative means
  // over-committed.
  const remainingToBudget =
    income - actuals.total_fixed_planned - totalVariableBudgeted - savingsTarget;

  res.json({
    budget: budgetOut(budget),
    categories: catsRes.rows.map(categoryOut),
    actuals,
    summary: {
      income,
      total_income_actual: actuals.total_income,
      total_spent: actuals.total_spent,
      total_fixed_planned: actuals.total_fixed_planned,
      total_fixed_spent: actuals.total_fixed_spent,
      total_variable_budgeted: totalVariableBudgeted,
      total_variable_spent:
        actuals.total_spent - actuals.total_fixed_spent - actuals.uncategorized_spent,
      uncategorized_spent: actuals.uncategorized_spent,
      transfers_excluded: actuals.transfers_excluded,
      savings_target: savingsTarget,
      projected_savings: projectedSavings,
      remaining_to_budget: remainingToBudget,
      // Kept for backward compat
      total_budgeted: totalVariableBudgeted,
    },
  });
});

/**
 * PATCH /api/budgets/:id — update income + savings target on the budget row.
 */
const patchBudgetSchema = z.object({
  monthly_income: z.number().nonnegative().optional(),
  savings_target: z.number().nonnegative().optional(),
});
budgetsRouter.patch('/:id', async (req, res) => {
  const parsed = patchBudgetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const updates = parsed.data;
  const set: string[] = [];
  const params: unknown[] = [];
  if (updates.monthly_income != null) {
    params.push(updates.monthly_income);
    set.push(`monthly_income = $${params.length}`);
  }
  if (updates.savings_target != null) {
    params.push(updates.savings_target);
    set.push(`savings_target = $${params.length}`);
  }
  if (set.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }
  set.push('updated_at = now()');
  params.push(req.params.id, userId);
  const result = await query<BudgetRow>(
    `UPDATE budgets SET ${set.join(', ')}
     WHERE id = $${params.length - 1} AND user_id = $${params.length}
     RETURNING *`,
    params,
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json({ budget: budgetOut(result.rows[0]!) });
});

/**
 * POST /api/budgets/:id/categories — add a category. sort_order defaults to
 * (max + 1) so new categories append at the bottom.
 */
const createCategorySchema = z.object({
  name: z.string().min(1).max(80),
  monthly_limit: z.number().nonnegative(),
  match_patterns: z.array(z.string().min(1).max(120)).max(20).optional().default([]),
});
budgetsRouter.post('/:id/categories', async (req, res) => {
  const parsed = createCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const budgetId = req.params.id;

  const row = await withTransaction(async (client) => {
    // Ownership check + next sort_order in one transaction.
    const owned = await client.query<{ id: string }>(
      `SELECT id FROM budgets WHERE id = $1 AND user_id = $2`,
      [budgetId, userId],
    );
    if (owned.rows.length === 0) return null;
    const max = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
       FROM budget_categories WHERE budget_id = $1`,
      [budgetId],
    );
    const nextOrder = max.rows[0]!.next;
    const inserted = await client.query<BudgetCategoryRow>(
      `INSERT INTO budget_categories (budget_id, name, monthly_limit, match_patterns, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        budgetId,
        parsed.data.name,
        parsed.data.monthly_limit,
        parsed.data.match_patterns,
        nextOrder,
      ],
    );
    return inserted.rows[0]!;
  });
  if (!row) {
    res.status(404).json({ error: 'Budget not found' });
    return;
  }
  res.status(201).json({ category: categoryOut(row) });
});

/**
 * PATCH /api/budgets/:budgetId/categories/:categoryId — update a category.
 */
const patchCategorySchema = z.object({
  name: z.string().min(1).max(80).optional(),
  monthly_limit: z.number().nonnegative().optional(),
  match_patterns: z.array(z.string().min(1).max(120)).max(20).optional(),
});
budgetsRouter.patch('/:budgetId/categories/:categoryId', async (req, res) => {
  const parsed = patchCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const updates = parsed.data;
  const set: string[] = [];
  const params: unknown[] = [];
  if (updates.name != null) {
    params.push(updates.name);
    set.push(`name = $${params.length}`);
  }
  if (updates.monthly_limit != null) {
    params.push(updates.monthly_limit);
    set.push(`monthly_limit = $${params.length}`);
  }
  if (updates.match_patterns != null) {
    params.push(updates.match_patterns);
    set.push(`match_patterns = $${params.length}`);
  }
  if (set.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }
  set.push('updated_at = now()');
  params.push(req.params.categoryId, req.params.budgetId, userId);
  const result = await query<BudgetCategoryRow>(
    `UPDATE budget_categories SET ${set.join(', ')}
     WHERE id = $${params.length - 2}
       AND budget_id = $${params.length - 1}
       AND budget_id IN (SELECT id FROM budgets WHERE user_id = $${params.length})
     RETURNING *`,
    params,
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json({ category: categoryOut(result.rows[0]!) });
});

/**
 * DELETE /api/budgets/:budgetId/categories/:categoryId — remove a category.
 */
budgetsRouter.delete('/:budgetId/categories/:categoryId', async (req, res) => {
  const userId = req.user!.id;
  const result = await query(
    `DELETE FROM budget_categories
     WHERE id = $1
       AND budget_id = $2
       AND budget_id IN (SELECT id FROM budgets WHERE user_id = $3)`,
    [req.params.categoryId, req.params.budgetId, userId],
  );
  res.json({ ok: true, deleted: result.rowCount ?? 0 });
});
