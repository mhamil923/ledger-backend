import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../auth/middleware.js';

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
