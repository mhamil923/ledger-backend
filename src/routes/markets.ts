import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { getMarketCalendar } from '../services/market-calendar.js';
import { getMarketNews } from '../services/market-news.js';
import { generateBrief, latestBrief } from '../services/market-brief.js';
import { getCryptoFearGreed } from '../services/sentiment.js';
import { isAnthropicConfigured } from '../services/anthropic.js';

export const marketsRouter = Router();
marketsRouter.use(requireAuth);

type H = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: H) => (req: Request, res: Response, next: NextFunction): void => {
  fn(req, res).catch(next);
};

marketsRouter.get('/calendar', wrap(async (req, res) => {
  const days = Math.max(1, Math.min(120, Number(req.query.days) || 30));
  const events = await getMarketCalendar(req.user!.id, days, 1);
  res.json({ events, generated_at: new Date().toISOString() });
}));

marketsRouter.get('/news', wrap(async (req, res) => {
  const items = await getMarketNews(req.user!.id, 80);
  res.json({ items });
}));

marketsRouter.get('/sentiment', wrap(async (_req, res) => {
  const fg = await getCryptoFearGreed();
  res.json({ fear_greed: fg ? { value: fg.fear_greed_index, label: fg.fear_greed_label } : null });
}));

marketsRouter.get('/brief', wrap(async (req, res) => {
  res.json({ brief: await latestBrief(req.user!.id) });
}));

// One brief at a time per user — a second tap while one is running waits for it.
const running = new Map<string, ReturnType<typeof generateBrief>>();

marketsRouter.post('/brief', wrap(async (req, res) => {
  if (!isAnthropicConfigured()) {
    res.status(503).json({ error: 'AI brief unavailable — ANTHROPIC_API_KEY not configured.' });
    return;
  }
  const { model_tier } = z.object({ model_tier: z.enum(['fast', 'deep']).default('fast') }).parse(req.body ?? {});
  const uid = req.user!.id;
  try {
    let p = running.get(uid);
    if (!p) {
      p = generateBrief(uid, model_tier).finally(() => running.delete(uid));
      running.set(uid, p);
    }
    res.json({ brief: await p });
  } catch (err) {
    res.status(502).json({ error: 'Brief failed', detail: err instanceof Error ? err.message : String(err) });
  }
}));
