import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import {
  getAlpacaAccount,
  isAlpacaConfigured,
  placeAlpacaBracketOrder,
  type AlpacaEnv,
} from '../services/alpaca.js';
import {
  isCoinbaseTradeConfigured,
  listCoinbaseAccounts,
  listCoinbasePortfolios,
  placeCoinbaseOrder,
} from '../services/coinbase-trade.js';
import { getCoinbaseSpotPrice } from '../services/coinbase.js';

export const executeRouter = Router();
executeRouter.use(requireAuth);

export type ExchangeAccount =
  | {
      provider: 'alpaca';
      env: 'paper' | 'live';
      label: string;
      configured: boolean;
      equity?: number;
      buying_power?: number;
      cash?: number;
      currency?: string;
      account_blocked?: boolean;
    }
  | {
      provider: 'coinbase';
      label: string;
      configured: boolean;
      /** USD cash buying power (used by the trade modal). */
      usd_balance?: number;
      /** Per-currency holdings, sorted by USD value descending. */
      balances?: Array<{
        currency: string;
        amount: number;
        usd_value: number | null;
      }>;
      /** Sum of usd_value across all balances. */
      total_usd_value?: number;
    };

/**
 * Lists all configured exchange accounts with current balances so the app can
 * show "from which account" pickers + buying-power figures in the trade modal.
 */
export async function loadExchangeAccounts(): Promise<ExchangeAccount[]> {
  const result: ExchangeAccount[] = [];

  for (const env of ['paper', 'live'] as const) {
    const configured = isAlpacaConfigured(env);
    const account: ExchangeAccount = {
      provider: 'alpaca',
      env,
      label: env === 'paper' ? 'Alpaca · Paper' : 'Alpaca · Live',
      configured,
    };
    if (configured) {
      try {
        const a = await getAlpacaAccount(env);
        account.equity = Number(a.equity);
        account.buying_power = Number(a.buying_power);
        account.cash = Number(a.cash);
        account.currency = a.currency;
        account.account_blocked = a.account_blocked || a.trading_blocked;
      } catch (err) {
        console.warn(`Alpaca ${env} account fetch failed:`, err);
      }
    }
    result.push(account);
  }

  const coinbaseConfigured = isCoinbaseTradeConfigured();
  const coinbase: ExchangeAccount = {
    provider: 'coinbase',
    label: 'Coinbase · Live',
    configured: coinbaseConfigured,
  };
  if (coinbaseConfigured) {
    try {
      const accounts = await listCoinbaseAccounts();
      const usdAcct = accounts.find((a) => a.currency === 'USD');
      if (usdAcct) coinbase.usd_balance = Number(usdAcct.available_balance.value);

      // Build the per-currency balance list with USD valuation. Skip dust
      // (anything that totals less than $0.01 once priced) so the UI isn't
      // littered with tracking-token rounding noise.
      const interesting = accounts
        .map((a) => ({
          currency: a.currency,
          amount: Number(a.available_balance.value) + Number(a.hold?.value ?? 0),
        }))
        .filter((b) => Number.isFinite(b.amount) && b.amount > 0);

      const priced = await Promise.all(
        interesting.map(async (b) => {
          const price = await getCoinbaseSpotPrice(b.currency);
          const usd_value = price == null ? null : b.amount * price;
          return { currency: b.currency, amount: b.amount, usd_value };
        }),
      );

      const visible = priced.filter((b) => b.usd_value == null || b.usd_value >= 0.01);
      visible.sort((a, b) => (b.usd_value ?? 0) - (a.usd_value ?? 0));
      coinbase.balances = visible;
      coinbase.total_usd_value = visible.reduce((sum, b) => sum + (b.usd_value ?? 0), 0);
    } catch (err) {
      console.warn('Coinbase accounts fetch failed:', err);
    }
  }
  result.push(coinbase);
  return result;
}

executeRouter.get('/accounts', async (_req, res) => {
  res.json({ accounts: await loadExchangeAccounts() });
});

/**
 * Debug helper — returns a summary of what Coinbase is actually exposing to
 * this API key (portfolios, account count, non-zero balances). Hit this when
 * the Accounts page Coinbase card shows $0 to figure out whether the issue
 * is portfolio scoping, permissions, or empty balances.
 */
