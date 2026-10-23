# Envelope budgeting (Actual Budget model)

The budget follows [Actual Budget](https://github.com/actualbudget/actual)'s envelope model (MIT). Its logic was used as the reference; none of its code was copied.

## How the money flows

- **Categories persist across months.** Each month stores only how much you budgeted to each one (`category_budgets`). When a new month starts, last month's amounts are copied forward automatically.
- **Balance** for each category = carried in + budgeted + activity (refunds add back).
- **Rollover.** A positive balance carries into next month. Overspending comes out of next month's **To Budget**, unless the category has "Roll overspending forward" on. In that case it stays in the category as a negative balance.
- **To Budget** = last month's To Budget + income − budgeted − last month's overspending − uncategorized spending. Uncategorized spending is subtracted so the number never claims money you've already spent.
- **Transfers** between your own on-budget accounts (card payoffs, checking ↔ savings) are paired up and count as neither spending nor income.
- **Off-budget accounts** (brokerage and loans, by default) are tracked for net worth only. Money sent to them is an expense in a category such as **Investing**, which links the budget to the trading side.
- **Month boundaries.** A transaction's month comes from the bank's UTC posting date. `BUDGET_TZ` only decides what "this month" is.

## What runs after every SimpleFIN sync

`services/transaction-engine.ts`:

1. **Duplicate matching** (in `routes/banking.ts`): match by bank ID first. If the ID is new, look for a row in the same account with the same amount within 7 days whose old ID is gone. That catches pending→posted and banks that reissue IDs. Pending holds that disappear without posting are removed.
2. **Transfer pairing.** Pairs a −X and a +X in two of your on-budget accounts within 4 days, as long as one side reads like a transfer or card payment.
3. **One-sided transfers** by wording, when the other account isn't linked.
4. **Rules**, run in stage order (pre → default → post). Within a stage, more specific rules win.
5. **Claude fallback** for merchants no rule caught. This only runs if `ANTHROPIC_API_KEY` is set. It asks about each merchant once, at most 80 merchants per run, and only applies answers it is at least 75% confident in.

Your own edits are never overwritten (`category_source = 'manual'`, `transfer_source = 'manual'`). When you categorize a transaction with "Always file here" on, the app creates a **learned rule** and refiles past transactions that you didn't set by hand.

## Rolling it out

Migration `014_envelope_budgeting.sql` only adds tables and columns; nothing is dropped. It copies forward your existing categories, match patterns (which become rules), savings target (which becomes a Savings category) and bills (each becomes a Bills category with a rule and a monthly budget). The old `budget_categories` table stays where it is and can be dropped later.

```bash
# optional safety net: in the Neon console, create a branch of the database first
cd ledger-backend
npm install
npm run migrate          # applies 014
npm run dev

cd ../ledger-app
npm install              # adds lightweight-charts + react-native-webview
npm run web              # or: npm run ios
```

The first time you open the Budget tab, the engine processes your whole transaction history, so that load takes a few seconds. After that:

1. In Budget, open **⚙ → Budget settings**. Set the start month and the cash you had on day one. Earlier income is ignored, so starting cash is how money already in the bank reaches To Budget.
2. Tap **Uncategorized** to file what's left. Each fix can teach a rule.
3. Deploy to Elastic Beanstalk as usual (`eb deploy`). No new environment variables are required. `BUDGET_TZ` defaults to `America/Chicago`.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/budgets?month=YYYY-MM` | Envelope month: To Budget, groups, categories, income |
| `PUT /api/budgets/:month/categories/:id` | Set budgeted amount |
| `POST /api/budgets/:month/move` | Move money between categories or To Budget |
| `POST /api/budgets/:month/copy-last-month` | Copy last month's amounts |
| `POST /api/budgets/:month/fund-bills` | Budget each bill's monthly equivalent |
| `GET/PATCH /api/budgets/settings` | Start month, starting cash |
| `GET/POST/PATCH/DELETE /api/categories` | Categories (match_patterns become rules) |
| `GET/POST/PATCH/DELETE /api/rules`, `POST /api/rules/preview`, `POST /api/rules/run` | Rules engine |
| `GET /api/transactions`, `PATCH /api/transactions/:id` | Filtered list; categorize, mark transfer, learn a rule |
| `PATCH /api/banking/accounts/:id` | Put an account on or off budget |
| `GET /api/overview` | Home dashboard: budget cash vs capital in trades |
