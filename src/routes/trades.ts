import { query } from '../db.js';
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
  // Honest scorecard: quant-grounded ideas (setup_id set) vs the older
  // eyeballed ones, and what the backtests predicted vs what actually happened.
  const score = await query<{ kind: string; n: string; wins: string; predicted: string | null; avg_pnl: string | null }>(
    `SELECT CASE WHEN setup_id IS NOT NULL AND setup_id <> 'none' THEN 'measured' ELSE 'legacy' END AS kind,
            COUNT(*)::text AS n,
            COUNT(*) FILTER (WHERE resolution LIKE 'target%')::text AS wins,
            AVG(bt_win_rate)::text AS predicted,
            AVG(realized_pnl_pct)::text AS avg_pnl
     FROM trade_ideas
     WHERE user_id = $1 AND status = 'closed'
     GROUP BY 1`,
    [userId],
  );
  const scorecard: Record<string, { closed: number; wins: number; win_rate: number; predicted_win_rate: number | null; avg_pnl_pct: number | null }> = {};
  for (const r of score.rows) {
    const n = Number(r.n);
    scorecard[r.kind] = {
      closed: n,
      wins: Number(r.wins),
      win_rate: n ? Number(r.wins) / n : 0,
      predicted_win_rate: r.predicted != null ? Number(r.predicted) : null,
      avg_pnl_pct: r.avg_pnl != null ? Number(r.avg_pnl) : null,
    };
  }
  res.json({ ...tr, scorecard });
});