executeRouter.get('/coinbase/debug', async (_req, res) => {
  if (!isCoinbaseTradeConfigured()) {
    res.status(503).json({ error: 'Coinbase trading credentials not configured' });
    return;
  }
  const out: Record<string, unknown> = {};
  try {
    const portfolios = await listCoinbasePortfolios();
    out.portfolios = portfolios.map((p) => ({ uuid: p.uuid, name: p.name, type: p.type }));
  } catch (err) {
    out.portfolios_error = err instanceof Error ? err.message : String(err);
  }
  try {
    const accounts = await listCoinbaseAccounts();
    out.account_count = accounts.length;
    const nonZero = accounts.filter((a) => {
      const total = Number(a.available_balance.value) + Number(a.hold?.value ?? 0);
      return Number.isFinite(total) && total > 0;
    });
    out.non_zero_count = nonZero.length;
    out.non_zero_balances = nonZero.slice(0, 30).map((a) => ({
      currency: a.currency,
      available: a.available_balance.value,
      hold: a.hold?.value,
      account_type: a.type,
      ready: a.ready,
    }));
  } catch (err) {
    out.accounts_error = err instanceof Error ? err.message : String(err);
  }
  res.json(out);
});

// ---- Order placement ----

const alpacaOrderSchema = z.object({
  provider: z.literal('alpaca'),
  env: z.enum(['paper', 'live']),
  symbol: z.string().min(1).max(10),
  side: z.enum(['buy', 'sell']),
  qty: z.coerce.number().positive(),
  limit_price: z.coerce.number().positive(),
  stop_loss: z.coerce.number().positive(),
  take_profit: z.coerce.number().positive(),
  time_in_force: z.enum(['day', 'gtc']).optional().default('gtc'),
});

const coinbaseOrderSchema = z.object({
  provider: z.literal('coinbase'),
  product_id: z.string().min(3).max(20), // e.g. BTC-USD
  side: z.enum(['BUY', 'SELL']),
  /** base_size = crypto amount (BTC), quote_size = USD amount. One of the two required. */
  base_size: z.coerce.number().positive().optional(),
  quote_size: z.coerce.number().positive().optional(),
  limit_price: z.coerce.number().positive().optional(),
  stop_price: z.coerce.number().positive().optional(),
});

const orderSchema = z.discriminatedUnion('provider', [alpacaOrderSchema, coinbaseOrderSchema]);

executeRouter.post('/order', async (req, res) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
    return;
  }

  if (parsed.data.provider === 'alpaca') {
    const o = parsed.data;
    try {
      const order = await placeAlpacaBracketOrder(o.env as AlpacaEnv, {
        symbol: o.symbol,
        side: o.side,
        qty: o.qty,
        limit_price: o.limit_price,
        stop_loss: o.stop_loss,
        take_profit: o.take_profit,
        time_in_force: o.time_in_force,
        client_order_id: `ledger-${randomUUID()}`,
      });
      res.status(201).json({ provider: 'alpaca', order });
    } catch (err) {
      res.status(502).json({
        error: 'Alpaca order failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Coinbase
  const o = parsed.data;
  if (!o.base_size && !o.quote_size) {
    res.status(400).json({ error: 'base_size or quote_size is required for Coinbase orders' });
    return;
  }
  try {
    const result = await placeCoinbaseOrder({
      product_id: o.product_id,
      side: o.side,
      base_size: o.base_size != null ? String(o.base_size) : undefined,
      quote_size: o.quote_size != null ? String(o.quote_size) : undefined,
      limit_price: o.limit_price != null ? String(o.limit_price) : undefined,
      stop_price: o.stop_price != null ? String(o.stop_price) : undefined,
      client_order_id: `ledger-${randomUUID()}`,
    });
    if (!result.success) {
      res.status(502).json({
        error: 'Coinbase rejected the order',
        detail: result.error_response?.message ?? result.failure_reason ?? 'unknown',
      });
      return;
    }
    res.status(201).json({ provider: 'coinbase', order: result });
  } catch (err) {
    res.status(502).json({
      error: 'Coinbase order failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});
