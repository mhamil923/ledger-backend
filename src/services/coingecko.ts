import { config } from '../config.js';

export interface CryptoQuote {
  symbol: string;
  price: number;
  change_pct_24h: number;
  market_cap: number | null;
  volume_24h: number | null;
  ts: number;
}

export interface CryptoChartPoint {
  ts: number;
  price: number;
}

export interface CryptoVolumePoint {
  ts: number;
  value: number;
}

export interface CryptoChartResult {
  points: CryptoChartPoint[];
  volumes: CryptoVolumePoint[];
}

export interface CryptoCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const CG_BASE = config.COINGECKO_API_KEY
  ? 'https://pro-api.coingecko.com/api/v3'
  : 'https://api.coingecko.com/api/v3';

// CoinGecko uses coin IDs (e.g. "bitcoin"), not tickers. Map common tickers.
const SYMBOL_TO_ID: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  LINK: 'chainlink',
  MATIC: 'matic-network',
  USDC: 'usd-coin',
  USDT: 'tether',
  ADA: 'cardano',
  DOT: 'polkadot',
  AVAX: 'avalanche-2',
  DOGE: 'dogecoin',
  XRP: 'ripple',
};

export function resolveCoinId(symbol: string): string | null {
  return SYMBOL_TO_ID[symbol.toUpperCase()] ?? null;
}

function authHeaders(): Record<string, string> {
  if (config.COINGECKO_API_KEY) {
    return { 'x-cg-pro-api-key': config.COINGECKO_API_KEY };
  }
  return {};
}

interface SimplePriceEntry {
  usd: number;
  usd_24h_change?: number;
  usd_market_cap?: number;
  usd_24h_vol?: number;
  last_updated_at?: number;
}

export interface CryptoQuoteRequest {
  symbol: string;
  coinId?: string | null;
}

export interface CryptoQuoteResult {
  symbol: string;
  quote: CryptoQuote | null;
  error: string | null;
}

/**
 * Batches all the requested coins into a single CoinGecko call so we don't burn
 * the free-tier rate limit. Items without a resolvable coin id come back as errors.
 */
export async function getCryptoQuotes(items: CryptoQuoteRequest[]): Promise<CryptoQuoteResult[]> {
  if (items.length === 0) return [];

  const resolved = items.map((item) => {
    const id = item.coinId ?? resolveCoinId(item.symbol);
    return { ...item, id };
  });

  const knownIds = Array.from(
    new Set(resolved.filter((r): r is typeof r & { id: string } => !!r.id).map((r) => r.id)),
  );

  if (knownIds.length === 0) {
    return resolved.map((r) => ({
      symbol: r.symbol,
      quote: null,
      error: `Unknown crypto symbol ${r.symbol} — add it through the search picker so its CoinGecko id is saved.`,
    }));
  }

  const url =
    `${CG_BASE}/simple/price?ids=${knownIds.join(',')}` +
    `&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true` +
    `&include_market_cap=true&include_last_updated_at=true`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const message = `CoinGecko batch quote failed: ${res.status} ${res.statusText}`;
    return resolved.map((r) => ({ symbol: r.symbol, quote: null, error: message }));
  }
  const data = (await res.json()) as Record<string, SimplePriceEntry>;

  return resolved.map((r) => {
    if (!r.id) {
      return {
        symbol: r.symbol,
        quote: null,
        error: `Unknown crypto symbol ${r.symbol} — add it through the search picker so its CoinGecko id is saved.`,
      };
    }
    const entry = data[r.id];
    if (!entry) {
      return {
        symbol: r.symbol,
        quote: null,
        error: `CoinGecko returned no quote for ${r.symbol}`,
      };
    }
    return {
      symbol: r.symbol,
      quote: {
        symbol: r.symbol,
        price: entry.usd,
        change_pct_24h: entry.usd_24h_change ?? 0,
        market_cap: entry.usd_market_cap ?? null,
        volume_24h: entry.usd_24h_vol ?? null,
        ts: (entry.last_updated_at ?? Math.floor(Date.now() / 1000)) * 1000,
      },
      error: null,
    };
  });
}

/** Single-item convenience wrapper that delegates to the batch function. */
export async function getCryptoQuote(symbol: string, coinId?: string | null): Promise<CryptoQuote> {
  const [result] = await getCryptoQuotes([{ symbol, coinId }]);
  if (!result) throw new Error(`No result for ${symbol}`);
  if (result.error || !result.quote) {
    throw new Error(result.error ?? `No quote for ${symbol}`);
  }
  return result.quote;
}

/**
 * Backwards-compat: returns just the price points. Use `getCryptoChartFull`
 * for price + volume in one call.
 */
export async function getCryptoChart(
  symbol: string,
  coinId: string | null | undefined,
  days: number,
): Promise<CryptoChartPoint[]> {
  const result = await getCryptoChartFull(symbol, coinId, days);
  return result.points;
}

/** Returns price + volume series for the last N days. */
export async function getCryptoChartFull(
  symbol: string,
  coinId: string | null | undefined,
  days: number,
): Promise<CryptoChartResult> {
  const id = coinId ?? resolveCoinId(symbol);
  if (!id) {
    throw new Error(`Unknown crypto symbol ${symbol} for chart.`);
  }
  const url = `${CG_BASE}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`CoinGecko chart failed for ${symbol}: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    prices?: [number, number][];
    total_volumes?: [number, number][];
  };
  if (!data.prices) throw new Error('No price data returned');
  return {
    points: data.prices.map(([ts, price]) => ({ ts, price })),
    volumes: (data.total_volumes ?? []).map(([ts, value]) => ({ ts, value })),
  };
}

/**
 * OHLC candles for the last N days. CoinGecko granularity:
 *  1-2 days   → 30-minute candles
 *  3-30 days  → 4-hour candles
 *  >30 days   → 4-day candles
 */
export async function getCryptoOhlc(
  symbol: string,
  coinId: string | null | undefined,
  days: number,
): Promise<CryptoCandle[]> {
  const id = coinId ?? resolveCoinId(symbol);
  if (!id) throw new Error(`Unknown crypto symbol ${symbol} for OHLC chart.`);
  const url = `${CG_BASE}/coins/${encodeURIComponent(id)}/ohlc?vs_currency=usd&days=${days}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`CoinGecko OHLC failed for ${symbol}: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as [number, number, number, number, number][];
  return raw.map(([ts, open, high, low, close]) => ({ ts, open, high, low, close }));
}
