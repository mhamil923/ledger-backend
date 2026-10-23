-- Source-specific identifier for live quotes (e.g. CoinGecko coin id like "pepe", Finnhub doesn't need one).
-- Items added via search store this so we don't have to maintain a hardcoded symbol->id map.
ALTER TABLE watchlist_items ADD COLUMN external_id text;
ALTER TABLE holdings ADD COLUMN external_id text;
