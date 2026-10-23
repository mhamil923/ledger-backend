// Categorization rules (Actual Budget-style). Rules run on every sync; see
// services/transaction-engine.ts for ordering.
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { processTransactions, ruleMatches, type RuleRow } from '../services/transaction-engine.js';

export const rulesRouter = Router();
rulesRouter.use(requireAuth);

const ruleSchema = z
  .object({
    stage: z.enum(['pre', 'default', 'post']).optional().default('default'),
    field: z.enum(['any', 'payee', 'description']).optional().default('any'),
    op: z.enum(['contains', 'is', 'starts_with', 'pattern']).optional().default('contains'),
    value: z.string().trim().min(1).max(200),
    amount_min: z.number().nonnegative().nullable().optional(),
    amount_max: z.number().nonnegative().nullable().optional(),
    account_id: z.string().uuid().nullable().optional(),
    category_id: z.string().uuid().nullable().optional(),
    set_transfer: z.boolean().nullable().optional(),
  })
  .refine((r) => r.category_id || r.set_transfer != null, 'A rule needs a category or a transfer action');

rulesRouter.get('/', async (req, res) => {
  const userId = req.user!.id;
  const rules = await pool.query(
    `SELECT r.*, c.name AS category_name,
            (SELECT COUNT(*)::int FROM transactions t
             WHERE t.user_id = r.user_id AND t.category_id = r.category_id AND t.category_source = 'rule') AS hits
     FROM category_rules r LEFT JOIN categories c ON c.id = r.category_id
     WHERE r.user_id = $1
     ORDER BY CASE r.stage WHEN 'pre' THEN 0 WHEN 'default' THEN 1 ELSE 2 END, r.created_at`,
    [userId],
  );
  res.json({ rules: rules.rows });
});

/** POST /api/rules/preview — which recent transactions would this rule hit? */
rulesRouter.post('/preview', async (req, res) => {
  const parsed = ruleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid rule', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const rule = { ...parsed.data, id: 'preview', source: 'manual' } as unknown as RuleRow;
  rule.amount_min = parsed.data.amount_min != null ? String(parsed.data.amount_min) : null;
  rule.amount_max = parsed.data.amount_max != null ? String(parsed.data.amount_max) : null;
  const txns = await pool.query<{ id: string; account_id: string; amount: string; description: string; merchant: string | null; posted_at: Date }>(
    `SELECT id, account_id, amount::text, description, merchant, posted_at FROM transactions
     WHERE user_id = $1 ORDER BY posted_at DESC LIMIT 2000`,
    [userId],
  );
  const hits = txns.rows.filter((t) => ruleMatches(rule, { ...t, amount: Number(t.amount) }));
  res.json({ count: hits.length, sample: hits.slice(0, 20).map((t) => ({ ...t, amount: Number(t.amount) })) });
});

rulesRouter.post('/', async (req, res) => {
  const parsed = ruleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid rule', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const d = parsed.data;
  if (d.category_id) {
    const own = await pool.query(`SELECT 1 FROM categories WHERE id = $1 AND user_id = $2`, [d.category_id, userId]);
    if (own.rows.length === 0) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
  }
  const ins = await pool.query(
    `INSERT INTO category_rules (user_id, stage, field, op, value, amount_min, amount_max, account_id, category_id, set_transfer, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual') RETURNING *`,
    [userId, d.stage, d.field, d.op, d.value, d.amount_min ?? null, d.amount_max ?? null, d.account_id ?? null, d.category_id ?? null, d.set_transfer ?? null],
  );
  const processed = await processTransactions(userId, { ai: false });
  res.status(201).json({ rule: ins.rows[0], processed });
});

rulesRouter.patch('/:id', async (req, res) => {
  const parsed = ruleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid rule', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const d = parsed.data;
  const upd = await pool.query(
    `UPDATE category_rules SET stage=$3, field=$4, op=$5, value=$6, amount_min=$7, amount_max=$8,
            account_id=$9, category_id=$10, set_transfer=$11
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [req.params.id, userId, d.stage, d.field, d.op, d.value, d.amount_min ?? null, d.amount_max ?? null, d.account_id ?? null, d.category_id ?? null, d.set_transfer ?? null],
  );
  if (upd.rows.length === 0) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  const processed = await processTransactions(userId, { ai: false });
  res.json({ rule: upd.rows[0], processed });
});

rulesRouter.delete('/:id', async (req, res) => {
  const userId = req.user!.id;
  await pool.query(`DELETE FROM category_rules WHERE id = $1 AND user_id = $2`, [req.params.id, userId]);
  const processed = await processTransactions(userId, { ai: false });
  res.json({ ok: true, processed });
});

/** POST /api/rules/run — re-run transfers, rules and AI over all history. */
rulesRouter.post('/run', async (req, res) => {
  const processed = await processTransactions(req.user!.id, { ai: true });
  res.json({ processed });
});

