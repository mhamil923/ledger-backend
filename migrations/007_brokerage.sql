-- Layer 6: Brokerage (Plaid Investments / Schwab API)
CREATE TABLE brokerage_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  provider_account_id text NOT NULL,
  institution     text,
  name            text NOT NULL,
  account_type    text,
  mask            text,
  currency        text NOT NULL DEFAULT 'USD',
  total_value     numeric(20, 4),
  cash_balance    numeric(20, 4),
  last_synced_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, provider_account_id)
);

CREATE TABLE brokerage_positions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES brokerage_accounts(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol          text NOT NULL,
  asset_type      text,
  quantity        numeric(28, 12) NOT NULL,
  cost_basis      numeric(20, 4),
  current_price   numeric(20, 4),
  market_value    numeric(20, 4),
  synced_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, symbol)
);

CREATE INDEX brokerage_accounts_user_idx ON brokerage_accounts (user_id);
CREATE INDEX brokerage_positions_user_idx ON brokerage_positions (user_id);
