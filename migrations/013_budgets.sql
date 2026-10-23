-- Layer 6: monthly budgets.
--
-- One row per (user, month). Categories hang off the budget with their own
-- monthly_limit and merchant/description patterns used to match transactions
-- from the transactions table.
CREATE TABLE budgets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month          text NOT NULL, -- 'YYYY-MM'
  monthly_income numeric(20, 4) NOT NULL DEFAULT 0,
  savings_target numeric(20, 4) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, month),
  CONSTRAINT budgets_month_format CHECK (month ~ '^\d{4}-\d{2}$')
);

CREATE INDEX budgets_user_month_idx ON budgets (user_id, month DESC);

CREATE TABLE budget_categories (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id      uuid NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  name           text NOT NULL,
  monthly_limit  numeric(20, 4) NOT NULL DEFAULT 0,
  -- ILIKE patterns matched against transactions.description AND merchant.
  -- Each string is used as-is with % wildcards allowed; if none are provided,
  -- the category matches nothing automatically (user has to add patterns).
  match_patterns text[] NOT NULL DEFAULT '{}',
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX budget_categories_budget_idx ON budget_categories (budget_id, sort_order);
