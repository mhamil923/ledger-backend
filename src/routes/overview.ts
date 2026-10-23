// GET /api/overview — one call for the "both worlds" dashboard: budget cash
// on one side, capital in trades on the other.
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { computeEnvelope, currentMonth, ensureDefaultCategories } from '../services/envelope.js';
import { listHoldingsForUser } from '../services/portfolio.js';
import { loadExchangeAccounts } from './execute.js';
import { loadWalletsTotal } from './wallets.js';

export const overviewRouter = Router();
overviewRouter.use(requireAuth);

const round2 = (n: number): number => Math.round(n * 100) / 100;

async function settle<T>(p: Promise<T>, fallback: T): Promise<{ value: T; error: string | null }> {
  try {
    return { value: await p, error: null };
  } catch (err) {
    return { value: fallback, error: err instanceof Error ? err.message : String(err) };
  }
}

overviewRouter.get('/', async (req, res) => {
  const userId = req.user!.id;
  const month = currentMonth();
  await ensureDefaultCategories(userId);

  const [accounts, envelope, holdings, exchanges, wallets] = await Promise.all([
    pool.query<{ account_type: string; on_budget: boolean; current_balance: string | null; name: string; institution: string | null }>(
      `SELECT account_type, on_budget, current_balance::text, name, institution
       FROM bank_accounts WHERE user_id = $1`,
      [userId],
    ),
    computeEnvelope(userId, month),
    settle(listHoldingsForUser(userId), null),
    settle(loadExchangeAccounts(), []),
    settle(loadWalletsTotal(userId), 0),
  ]);

  let cash = 0;
  let cardDebt = 0;
  const offBudget: Array<{ name: string; institution: string | null; type: string; balance: number }> = [];
  for (const a of accounts.rows) {
    const bal = Number(a.current_balance ?? 0);
    if (!a.on_budget) {
      offBudget.push({ name: a.name, institution: a.institution, type: a.account_type, balance: bal });
    } else if (a.account_type === 'credit_card') {
      cardDebt += bal; // negative when you owe
    } else {
      cash += bal;
    }
  }

  const investing = envelope.groups
    .flatMap((g) => g.categories)
    .find((c) => c.name.toLowerCase() === 'investing');

  let alpacaLive = 0;
  let alpacaPaper = 0;
  let coinbase = 0;
  for (const x of exchanges.value) {
    if (x.provider === 'alpaca') {
      if (x.env === 'live') alpacaLive += x.equity ?? 0;
      else alpacaPaper += x.equity ?? 0;
    } else {
      coinbase += x.total_usd_value ?? 0;
    }
  }
  const holdingsValue = holdings.value?.totals.total_value ?? 0;
  const linkedInvestment = offBudget.filter((a) => a.type === 'investment').reduce((s, a) => s + a.balance, 0);
  const loans = offBudget.filter((a) => a.type === 'loan').reduce((s, a) => s + a.balance, 0);
  const capitalInTrades = holdingsValue + alpacaLive + coinbase + wallets.value + linkedInvestment;

  res.json({
    month,
    budget: {
      cash: round2(cash),
      credit_card_debt: round2(cardDebt),
      to_budget: envelope.to_budget,
      available_in_categories: envelope.summary.available_in_categories,
      income_this_month: envelope.summary.income,
      spent_this_month: envelope.summary.spent,
      uncategorized_count: envelope.summary.uncategorized_count,
      moved_to_trading_this_month: round2(investing ? -investing.activity : 0),
      investing_envelope_available: investing ? investing.balance : null,
      investing_envelope_budgeted: investing ? investing.budgeted : null,
    },
    trading: {
      capital_in_trades: round2(capitalInTrades),
      holdings_value: round2(holdingsValue),
      holdings_unrealized_pl: round2(holdings.value?.totals.unrealized_pl ?? 0),
      alpaca_live_equity: round2(alpacaLive),
      alpaca_paper_equity: round2(alpacaPaper),
      coinbase_value: round2(coinbase),
      wallets_value: round2(wallets.value),
      linked_investment_accounts: round2(linkedInvestment),
      errors: [holdings.error, exchanges.error, wallets.error].filter(Boolean),
    },
    net_worth: round2(cash + cardDebt + loans + capitalInTrades),
    off_budget_accounts: offBudget.map((a) => ({ ...a, balance: round2(a.balance) })),
  });
});
