import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import cors from 'cors';
import { config } from './config.js';
import { authRouter } from './routes/auth.js';
import { watchlistRouter } from './routes/watchlist.js';
import { analysisRouter } from './routes/analysis.js';
import { healthRouter } from './routes/health.js';
import { portfolioRouter } from './routes/portfolio.js';
import { walletsRouter } from './routes/wallets.js';
import { searchRouter } from './routes/search.js';
import { chartRouter } from './routes/chart.js';
import { billsRouter } from './routes/bills.js';
import { budgetsRouter } from './routes/budgets.js';
import { tradesRouter } from './routes/trades.js';
import { executeRouter } from './routes/execute.js';
import { spendingRouter } from './routes/stubs.js';
import { bankingRouter } from './routes/banking.js';
import { categoriesRouter } from './routes/categories.js';
import { rulesRouter } from './routes/rules.js';
import { transactionsRouter } from './routes/transactions.js';
import { overviewRouter } from './routes/overview.js';

export function createApp(): express.Express {
  const app = express();

  const origins = config.CORS_ORIGIN === '*' ? '*' : config.CORS_ORIGIN.split(',').map((s) => s.trim());
  app.use(
    cors({
      origin: origins,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.use('/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/watchlist', watchlistRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/chart', chartRouter);
  app.use('/api/analysis', analysisRouter);
  app.use('/api/trades', tradesRouter);
  app.use('/api/portfolio', portfolioRouter);
  app.use('/api/wallets', walletsRouter);
  app.use('/api/banking', bankingRouter);
  app.use('/api/spending', spendingRouter);
  app.use('/api/bills', billsRouter);
  app.use('/api/budgets', budgetsRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/rules', rulesRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/overview', overviewRouter);
  app.use('/api/execute', executeRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(errorHandler);

  return app;
}
