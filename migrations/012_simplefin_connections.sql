-- Layer 4b: SimpleFIN bridge connections.
--
-- Each user has at most one active SimpleFIN connection. The Access URL
-- contains credentials with full read access to all linked bank accounts
-- under that user's SimpleFIN account, so it is stored encrypted at rest
-- with AES-256-GCM (key = BANKING_ENC_KEY in env). The ciphertext + iv +
-- auth tag are stored together as a base64-encoded JSON blob.

CREATE TABLE simplefin_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  encrypted_access  text NOT NULL,
  status            text NOT NULL DEFAULT 'active', -- active | error | revoked
  last_error        text,
  last_synced_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE INDEX simplefin_connections_user_idx ON simplefin_connections (user_id);

-- Tie bank_accounts back to the connection that owns them so we can resync
-- selectively and clean up cleanly when a user disconnects.
ALTER TABLE bank_accounts ADD COLUMN connection_id uuid REFERENCES simplefin_connections(id) ON DELETE CASCADE;
CREATE INDEX bank_accounts_connection_idx ON bank_accounts (connection_id);
