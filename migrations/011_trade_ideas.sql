-- Trade journal. Every structured trade idea Claude proposes is recorded here
-- with the market context at creation time. Outcomes get filled in by walking
-- price history forward (lazy resolver in the analysis route).
CREATE TABLE trade_ideas (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Asset
  symbol                   text NOT NULL,
  asset_type               text NOT NULL CHECK (asset_type IN ('stock', 'crypto', 'etf')),
  external_id              text,
  display_name             text,

  -- Trade plan (from Claude's submit_analysis tool call)
  direction                text NOT NULL CHECK (direction IN ('long', 'short')),
  entry_low                numeric(28, 12) NOT NULL,
  entry_high               numeric(28, 12) NOT NULL,
  stop_loss                numeric(28, 12) NOT NULL,
  targets                  numeric(28, 12)[] NOT NULL,
  bias                     text NOT NULL,
  conviction               integer NOT NULL,
  time_horizon             text NOT NULL,
  rationale                text,

  -- Market context at the moment the idea was generated
  price_at_creation        numeric(28, 12) NOT NULL,
  rsi14_at_creation        numeric(8, 2),
  macd_state_at_creation   text,
  fear_greed_at_creation   integer,
  model                    text NOT NULL,

  -- Outcome tracking
  status                   text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'closed', 'expired')),
  triggered_at             timestamptz,
  triggered_price          numeric(28, 12),
  resolved_at              timestamptz,
  resolved_price           numeric(28, 12),
  resolution               text, -- 'stop_hit', 'target_1', 'target_2', 'target_3', 'expired'
  realized_pnl_pct         numeric(8, 4),

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX trade_ideas_user_created_idx ON trade_ideas (user_id, created_at DESC);
CREATE INDEX trade_ideas_user_symbol_idx ON trade_ideas (user_id, symbol, created_at DESC);
CREATE INDEX trade_ideas_pending_idx ON trade_ideas (user_id, status)
  WHERE status IN ('pending', 'active');
