import { getCryptoQuote, getCryptoQuotes } from './coingecko.js';
import { getStockQuote, isFinnhubConfigured } from './finnhub.js';
import { getTwelveDataQuote, isTwelveDataConfigured } from './twelvedata.js';

export interface UnifiedQuote {
  symbol: string;
  asset_type: 'stock' | 'crypto' | 'etf';
  price: number;
  change_pct: number;
  prev_close: number | null;
  ts: number;
}

export interface QuoteRequest {
  symbol: string;
  asset_type: 'stock' | 'crypto' | 'etf';
  external_id?: string | null;
}

// In-memory quote cache. 60s for crypto so we don't burn CoinGecko's free tier
// (30 req/min); a slightly aggressive cache is fine for a personal app.
const TTL_MS = 60_000;
const cache = new Map<string, { value: UnifiedQuote; expires: number }>();

function cacheKey(req: QuoteRequest): string {
  return `${req.asset_type}:${(req.external_id ?? req.symbol).toUpperCase()}`;
}

/**
 * Stock/ETF quote: prefer Finnhub (real-time, when key is set), fall back to
 * Twelve Data's last close (slightly delayed). Throws if both fail / are
 * unconfigured so the caller can surface a per-item error.
 */
async function fetchStockQuote(req: QuoteRequest): Promise<UnifiedQuote> {
  if (isFinnhubConfigured()) {
    try {
      const q = await getStockQuote(req.symbol);
      return {
        symbol: req.symbol,
        asset_type: req.asset_type,
        price: q.price,
        change_pct: q.change_pct,
        prev_close: q.prev_close,
        ts: q.ts,
      };
    } catch (err) {
      console.warn(`Finnhub quote failed for ${req.symbol}, falling back to Twelve Data:`, err);
    }
  }
  if (isTwelveDataConfigured()) {
    const q = await getTwelveDataQuote(req.symbol);
    if (q) {
      return {
        symbol: req.symbol,
        asset_type: req.asset_type,
        price: q.price,
        change_pct: q.change_pct,
        prev_close: q.prev_close,
        ts: q.ts,
      };
    }
  }
  throw new Error(
    `No quote provider configured — add FINNHUB_API_KEY or TWELVE_DATA_API_KEY for ${req.symbol}.`,
  );
}

export async function getQuote(req: QuoteRequest): Promise<UnifiedQuote> {
  const cached = cache.get(cacheKey(req));
  if (cached && cached.expires > Date.now()) return cached.value;

  let quote: UnifiedQuote;
  if (req.asset_type === 'crypto') {
    const q = await getCryptoQuote(req.symbol, req.external_id);
    quote = {
      symbol: req.symbol,
      asset_type: 'crypto',
      price: q.price,
      change_pct: q.change_pct_24h,
      prev_close: null,
      ts: q.ts,
    };
  } else {
    quote = await fetchStockQuote(req);
  }
  cache.set(cacheKey(req), { value: quote, expires: Date.now() + TTL_MS });
  return quote;
}

export async function getQuotes(
  items: QuoteRequest[],
): Promise<
  Array<{ symbol: string; asset_type: string; quote: UnifiedQuote | null; error: string | null }>
> {
  // Pre-fill cached entries and split out what needs to be fetched.
  const now = Date.now();
  const out: Array<{
    symbol: string;
    asset_type: string;
    quote: UnifiedQuote | null;
    error: string | null;
  } | null> = items.map(() => null);

  const cryptoToFetch: { index: number; req: QuoteRequest }[] = [];
  const stockToFetch: { index: number; req: QuoteRequest }[] = [];

  items.forEach((req, idx) => {
    const cached = cache.get(cacheKey(req));
    if (cached && cached.expires > now) {
      out[idx] = { symbol: req.symbol, asset_type: req.asset_type, quote: cached.value, error: null };
      return;
    }
    if (req.asset_type === 'crypto') {
      cryptoToFetch.push({ index: idx, req });
    } else {
      stockToFetch.push({ index: idx, req });
    }
  });

  // Crypto: single batched CoinGecko request for all uncached crypto items.
  if (cryptoToFetch.length > 0) {
    let results: Awaited<ReturnType<typeof getCryptoQuotes>> = [];
    let fatalError: string | null = null;
    try {
      results = await getCryptoQuotes(
        cryptoToFetch.map((c) => ({ symbol: c.req.symbol, coinId: c.req.external_id })),
      );
    } catch (err) {
      // Network failure, timeout, etc. — surface per-item without crashing the request.
      fatalError = err instanceof Error ? err.message : String(err);
    }
    cryptoToFetch.forEach((c, i) => {
      if (fatalError) {
        out[c.index] = {
          symbol: c.req.symbol,
          asset_type: 'crypto',
          quote: null,
          error: fatalError,
        };
        return;
      }
      const r = results[i];
      if (!r) {
        out[c.index] = { symbol: c.req.symbol, asset_type: 'crypto', quote: null, error: 'No result' };
        return;
      }
      if (r.error || !r.quote) {
        out[c.index] = {
          symbol: c.req.symbol,
          asset_type: 'crypto',
          quote: null,
          error: r.error ?? 'No quote',
        };
        return;
      }
      const unified: UnifiedQuote = {
        symbol: c.req.symbol,
        asset_type: 'crypto',
        price: r.quote.price,
        change_pct: r.quote.change_pct_24h,
        prev_close: null,
        ts: r.quote.ts,
      };
      cache.set(cacheKey(c.req), { value: unified, expires: now + TTL_MS });
      out[c.index] = { symbol: c.req.symbol, asset_type: 'crypto', quote: unified, error: null };
    });
  }

  // Stocks/ETFs: Finnhub if configured, else Yahoo fallback. Per-symbol parallel.
  if (stockToFetch.length > 0) {
    const settled = await Promise.allSettled(stockToFetch.map((s) => fetchStockQuote(s.req)));
    stockToFetch.forEach((s, i) => {
      const r = settled[i]!;
      if (r.status === 'fulfilled') {
        cache.set(cacheKey(s.req), { value: r.value, expires: now + TTL_MS });
        out[s.index] = { symbol: s.req.symbol, asset_type: s.req.asset_type, quote: r.value, error: null };
      } else {
        out[s.index] = {
          symbol: s.req.symbol,
          asset_type: s.req.asset_type,
          quote: null,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        };
      }
    });
  }

  return out.map((entry, idx) => {
    if (entry) return entry;
    const item = items[idx]!;
    return { symbol: item.symbol, asset_type: item.asset_type, quote: null, error: 'No data' };
  });
}
