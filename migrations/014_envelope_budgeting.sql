-- Envelope budgeting, modeled on Actual Budget (github.com/actualbudget/actual).
--
-- What changes:
--   * Categories now live across months (they used to be re-created per month,
--     so every new month started blank). Each month only stores how much was
--     budgeted to each category (category_budgets).
--   * Unspent money rolls into next month; overspending comes out of next
--     month's "To Budget" (or rolls inside the category when
--     rollover_overspending = true), same as Actual's envelope model.
--   * Every transaction now stores its category (category_id) and whether it is
--     a transfer (is_transfer). Categories are assigned on import by a rules
--     engine (category_rules), with Claude as a fallback, and manual edits are
--     never overwritten.
--   * Transfers between your own on-budget accounts are paired up
--     (transfer_txn_id), so paying a credit card is neither spending on the
--     checking side nor income on the card side.
--
-- Nothing is dropped. The old budget_categories rows, budgets.monthly_income
-- and budgets.savings_target stay in place untouched; they are copied forward
-- into the new tables below.

CREATE TABLE categories (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  group_name            text NOT NULL DEFAULT 'Everyday',
  is_income             boolean NOT NULL DEFAULT false,
  -- false (default): a negative balance at month end is taken out of next
  -- month's To Budget. true: the negative balance carries inside the category.
  rollover_overspending boolean NOT NULL DEFAULT false,
  hidden                boolean NOT NULL DEFAULT false,
  sort_order            integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_user_name_uq ON categories (user_id, lower(name));
CREATE INDEX categories_user_idx ON categories (user_id, group_name, sort_order);

CREATE TABLE category_budgets (
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  month       text NOT NULL,
  budgeted    numeric(20, 4) NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category_id, month),
  CONSTRAINT category_budgets_month_format CHECK (month ~ '^\d{4}-\d{2}$')
);
CREATE INDEX category_budgets_month_idx ON category_budgets (month);

