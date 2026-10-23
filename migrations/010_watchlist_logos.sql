-- Logo URL captured at watchlist-add time. CoinGecko search returns coin thumbs;
-- for stocks/ETFs we pull from Finnhub's company profile endpoint.
ALTER TABLE watchlist_items ADD COLUMN logo_url text;
