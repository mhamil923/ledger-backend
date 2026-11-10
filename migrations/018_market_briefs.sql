-- AI market briefs (Markets tab): one row per generated brief.
CREATE TABLE IF NOT EXISTS market_briefs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model         text NOT NULL,
  data          jsonb NOT NULL,
  input_tokens  integer,
  output_tokens integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_briefs_user_created_idx ON market_briefs (user_id, created_at DESC);
