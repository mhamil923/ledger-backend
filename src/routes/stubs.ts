// Layer 2-6 routes — auth-gated stubs that return empty data so the app's tabs render
// without errors. Each route will be replaced as its layer comes online.
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';

const stubLayer = (layer: number, area: string): unknown => ({
  layer,
  area,
  status: 'stub',
  message: `Layer ${layer} (${area}) not yet implemented — schema exists, routes pending.`,
});

export const spendingRouter = Router();
spendingRouter.use(requireAuth);
spendingRouter.get('/', (_req, res) => {
  res.json({ ...(stubLayer(4, 'spending') as object), transactions: [], by_category: {} });
});

