import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { searchAssets } from '../services/search.js';

export const searchRouter = Router();
searchRouter.use(requireAuth);

const querySchema = z.object({
  q: z.string().min(1).max(100),
  types: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((t) => t.trim()) : undefined)),
});

searchRouter.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
    return;
  }
  const types = parsed.data.types?.filter((t): t is 'stock' | 'crypto' | 'etf' =>
    ['stock', 'crypto', 'etf'].includes(t),
  );
  try {
    const result = await searchAssets({ query: parsed.data.q, types });
    res.json(result);
  } catch (err) {
    res.status(502).json({
      error: 'Search failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});
