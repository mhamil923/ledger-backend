-- Layer 2: Manual holdings (P&L, allocation)
-- Each "holding" is a position in an asset; lots track individual buys for cost basis
CREATE TABLE holdings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol      text NOT NULL,
  asset_type  text NOT NULL CHECK (asset_type IN ('stock', 'crypto', 'etf')),
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol, asset_type)
);

CREATE TABLE holding_lots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holding_id      uuid NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
  quantity        numeric(28, 12) NOT NULL,
  cost_per_unit   numeric(28, 12) NOT NULL,
  acquired_at     date NOT NULL,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX holdings_user_idx ON holdings (user_id);
CREATE INDEX holding_lots_holding_idx ON holding_lots (holding_id);
