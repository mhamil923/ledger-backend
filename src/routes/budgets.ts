// Envelope budget API (Actual Budget model). See services/envelope.ts for the
// math. Categories live in routes/categories.ts; this file handles the
// per-month numbers.
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import {
  autofillMonth,
  billMonthlyEquivalent,
  computeEnvelope,
  copyMonth,
  currentMonth,
  ensureDefaultCategories,
  getSettings,
  shiftMonth,
} from '../services/envelope.js';
import { processTransactions } from '../services/transaction-engine.js';

export const budgetsRouter = Router();
budgetsRouter.use(requireAuth);

const monthSchema = z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM');

/**
 * Run the transaction engine over the whole history once, the first time the
 * new budget is opened, so existing transactions get categories and transfer
 * pairs. Later syncs process incrementally.
 */
async function ensureProcessed(userId: string): Promise<void> {
  const settings = await getSettings(userId);
  if (settings.processed_at) return;
  await processTransactions(userId);
  await pool.query(`UPDATE budget_settings SET processed_at = now() WHERE user_id = $1`, [userId]);
}

/** GET /api/budgets?month=YYYY-MM — the envelope budget for a month. */
budgetsRouter.get('/', async (req, res) => {
  const parsed = z.object({ month: monthSchema.optional() }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const month = parsed.data.month ?? currentMonth();
  await ensureDefaultCategories(userId);
  await ensureProcessed(userId);
  const settings = await getSettings(userId);
  const autofilled = await autofillMonth(userId, month, settings.start_month);
  const envelope = await computeEnvelope(userId, month);
  res.json({ ...envelope, autofilled, current_month: currentMonth() });
});

/** GET/PATCH /api/budgets/settings — budget start month and starting cash. */
budgetsRouter.get('/settings', async (req, res) => {
  res.json({ settings: await getSettings(req.user!.id) });
});

budgetsRouter.patch('/settings', async (req, res) => {
  const parsed = z
    .object({ start_month: monthSchema.optional(), starting_funds: z.number().optional() })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  await getSettings(userId);
  await pool.query(
    `UPDATE budget_settings SET
       start_month = COALESCE($2, start_month),
       starting_funds = COALESCE($3, starting_funds),
       updated_at = now()
     WHERE user_id = $1`,
    [userId, parsed.data.start_month ?? null, parsed.data.starting_funds ?? null],
  );
  res.json({ settings: await getSettings(userId) });
});

async function ownsCategory(userId: string, categoryId: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM categories WHERE id = $1 AND user_id = $2 AND is_income = false`, [
    categoryId,
    userId,
  ]);
  return r.rows.length > 0;
}

/** PUT /api/budgets/:month/categories/:categoryId — set the budgeted amount. */
budgetsRouter.put('/:month/categories/:categoryId', async (req, res) => {
  const m = monthSchema.safeParse(req.params.month);
  const body = z.object({ budgeted: z.number().finite() }).safeParse(req.body);
  if (!m.success || !body.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  const userId = req.user!.id;
  if (!(await ownsCategory(userId, req.params.categoryId))) {
    res.status(404).json({ error: 'Category not found' });
    return;
  }
  await pool.query(
    `INSERT INTO category_budgets (category_id, month, budgeted) VALUES ($1, $2, $3)
     ON CONFLICT (category_id, month) DO UPDATE SET budgeted = EXCLUDED.budgeted, updated_at = now()`,
    [req.params.categoryId, m.data, Math.round(body.data.budgeted * 100) / 100],
  );
  res.json(await computeEnvelope(userId, m.data));
});

/**
 * POST /api/budgets/:month/move — move money between categories, or between a
 * category and To Budget (from/to = null means To Budget). Same as Actual's
 * "Transfer to another category".
 */
budgetsRouter.post('/:month/move', async (req, res) => {
  const m = monthSchema.safeParse(req.params.month);
  const body = z
    .object({
      from_category_id: z.string().uuid().nullable(),
      to_category_id: z.string().uuid().nullable(),
      amount: z.number().positive(),
    })
    .refine((b) => b.from_category_id !== b.to_category_id, 'from and to must differ')
    .safeParse(req.body);
  if (!m.success || !body.success) {
    res.status(400).json({ error: 'Invalid request', issues: body.success ? undefined : body.error.issues });
    return;
  }
  const userId = req.user!.id;
  const { from_category_id, to_category_id } = body.data;
  const amount = Math.round(body.data.amount * 100) / 100;
  for (const id of [from_category_id, to_category_id]) {
    if (id && !(await ownsCategory(userId, id))) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
  }
  await withTransaction(async (client) => {
    const bump = async (categoryId: string, delta: number): Promise<void> => {
      await client.query(
        `INSERT INTO category_budgets (category_id, month, budgeted) VALUES ($1, $2, $3)
         ON CONFLICT (category_id, month)
         DO UPDATE SET budgeted = category_budgets.budgeted + EXCLUDED.budgeted, updated_at = now()`,
        [categoryId, m.data, delta],
      );
    };
    if (from_category_id) await bump(from_category_id, -amount);
    if (to_category_id) await bump(to_category_id, amount);
  });
  res.json(await computeEnvelope(userId, m.data));
});

/** POST /api/budgets/:month/copy-last-month — fill this month from last month. */
budgetsRouter.post('/:month/copy-last-month', async (req, res) => {
  const m = monthSchema.safeParse(req.params.month);
  const body = z.object({ overwrite: z.boolean().optional().default(false) }).safeParse(req.body ?? {});
  if (!m.success || !body.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  const userId = req.user!.id;
  const copied = await copyMonth(userId, shiftMonth(m.data, -1), m.data, body.data.overwrite);
  res.json({ copied, ...(await computeEnvelope(userId, m.data)) });
});

/**
 * POST /api/budgets/:month/fund-bills — set every bill category's budget to
 * its monthly equivalent (annual bills get 1/12 a month, so the money has
 * built up by the time the charge hits).
 */
budgetsRouter.post('/:month/fund-bills', async (req, res) => {
  const m = monthSchema.safeParse(req.params.month);
  if (!m.success) {
    res.status(400).json({ error: 'Invalid month' });
    return;
  }
  const userId = req.user!.id;
  const bills = await pool.query<{ category_id: string; amount: string; cadence: string }>(
    `SELECT category_id, amount::text, cadence FROM bills
     WHERE user_id = $1 AND active = true AND category_id IS NOT NULL`,
    [userId],
  );
  // Several bills can share one category, so sum per category first.
  const perCategory = new Map<string, number>();
  for (const b of bills.rows) {
    perCategory.set(
      b.category_id,
      (perCategory.get(b.category_id) ?? 0) + billMonthlyEquivalent(Number(b.amount), b.cadence),
    );
  }
  for (const [categoryId, amount] of perCategory) {
    await pool.query(
      `INSERT INTO category_budgets (category_id, month, budgeted) VALUES ($1, $2, $3)
       ON CONFLICT (category_id, month) DO UPDATE SET budgeted = EXCLUDED.budgeted, updated_at = now()`,
      [categoryId, m.data, Math.round(amount * 100) / 100],
    );
  }
  res.json({ funded: bills.rows.length, ...(await computeEnvelope(userId, m.data)) });
});
