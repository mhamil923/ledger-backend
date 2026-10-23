import { Router } from 'express';
import { query } from '../db.js';
import { isAnthropicConfigured } from '../services/anthropic.js';
import { isFinnhubConfigured } from '../services/finnhub.js';
import { isTwelveDataConfigured } from '../services/twelvedata.js';
import { isAlpacaConfigured } from '../services/alpaca.js';
import { isCoinbaseTradeConfigured } from '../services/coinbase-trade.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({ ok: true, service: 'ledger-backend' });
});

healthRouter.get('/ready', async (_req, res) => {
  let db = false;
  try {
    await query('SELECT 1');
    db = true;
  } catch {
    db = false;
  }
  const ready = db;
  res.status(ready ? 200 : 503).json({
    ready,
    checks: {
      database: db,
      anthropic: isAnthropicConfigured(),
      finnhub: isFinnhubConfigured(),
      twelvedata: isTwelveDataConfigured(),
      alpaca_paper: isAlpacaConfigured('paper'),
      alpaca_live: isAlpacaConfigured('live'),
      coinbase_trade: isCoinbaseTradeConfigured(),
    },
  });
});
