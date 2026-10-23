import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { getHoldingWithLots, listHoldingsForUser } from '../services/portfolio.js';

export const portfolioRouter = Router();
portfolioRouter.use(requireAuth);

portfolioRouter.get('/', async (req, res) => {
  const userId = req.user!.id;
  const { holdings, totals } = await listHoldingsForUser(userId);
  res.json({ holdings, totals });
});

const createHoldingSchema = z.object({
  symbol: z.string().min(1).max(20).transform((s) => s.toUpperCase()),
  asset_type: z.enum(['stock', 'crypto', 'etf']),
  notes: z.string().max(2000).optional(),
  external_id: z.string().max(120).optional(),
  initial_lot: z
    .object({
      quantity: z.coerce.number().positive(),
      cost_per_unit: z.coerce.number().nonnegative(),
      acquired_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
      notes: z.string().max(500).optional(),
    })
    .optional(),
});

portfolioRouter.post('/', async (req, res) => {
  const parsed = createHoldingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const input = parsed.data;

  try {
    const holdingId = await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO holdings (user_id, symbol, asset_type, notes, external_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, symbol, asset_type)
         DO UPDATE SET notes = COALESCE(EXCLUDED.notes, holdings.notes),
                       external_id = COALESCE(EXCLUDED.external_id, holdings.external_id),
                       updated_at = now()
         RETURNING id`,
        [userId, input.symbol, input.asset_type, input.notes ?? null, input.external_id ?? null],
      );
      const id = inserted.rows[0]!.id;
      if (input.initial_lot) {
        await client.query(
          `INSERT INTO holding_lots (holding_id, quantity, cost_per_unit, acquired_at, notes)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            id,
            input.initial_lot.quantity,
            input.initial_lot.cost_per_unit,
            input.initial_lot.acquired_at,
            input.initial_lot.notes ?? null,
          ],
        );
      }
      return id;
    });

    const detail = await getHoldingWithLots(userId, holdingId);
    res.status(201).json(detail);
  } catch (err) {
    throw err;
  }
});

portfolioRouter.get('/:id', async (req, res) => {
  const userId = req.user!.id;
  const detail = await getHoldingWithLots(userId, req.params.id!);
  if (!detail) {
    res.status(404).json({ error: 'Holding not found' });
    return;
  }
  res.json(detail);
});

const lotSchema = z.object({
  quantity: z.coerce.number().positive(),
  cost_per_unit: z.coerce.number().nonnegative(),
  acquired_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  notes: z.string().max(500).optional(),
});

portfolioRouter.post('/:id/lots', async (req, res) => {
  const parsed = lotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const ownerCheck = await query<{ id: string }>(
    'SELECT id FROM holdings WHERE id = $1 AND user_id = $2',
    [req.params.id, userId],
  );
  if (!ownerCheck.rows[0]) {
    res.status(404).json({ error: 'Holding not found' });
    return;
  }
  await query(
    `INSERT INTO holding_lots (holding_id, quantity, cost_per_unit, acquired_at, notes)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      req.params.id,
      parsed.data.quantity,
      parsed.data.cost_per_unit,
      parsed.data.acquired_at,
      parsed.data.notes ?? null,
    ],
  );
  const detail = await getHoldingWithLots(userId, req.params.id!);
  res.status(201).json(detail);
});

portfolioRouter.delete('/lots/:lotId', async (req, res) => {
  const userId = req.user!.id;
  // Verify ownership through the holding
  const result = await query<{ holding_id: string }>(
    `DELETE FROM holding_lots l
     USING holdings h
     WHERE l.id = $1 AND l.holding_id = h.id AND h.user_id = $2
     RETURNING l.holding_id`,
    [req.params.lotId, userId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: 'Lot not found' });
    return;
  }
  res.json({ ok: true });
});

const patchSchema = z.object({ notes: z.string().max(2000).nullable().optional() });

portfolioRouter.patch('/:id', async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }
  const userId = req.user!.id;
  const result = await query(
    'UPDATE holdings SET notes = $1, updated_at = now() WHERE id = $2 AND user_id = $3',
    [parsed.data.notes ?? null, req.params.id, userId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: 'Holding not found' });
    return;
  }
  res.json({ ok: true });
});

portfolioRouter.delete('/:id', async (req, res) => {
  const userId = req.user!.id;
  const result = await query('DELETE FROM holdings WHERE id = $1 AND user_id = $2', [
    req.params.id,
    userId,
  ]);
  if (result.rowCount === 0) {
    res.status(404).json({ error: 'Holding not found' });
    return;
  }
  res.json({ ok: true });
});
