-- Layer 3: Crypto wallets + exchange APIs (read-only)
CREATE TABLE crypto_wallets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        text NOT NULL,
  chain        text NOT NULL,
  address      text NOT NULL,
  last_synced_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, chain, address)
);

CREATE TABLE crypto_wallet_balances (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id      uuid NOT NULL REFERENCES crypto_wallets(id) ON DELETE CASCADE,
  symbol         text NOT NULL,
  quantity       numeric(36, 18) NOT NULL,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wallet_id, symbol)
);

-- Encrypted at the app layer before insert (never store plaintext exchange keys)
CREATE TABLE exchange_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exchange       text NOT NULL,
  label          text NOT NULL,
  api_key_enc    bytea NOT NULL,
  api_secret_enc bytea NOT NULL,
  permissions    text NOT NULL DEFAULT 'read',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crypto_wallets_user_idx ON crypto_wallets (user_id);
CREATE INDEX exchange_credentials_user_idx ON exchange_credentials (user_id);
