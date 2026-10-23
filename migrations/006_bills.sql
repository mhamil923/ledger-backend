-- Layer 5: Bill tracking + recurring detection
CREATE TABLE bills (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  merchant        text,
  amount          numeric(20, 4) NOT NULL,
  currency        text NOT NULL DEFAULT 'USD',
  cadence         text NOT NULL CHECK (cadence IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'annual', 'custom')),
  next_due_date   date,
  account_id      uuid REFERENCES bank_accounts(id) ON DELETE SET NULL,
  auto_detected   boolean NOT NULL DEFAULT false,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bill_payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id     uuid NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
  paid_at     date NOT NULL,
  amount      numeric(20, 4) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bills_user_idx ON bills (user_id, active);
CREATE INDEX bills_next_due_idx ON bills (user_id, next_due_date) WHERE active = true;
CREATE INDEX bill_payments_bill_idx ON bill_payments (bill_id, paid_at DESC);
