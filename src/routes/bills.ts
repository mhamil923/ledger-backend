import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { billMonthlyEquivalent, currentMonth } from '../services/envelope.js';
import { processTransactions } from '../services/transaction-engine.js';

/**
 * Give a bill its own budget category in the "Bills" group, a rule that routes
 * its charges there, and this month's budget = its monthly equivalent.
 */
async function linkBillToCategory(
  client: import('pg').PoolClient,
  userId: string,
  bill: { id: string; name: string; merchant: string | null; amount: number; cadence: string },
): Promise<string> {
  const cat = await client.query<{ id: string }>(
    `INSERT INTO categories (user_id, name, group_name)
     VALUES ($1, $2, 'Bills')
     ON CONFLICT (user_id, (lower(name))) DO UPDATE SET hidden = false
     RETURNING id`,
    [userId, bill.name],
  );
  const categoryId = cat.rows[0]!.id;
  await client.query(`UPDATE bills SET category_id = $1 WHERE id = $2`, [categoryId, bill.id]);
  await syncBillRule(client, userId, categoryId, bill);
  await client.query(
    `INSERT INTO category_budgets (category_id, month, budgeted) VALUES ($1, $2, $3)
     ON CONFLICT (category_id, month) DO NOTHING`,
    [categoryId, currentMonth(), billMonthlyEquivalent(bill.amount, bill.cadence)],
  );
  return categoryId;
}

async function syncBillRule(
  client: import('pg').PoolClient,
  userId: string,
  categoryId: string,
  bill: { name: string; merchant: string | null },
): Promise<void> {
  const value = (bill.merchant && bill.merchant.trim().length > 3 ? bill.merchant : bill.name).trim();
  await client.query(`DELETE FROM category_rules WHERE category_id = $1 AND source = 'bill'`, [categoryId]);
  if (value.length > 3) {
    await client.query(
      `INSERT INTO category_rules (user_id, stage, field, op, value, category_id, source)
       VALUES ($1, 'post', 'any', 'contains', $2, $3, 'bill')`,
      [userId, value, categoryId],
    );
  }
}

export const billsRouter = Router();
billsRouter.use(requireAuth);

type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual' | 'custom';

interface BillRow {
  id: string;
  name: string;
  merchant: string | null;
  amount: string;
  currency: string;
  cadence: Cadence;
  next_due_date: string | null;
  account_id: string | null;
  auto_detected: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

interface BillPaymentRow {
  id: string;
  bill_id: string;
  paid_at: string;
  amount: string;
}

const SELECT_COLS =
  'id, name, merchant, amount::text, currency, cadence, next_due_date::text, account_id, auto_detected, active, created_at::text, updated_at::text';

interface BillWithSummary extends Omit<BillRow, 'amount'> {
  amount: number;
  monthly_equivalent: number;
  last_paid_at: string | null;
  total_paid: number;
  /** Most recent synced charge filed under this bill's category. */
  last_charge_amount: number | null;
  last_charge_date: string | null;
  /** True when that charge differs from the bill amount (rent + utilities,
   *  a price increase, ...) so the app can offer to update the bill. */
  amount_changed: boolean;
}

const MONTHS_PER_YEAR = 12;

function monthlyEquivalent(amount: number, cadence: Cadence): number {
  switch (cadence) {
    case 'weekly':
      return amount * (52 / MONTHS_PER_YEAR);
    case 'biweekly':
      return amount * (26 / MONTHS_PER_YEAR);
    case 'monthly':
      return amount;
    case 'quarterly':
      return amount / 3;
    case 'annual':
      return amount / 12;
    case 'custom':
    default:
      return amount;
  }
}

async function loadBills(userId: string): Promise<BillWithSummary[]> {
  const billsResult = await query<BillRow>(
    `SELECT ${SELECT_COLS} FROM bills WHERE user_id = $1 ORDER BY active DESC, next_due_date ASC NULLS LAST, created_at ASC`,
    [userId],
  );

  if (billsResult.rows.length === 0) return [];

  const paymentsResult = await query<BillPaymentRow & { bill_id: string }>(
    `SELECT id, bill_id, paid_at::text, amount::text FROM bill_payments
     WHERE bill_id = ANY($1::uuid[])
     ORDER BY paid_at DESC`,
    [billsResult.rows.map((b) => b.id)],
  );

  // Latest real charge per bill (via the bill's linked budget category).
  const charges = await query<{ bill_id: string; amount: string; posted_at: string }>(
    `SELECT DISTINCT ON (b.id) b.id AS bill_id, (-t.amount)::text AS amount, t.posted_at::date::text AS posted_at
     FROM bills b
     JOIN transactions t ON t.category_id = b.category_id AND t.user_id = b.user_id
     WHERE b.id = ANY($1::uuid[]) AND t.amount < 0 AND NOT t.pending
     ORDER BY b.id, t.posted_at DESC`,
    [billsResult.rows.map((b) => b.id)],
  );
  const chargeByBill = new Map(charges.rows.map((c) => [c.bill_id, c]));

  const paymentsByBill = new Map<string, BillPaymentRow[]>();
  for (const p of paymentsResult.rows) {
    const arr = paymentsByBill.get(p.bill_id) ?? [];
    arr.push(p);
    paymentsByBill.set(p.bill_id, arr);
  }

  return billsResult.rows.map((b) => {
    const payments = paymentsByBill.get(b.id) ?? [];
    const amount = Number(b.amount);
    return {
      ...b,
      amount,
      monthly_equivalent: monthlyEquivalent(amount, b.cadence),
      last_paid_at: payments[0]?.paid_at ?? null,
      total_paid: payments.reduce((acc, p) => acc + Number(p.amount), 0),
      last_charge_amount: chargeByBill.has(b.id) ? Number(chargeByBill.get(b.id)!.amount) : null,
      last_charge_date: chargeByBill.get(b.id)?.posted_at ?? null,
      amount_changed: chargeByBill.has(b.id)
        ? Math.abs(Number(chargeByBill.get(b.id)!.amount) - amount) > Math.max(1, amount * 0.03)
        : false,
    };
  });
}

billsRouter.get('/', async (req, res) => {
  const userId = req.user!.id;
  const bills = await loadBills(userId);
  const activeBills = bills.filter((b) => b.active);
  const monthlyTotal = activeBills.reduce((acc, b) => acc + b.monthly_equivalent, 0);
  res.json({ bills, monthly_total: monthlyTotal });
});

const cadenceEnum = z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'annual', 'custom']);

