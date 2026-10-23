import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import {
  getTrackRecord,
  listUserTrades,
  resolvePendingTrades,
  type TradeStatus,
} from '../services/trade-journal.js';

export const tradesRouter = Router();
tradesRouter.use(requireAuth);

const querySchema = z.object({
  symbol: z.string().max(20).optional(),
  status: z.enum(['pending', 'active', 'closed', 'expired']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  resolve: z.coerce.boolean().optional(),
});

tradesRouter.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  if (parsed.data.resolve !== false) {
    // Refresh outcomes inline so the list is always up-to-date.
    try {
      await resolvePendingTrades(userId);
    } catch (err) {
      console.warn('resolvePendingTrades failed:', err);
    }
  }
  const trades = await listUserTrades(userId, {
    symbol: parsed.data.symbol,
    status: parsed.data.status as TradeStatus | undefined,
    limit: parsed.data.limit,
  });
  res.json({ trades });
});

tradesRouter.get('/summary', async (req, res) => {
  const userId = req.user!.id;
  try {
    await resolvePendingTrades(userId);
  } catch {
    /* non-fatal */
  }
  const tr = await getTrackRecord(userId, { daysBack: 60, limit: 50 });
  res.json(tr);
});
