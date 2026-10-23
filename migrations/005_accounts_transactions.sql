-- Layer 4: Bank accounts + transactions + AI categorization
CREATE TABLE bank_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  provider_account_id text NOT NULL,
  institution     text,
  name            text NOT NULL,
  account_type    text NOT NULL,
  mask            text,
  currency        text NOT NULL DEFAULT 'USD',
  current_balance numeric(20, 4),
  last_synced_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, provider_account_id)
);

CREATE TABLE transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_txn_id text NOT NULL,
  posted_at       timestamptz NOT NULL,
  amount          numeric(20, 4) NOT NULL,
  currency        text NOT NULL DEFAULT 'USD',
  description     text NOT NULL,
  merchant        text,
  category        text,
  ai_category     text,
  ai_confidence   numeric(4, 3),
  pending         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_txn_id)
);

CREATE INDEX transactions_user_posted_idx ON transactions (user_id, posted_at DESC);
CREATE INDEX transactions_account_posted_idx ON transactions (account_id, posted_at DESC);
CREATE INDEX bank_accounts_user_idx ON bank_accounts (user_id);