const createSchema = z.object({
  name: z.string().min(1).max(200),
  merchant: z.string().max(200).optional(),
  amount: z.coerce.number().nonnegative(),
  currency: z.string().length(3).optional().default('USD'),
  cadence: cadenceEnum,
  next_due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  auto_detected: z.boolean().optional().default(false),
});

billsRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const input = parsed.data;
  const result = await query<BillRow>(
    `INSERT INTO bills (user_id, name, merchant, amount, currency, cadence, next_due_date, auto_detected, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
     RETURNING ${SELECT_COLS}`,
    [
      userId,
      input.name,
      input.merchant ?? null,
      input.amount,
      input.currency,
      input.cadence,
      input.next_due_date ?? null,
      input.auto_detected,
    ],
  );
  const row = result.rows[0]!;
  await withTransaction((client) =>
    linkBillToCategory(client, userId, { ...row, amount: Number(row.amount) }),
  );
  await processTransactions(userId, { ai: false });
  res.status(201).json({
    bill: {
      ...row,
      amount: Number(row.amount),
      monthly_equivalent: monthlyEquivalent(Number(row.amount), row.cadence),
      last_paid_at: null,
      total_paid: 0,
    },
  });
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  merchant: z.string().max(200).nullable().optional(),
  amount: z.coerce.number().nonnegative().optional(),
  cadence: cadenceEnum.optional(),
  next_due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  active: z.boolean().optional(),
});

billsRouter.patch('/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const updates = parsed.data;
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    sets.push(`${k} = $${idx++}`);
    values.push(v);
  }
  if (sets.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }
  sets.push(`updated_at = now()`);
  values.push(req.params.id, userId);
  const result = await query(
    `UPDATE bills SET ${sets.join(', ')} WHERE id = $${idx++} AND user_id = $${idx++}`,
    values,
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: 'Bill not found' });
    return;
  }
  if (updates.name !== undefined || updates.merchant !== undefined || updates.active !== undefined) {
    const b = (
      await query<{ id: string; name: string; merchant: string | null; amount: string; cadence: string; category_id: string | null; active: boolean }>(
        `SELECT id, name, merchant, amount::text, cadence, category_id, active FROM bills WHERE id = $1`,
        [req.params.id],
      )
    ).rows[0]!;
    await withTransaction(async (client) => {
      if (!b.category_id) {
        if (b.active) await linkBillToCategory(client, userId, { ...b, amount: Number(b.amount) });
        return;
      }
      if (b.active) await syncBillRule(client, userId, b.category_id, b);
      else await client.query(`DELETE FROM category_rules WHERE category_id = $1 AND source = 'bill'`, [b.category_id]);
    });
    await processTransactions(userId, { ai: false });
  }
  res.json({ ok: true });
});

const paymentSchema = z.object({
  paid_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.coerce.number().nonnegative().optional(),
  advance_due_date: z.boolean().optional().default(true),
});

function advanceDate(iso: string, cadence: Cadence): string {
  const d = new Date(`${iso}T00:00:00Z`);
  switch (cadence) {
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'biweekly':
      d.setUTCDate(d.getUTCDate() + 14);
      break;
    case 'monthly':
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case 'quarterly':
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case 'annual':
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
    case 'custom':
    default:
      d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return d.toISOString().slice(0, 10);
}

billsRouter.post('/:id/payments', async (req, res) => {
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }
  const userId = req.user!.id;
  const bill = (
    await query<BillRow>(
      `SELECT ${SELECT_COLS} FROM bills WHERE id = $1 AND user_id = $2`,
      [req.params.id, userId],
    )
  ).rows[0];
  if (!bill) {
    res.status(404).json({ error: 'Bill not found' });
    return;
  }
  const amount = parsed.data.amount ?? Number(bill.amount);
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO bill_payments (bill_id, paid_at, amount) VALUES ($1, $2, $3)`,
      [bill.id, parsed.data.paid_at, amount],
    );
    if (parsed.data.advance_due_date) {
      const newDue = advanceDate(bill.next_due_date ?? parsed.data.paid_at, bill.cadence);
      await client.query(
        `UPDATE bills SET next_due_date = $1, updated_at = now() WHERE id = $2`,
        [newDue, bill.id],
      );
    }
  });
  res.json({ ok: true });
});

billsRouter.delete('/:id', async (req, res) => {
  const userId = req.user!.id;
  const result = await query('DELETE FROM bills WHERE id = $1 AND user_id = $2', [
    req.params.id,
    userId,
  ]);
  if (result.rowCount === 0) {
    res.status(404).json({ error: 'Bill not found' });
    return;
  }
  res.json({ ok: true });
});
