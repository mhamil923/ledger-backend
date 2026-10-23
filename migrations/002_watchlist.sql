-- Layer 1: Watchlist
-- asset_type: 'stock' (Finnhub), 'crypto' (CoinGecko), 'etf' (Finnhub)
CREATE TABLE watchlist_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol      text NOT NULL,
  asset_type  text NOT NULL CHECK (asset_type IN ('stock', 'crypto', 'etf')),
  display_name text,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol, asset_type)
);

CREATE INDEX watchlist_items_user_sort_idx ON watchlist_items (user_id, sort_order);

-- Cache of AI analyses keyed by symbol + day, so we don't burn tokens re-running same-day analysis
CREATE TABLE ai_analyses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol        text NOT NULL,
  asset_type    text NOT NULL,
  analysis_date date NOT NULL DEFAULT current_date,
  content       text NOT NULL,
  model         text NOT NULL,
  input_tokens  integer,
  output_tokens integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol, analysis_date)
);

CREATE INDEX ai_analyses_user_symbol_idx ON ai_analyses (user_id, symbol, analysis_date DESC);
