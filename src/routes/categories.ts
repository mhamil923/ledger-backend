// Budget categories. They persist across months (unlike the old per-month
// budget_categories); a category's monthly amount lives in category_budgets.
//
// match_patterns is kept as a convenience: each pattern is stored as a rule
// with source 'category_pattern', so the old "add merchant patterns to a
// category" flow still works on top of the rules engine.
import { Router } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import { pool, withTransaction } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { processTransactions } from '../services/transaction-engine.js';

export const categoriesRouter = Router();
categoriesRouter.use(requireAuth);

const monthSchema = z.string().regex(/^\d{4}-\d{2}$/);

async function setPatterns(client: pg.PoolClient, userId: string, categoryId: string, patterns: string[]): Promise<void> {
  await client.query(`DELETE FROM category_rules WHERE category_id = $1 AND source = 'category_pattern'`, [
    categoryId,
  ]);
  const clean = [...new Set(patterns.map((p) => p.trim()).filter((p) => p.length > 0))];
  for (const p of clean) {
    await client.query(
      `INSERT INTO category_rules (user_id, field, op, value, category_id, source)
       VALUES ($1, 'any', $2, $3, $4, 'category_pattern')`,
      [userId, p.includes('%') ? 'pattern' : 'contains', p, categoryId],
    );
  }
}

categoriesRouter.get('/', async (req, res) => {
  const userId = req.user!.id;
  const cats = await pool.query(
    `SELECT c.id, c.name, c.group_name, c.is_income, c.rollover_overspending, c.hidden, c.sort_order,
            COALESCE(array_agg(r.value ORDER BY r.created_at) FILTER (WHERE r.id IS NOT NULL), '{}') AS match_patterns
     FROM categories c
     LEFT JOIN category_rules r ON r.category_id = c.id AND r.source = 'category_pattern'
     WHERE c.user_id = $1
     GROUP BY c.id
     ORDER BY c.is_income DESC, c.group_name, c.sort_order, c.name`,
    [userId],
  );
  const groups = [...new Set(cats.rows.map((c: { group_name: string }) => c.group_name))];
  res.json({ categories: cats.rows, groups });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  group_name: z.string().trim().min(1).max(60).optional().default('Everyday'),
  is_income: z.boolean().optional().default(false),
  rollover_overspending: z.boolean().optional().default(false),
  match_patterns: z.array(z.string().min(1).max(120)).max(30).optional().default([]),
  budgeted: z.number().finite().optional(),
  month: monthSchema.optional(),
});

categoriesRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const d = parsed.data;
  try {
    const category = await withTransaction(async (client) => {
      const max = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM categories WHERE user_id = $1 AND group_name = $2`,
        [userId, d.group_name],
      );
      const ins = await client.query<{ id: string }>(
        `INSERT INTO categories (user_id, name, group_name, is_income, rollover_overspending, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [userId, d.name, d.group_name, d.is_income, d.rollover_overspending, max.rows[0]!.next],
      );
      const cat = ins.rows[0]!;
      await setPatterns(client, userId, cat.id, d.match_patterns);
      if (d.budgeted != null && d.month && !d.is_income) {
        await client.query(
          `INSERT INTO category_budgets (category_id, month, budgeted) VALUES ($1, $2, $3)
           ON CONFLICT (category_id, month) DO UPDATE SET budgeted = EXCLUDED.budgeted`,
          [cat.id, d.month, d.budgeted],
        );
      }
      return cat;
    });
    const processed = d.match_patterns.length ? await processTransactions(userId, { ai: false }) : null;
    res.status(201).json({ category, processed });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: `A category named "${d.name}" already exists.` });
      return;
    }
    throw err;
  }
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  group_name: z.string().trim().min(1).max(60).optional(),
  rollover_overspending: z.boolean().optional(),
  hidden: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  match_patterns: z.array(z.string().min(1).max(120)).max(30).optional(),
});

categoriesRouter.patch('/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const { match_patterns, ...fields } = parsed.data;
  try {
    const updated = await withTransaction(async (client) => {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        vals.push(v);
        sets.push(`${k} = $${vals.length}`);
      }
      vals.push(req.params.id, userId);
      const r = await client.query(
        `UPDATE categories SET ${[...sets, 'updated_at = now()'].join(', ')}
         WHERE id = $${vals.length - 1} AND user_id = $${vals.length} RETURNING *`,
        vals,
      );
      if (r.rows.length === 0) return null;
      if (match_patterns) await setPatterns(client, userId, req.params.id, match_patterns);
      return r.rows[0];
    });
    if (!updated) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    const processed =
      match_patterns ? await processTransactions(userId, { ai: false }) : null;
    res.json({ category: updated, processed });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'Another category already has that name.' });
      return;
    }
    throw err;
  }
});

/**
 * DELETE /api/categories/:id — its transactions become uncategorized. Pass
 * ?transfer_to=<categoryId> to move them (and its rules) to another category
 * instead, like Actual's delete-and-transfer.
 */
categoriesRouter.delete('/:id', async (req, res) => {
  const userId = req.user!.id;
  const transferTo = typeof req.query.transfer_to === 'string' ? req.query.transfer_to : null;
  const own = await pool.query(`SELECT is_income FROM categories WHERE id = $1 AND user_id = $2`, [
    req.params.id,
    userId,
  ]);
  if (own.rows.length === 0) {
    res.status(404).json({ error: 'Category not found' });
    return;
  }
  await withTransaction(async (client) => {
    if (transferTo) {
      const ok = await client.query(`SELECT 1 FROM categories WHERE id = $1 AND user_id = $2`, [transferTo, userId]);
      if (ok.rows.length) {
        await client.query(`UPDATE transactions SET category_id = $1 WHERE category_id = $2 AND user_id = $3`, [
          transferTo,
          req.params.id,
          userId,
        ]);
        await client.query(`UPDATE category_rules SET category_id = $1 WHERE category_id = $2 AND user_id = $3`, [
          transferTo,
          req.params.id,
          userId,
        ]);
        await client.query(
          `INSERT INTO category_budgets (category_id, month, budgeted)
           SELECT $1, month, budgeted FROM category_budgets WHERE category_id = $2
           ON CONFLICT (category_id, month)
           DO UPDATE SET budgeted = category_budgets.budgeted + EXCLUDED.budgeted`,
          [transferTo, req.params.id],
        );
      }
    }
    await client.query(`DELETE FROM categories WHERE id = $1 AND user_id = $2`, [req.params.id, userId]);
  });
  res.json({ ok: true });
});
