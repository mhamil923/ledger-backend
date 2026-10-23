// Transactions with their stored category and transfer state.
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { processTransactions } from '../services/transaction-engine.js';
import { normalizeMerchant } from '../services/transactions-classify.js';

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth);

const listSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  days: z.coerce.number().int().min(1).max(730).optional(),
  category_id: z.string().uuid().optional(),
  account_id: z.string().uuid().optional(),
  uncategorized: z.enum(['1', 'true']).optional(),
  transfers: z.enum(['include', 'exclude', 'only']).optional().default('include'),
  search: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(200),
});

export const TXN_SELECT = `
  t.id, t.account_id, t.posted_at, t.amount::float8 AS amount, t.currency, t.description,
  t.merchant, t.pending, t.category_id, c.name AS category_name, t.category_source,
  t.is_transfer, t.transfer_source, t.transfer_txn_id, t.notes,
  ba.name AS account_name, ba.institution, ba.account_type, ba.on_budget`;

transactionsRouter.get('/', async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const q = parsed.data;
  const where = ['t.user_id = $1'];
  const params: unknown[] = [userId];
  const add = (sql: string, v: unknown): void => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (q.month) {
    params.push('UTC'); // same month rule as the budget (see envelope.ts)
    add(`to_char(t.posted_at AT TIME ZONE $${params.length}, 'YYYY-MM') = ?`, q.month);
  } else if (q.days) {
    add('t.posted_at >= ?', new Date(Date.now() - q.days * 86_400_000));
  }
  if (q.category_id) add('t.category_id = ?', q.category_id);
  if (q.account_id) add('t.account_id = ?', q.account_id);
  if (q.uncategorized) where.push('t.category_id IS NULL AND NOT t.is_transfer AND ba.on_budget');
  if (q.transfers === 'exclude') where.push('NOT t.is_transfer');
  if (q.transfers === 'only') where.push('t.is_transfer');
  if (q.search) {
    params.push(`%${q.search}%`);
    where.push(`(t.description ILIKE $${params.length} OR t.merchant ILIKE $${params.length})`);
  }
  params.push(q.limit);
  const rows = await pool.query(
    `SELECT ${TXN_SELECT}
     FROM transactions t
     JOIN bank_accounts ba ON ba.id = t.account_id
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE ${where.join(' AND ')}
     ORDER BY t.posted_at DESC
     LIMIT $${params.length}`,
    params,
  );
  res.json({ transactions: rows.rows });
});

const patchSchema = z.object({
  category_id: z.string().uuid().nullable().optional(),
  is_transfer: z.boolean().optional(),
  notes: z.string().max(500).nullable().optional(),
  /** Also create a rule so future (and past, non-manual) transactions from
   *  this payee land in the same category — Actual's "learn" behavior. */
  make_rule: z.boolean().optional().default(false),
});

transactionsRouter.patch('/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const d = parsed.data;
  const cur = await pool.query<{ id: string; merchant: string | null; description: string; transfer_txn_id: string | null }>(
    `SELECT id, merchant, description, transfer_txn_id FROM transactions WHERE id = $1 AND user_id = $2`,
    [req.params.id, userId],
  );
  const txn = cur.rows[0];
  if (!txn) {
    res.status(404).json({ error: 'Transaction not found' });
    return;
  }
  if (d.category_id) {
    const own = await pool.query(`SELECT 1 FROM categories WHERE id = $1 AND user_id = $2`, [d.category_id, userId]);
    if (own.rows.length === 0) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
  }

  let ruleCreated: { id: string; value: string } | null = null;
  await withTransaction(async (client) => {
    if (d.is_transfer !== undefined) {
      // Applies to both halves of a paired transfer.
      const ids = [txn.id, ...(txn.transfer_txn_id ? [txn.transfer_txn_id] : [])];
      await client.query(
        `UPDATE transactions SET is_transfer = $2, transfer_source = 'manual',
           transfer_txn_id = CASE WHEN $2 THEN transfer_txn_id ELSE NULL END,
           category_id = CASE WHEN $2 THEN NULL ELSE category_id END,
           category_source = CASE WHEN $2 THEN NULL ELSE category_source END
         WHERE id = ANY($1::uuid[]) AND user_id = $3`,
        [ids, d.is_transfer, userId],
      );
    }
    if (d.category_id && txn.transfer_txn_id) {
      // Giving one half of a transfer pair a category means it isn't a
      // transfer — release the other half too so it counts normally.
      await client.query(
        `UPDATE transactions SET is_transfer = false, transfer_source = 'manual', transfer_txn_id = NULL
         WHERE id = $1 AND user_id = $2`,
        [txn.transfer_txn_id, userId],
      );
    }
    if (d.category_id !== undefined) {
      await client.query(
        `UPDATE transactions SET category_id = $2,
           category_source = CASE WHEN $2::uuid IS NULL THEN NULL ELSE 'manual' END,
           is_transfer = CASE WHEN $2::uuid IS NULL THEN is_transfer ELSE false END,
           transfer_source = CASE WHEN $2::uuid IS NULL THEN transfer_source ELSE 'manual' END,
           transfer_txn_id = CASE WHEN $2::uuid IS NULL THEN transfer_txn_id ELSE NULL END
         WHERE id = $1 AND user_id = $3`,
        [txn.id, d.category_id, userId],
      );
    }
    if (d.notes !== undefined) {
      await client.query(`UPDATE transactions SET notes = $2 WHERE id = $1 AND user_id = $3`, [txn.id, d.notes, userId]);
    }
    if (d.make_rule && d.category_id) {
      const usePayee = !!txn.merchant && txn.merchant.trim().length >= 3;
      const field = usePayee ? 'payee' : 'description';
      const value = usePayee ? txn.merchant!.trim() : normalizeMerchant(txn.description).toLowerCase();
      if (value.length >= 3) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM category_rules
           WHERE user_id = $1 AND field = $2 AND op = 'contains' AND lower(value) = lower($3)
             AND source IN ('learned', 'manual') AND amount_min IS NULL AND amount_max IS NULL AND account_id IS NULL`,
          [userId, field, value],
        );
        if (existing.rows[0]) {
          await client.query(`UPDATE category_rules SET category_id = $2, set_transfer = NULL WHERE id = $1`, [
            existing.rows[0].id,
            d.category_id,
          ]);
          ruleCreated = { id: existing.rows[0].id, value };
        } else {
          const ins = await client.query<{ id: string }>(
            `INSERT INTO category_rules (user_id, field, op, value, category_id, source)
             VALUES ($1, $2, 'contains', $3, $4, 'learned') RETURNING id`,
            [userId, field, value, d.category_id],
          );
          ruleCreated = { id: ins.rows[0]!.id, value };
        }
      }
    }
  });

  const processed = ruleCreated ? await processTransactions(userId, { ai: false }) : null;
  const out = await pool.query(
    `SELECT ${TXN_SELECT} FROM transactions t
     JOIN bank_accounts ba ON ba.id = t.account_id
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.id = $1`,
    [txn.id],
  );
  res.json({ transaction: out.rows[0], rule: ruleCreated, processed });
});

/** POST /api/transactions/reprocess — rerun the engine over all history. */
transactionsRouter.post('/reprocess', async (req, res) => {
  const processed = await processTransactions(req.user!.id, { ai: true });
  res.json({ processed });
});