-- Rules run in stage order pre -> default -> post. Inside a stage, less
-- specific rules run first, so a more specific match wins (Actual's ordering).
CREATE TABLE category_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage        text NOT NULL DEFAULT 'default' CHECK (stage IN ('pre', 'default', 'post')),
  field        text NOT NULL DEFAULT 'any' CHECK (field IN ('any', 'payee', 'description')),
  op           text NOT NULL DEFAULT 'contains' CHECK (op IN ('contains', 'is', 'starts_with', 'pattern')),
  value        text NOT NULL,
  amount_min   numeric(20, 4),
  amount_max   numeric(20, 4),
  account_id   uuid REFERENCES bank_accounts(id) ON DELETE CASCADE,
  category_id  uuid REFERENCES categories(id) ON DELETE CASCADE,
  set_transfer boolean,
  source       text NOT NULL DEFAULT 'manual'
               CHECK (source IN ('manual', 'learned', 'category_pattern', 'bill')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_rules_has_action CHECK (category_id IS NOT NULL OR set_transfer IS NOT NULL)
);
CREATE INDEX category_rules_user_idx ON category_rules (user_id);

CREATE TABLE budget_settings (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- First month of the envelope budget. Income before this month is ignored;
  -- starting_funds is the cash you already had to assign on day one.
  start_month    text NOT NULL CHECK (start_month ~ '^\d{4}-\d{2}$'),
  starting_funds numeric(20, 4) NOT NULL DEFAULT 0,
  -- Set once the existing transaction history has been categorized and
  -- transfer-paired with the new engine.
  processed_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE transactions
  ADD COLUMN category_id     uuid REFERENCES categories(id) ON DELETE SET NULL,
  ADD COLUMN category_source text CHECK (category_source IN ('rule', 'ai', 'manual')),
  ADD COLUMN is_transfer     boolean NOT NULL DEFAULT false,
  ADD COLUMN transfer_source text CHECK (transfer_source IN ('paired', 'pattern', 'rule', 'manual')),
  ADD COLUMN transfer_txn_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
  ADD COLUMN notes           text;
CREATE INDEX transactions_user_category_idx ON transactions (user_id, category_id);
CREATE INDEX transactions_transfer_idx ON transactions (transfer_txn_id);
CREATE INDEX transactions_account_amount_idx ON transactions (account_id, amount, posted_at);

-- Investment and loan accounts are tracked but kept off the budget, same as
-- Actual's off-budget accounts. Money moving into them is a categorized
-- expense (e.g. an "Investing" category), not a transfer.
ALTER TABLE bank_accounts ADD COLUMN on_budget boolean NOT NULL DEFAULT true;
UPDATE bank_accounts SET on_budget = false WHERE account_type IN ('investment', 'loan');

ALTER TABLE bills ADD COLUMN category_id uuid REFERENCES categories(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Copy existing data forward
-- ---------------------------------------------------------------------------

-- 1. Every user gets an Income category.
INSERT INTO categories (user_id, name, group_name, is_income, sort_order)
SELECT id, 'Income', 'Income', true, -1000 FROM users
ON CONFLICT (user_id, (lower(name))) DO NOTHING;

-- 2. Old per-month variable categories become permanent categories. The most
--    recent month's name and sort order wins.
INSERT INTO categories (user_id, name, group_name, sort_order)
SELECT DISTINCT ON (b.user_id, lower(bc.name))
       b.user_id, bc.name, 'Everyday', bc.sort_order
FROM budget_categories bc
JOIN budgets b ON b.id = bc.budget_id
ORDER BY b.user_id, lower(bc.name), b.month DESC
ON CONFLICT (user_id, (lower(name))) DO NOTHING;

-- 3. Their monthly limits become that month's budgeted amount.
INSERT INTO category_budgets (category_id, month, budgeted)
SELECT c.id, b.month, SUM(bc.monthly_limit)
FROM budget_categories bc
JOIN budgets b ON b.id = bc.budget_id
JOIN categories c ON c.user_id = b.user_id AND lower(c.name) = lower(bc.name)
GROUP BY c.id, b.month
ON CONFLICT (category_id, month) DO NOTHING;

-- 4. Their match patterns become rules (from the most recent month).
INSERT INTO category_rules (user_id, field, op, value, category_id, source)
SELECT DISTINCT ON (c.id, lower(p.pattern))
       c.user_id, 'any',
       CASE WHEN p.pattern LIKE '%\%%' THEN 'pattern' ELSE 'contains' END,
       p.pattern, c.id, 'category_pattern'
FROM (
  SELECT DISTINCT ON (b.user_id, lower(bc.name)) b.user_id, bc.name, bc.match_patterns
  FROM budget_categories bc
  JOIN budgets b ON b.id = bc.budget_id
  ORDER BY b.user_id, lower(bc.name), b.month DESC
) latest
JOIN categories c ON c.user_id = latest.user_id AND lower(c.name) = lower(latest.name)
CROSS JOIN LATERAL unnest(latest.match_patterns) AS p(pattern)
WHERE length(trim(p.pattern)) > 0
ORDER BY c.id, lower(p.pattern);

-- 5. A savings target becomes a Savings category funded by that amount.
INSERT INTO categories (user_id, name, group_name, sort_order)
SELECT DISTINCT user_id, 'Savings', 'Savings', 1000
FROM budgets WHERE savings_target > 0
ON CONFLICT (user_id, (lower(name))) DO NOTHING;

INSERT INTO category_budgets (category_id, month, budgeted)
SELECT c.id, b.month, b.savings_target
FROM budgets b
JOIN categories c ON c.user_id = b.user_id AND lower(c.name) = 'savings'
WHERE b.savings_target > 0
ON CONFLICT (category_id, month) DO NOTHING;

-- 6. Every active bill gets its own category in the Bills group, a rule that
--    routes its charges there, and a monthly budget equal to its monthly
--    equivalent (annual bills are funded 1/12 a month, so the money is there
--    when the charge hits).
INSERT INTO categories (user_id, name, group_name, sort_order)
SELECT user_id, name, 'Bills', 0
FROM bills WHERE active = true
ON CONFLICT (user_id, (lower(name))) DO NOTHING;

UPDATE bills bl SET category_id = c.id
FROM categories c
WHERE c.user_id = bl.user_id AND lower(c.name) = lower(bl.name) AND bl.active = true;

INSERT INTO category_rules (user_id, stage, field, op, value, category_id, source)
SELECT user_id, 'post', 'any', 'contains',
       CASE WHEN merchant IS NOT NULL AND length(trim(merchant)) > 3 THEN trim(merchant) ELSE trim(name) END,
       category_id, 'bill'
FROM bills
WHERE active = true AND category_id IS NOT NULL
  AND length(trim(COALESCE(NULLIF(trim(merchant), ''), name))) > 3;

INSERT INTO category_budgets (category_id, month, budgeted)
SELECT bl.category_id, b.month,
       ROUND(bl.amount * CASE bl.cadence
         WHEN 'weekly' THEN 52.0 / 12
         WHEN 'biweekly' THEN 26.0 / 12
         WHEN 'quarterly' THEN 1.0 / 3
         WHEN 'annual' THEN 1.0 / 12
         ELSE 1 END, 2)
FROM bills bl
JOIN budgets b ON b.user_id = bl.user_id
WHERE bl.active = true AND bl.category_id IS NOT NULL
ON CONFLICT (category_id, month) DO NOTHING;

-- 7. The budget starts in the earliest month that has anything budgeted.
INSERT INTO budget_settings (user_id, start_month)
SELECT c.user_id, MIN(cb.month)
FROM category_budgets cb
JOIN categories c ON c.id = cb.category_id
GROUP BY c.user_id
ON CONFLICT (user_id) DO NOTHING;
