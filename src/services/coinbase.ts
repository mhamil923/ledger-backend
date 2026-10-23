// Coinbase Exchange public market data API — free, no key, US-friendly,
// 10 req/sec. Returns OHLC + volume in a single call, which makes it a much
// better fit than CoinGecko for our chart use case (CoinGecko is 30 req/min
// and splits volume from OHLC across two endpoints).

// Tiny in-memory cache for spot prices so when we value 10 currencies for the
// Accounts page we don't fire 10 separate HTTP calls per page render.
const SPOT_CACHE_MS = 60_000;
const spotCache = new Map<string, { value: number; expires: number }>();

/**
 * Fetch USD spot price for a single currency (e.g. "BTC", "ETH") from the
 * public Coinbase v2 prices endpoint. Returns null on any failure — callers
 * should treat that as "value unknown" and skip rather than throw.
 */
export async function getCoinbaseSpotPrice(currency: string): Promise<number | null> {
  const ccy = currency.toUpperCase();
  if (ccy === 'USD' || ccy === 'USDC' || ccy === 'USDT') return 1; // pegged stables
  const cached = spotCache.get(ccy);
  if (cached && cached.expires > Date.now()) return cached.value;
  try {
    const res = await fetch(`https://api.coinbase.com/v2/prices/${ccy}-USD/spot`);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { amount?: string } };
    const amount = json.data?.amount;
    const value = amount ? Number(amount) : NaN;
    if (!Number.isFinite(value)) return null;
    spotCache.set(ccy, { value, expires: Date.now() + SPOT_CACHE_MS });
    return value;
  } catch {
    return null;
  }
}

export interface CoinbaseCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CoinbaseChartResult {
  candles: CoinbaseCandle[];
  product: string;
}

const BASE = 'https://api.exchange.coinbase.com';

// Symbols we know don't list on Coinbase US can be marked null so we don't
// keep probing. Most major coins are present; the map handles aliases and the
// dynamic cache below learns the rest.
const productOverride = new Map<string, string | null>([
  ['BTC', 'BTC-USD'],
  ['ETH', 'ETH-USD'],
  ['SOL', 'SOL-USD'],
  ['LINK', 'LINK-USD'],
  ['MATIC', 'MATIC-USD'],
  ['POL', 'POL-USD'],
  ['ADA', 'ADA-USD'],
  ['DOT', 'DOT-USD'],
  ['AVAX', 'AVAX-USD'],
  ['DOGE', 'DOGE-USD'],
  ['XRP', 'XRP-USD'],
  ['PEPE', 'PEPE-USD'],
  ['SHIB', 'SHIB-USD'],
  ['XLM', 'XLM-USD'],
  ['LTC', 'LTC-USD'],
  ['ATOM', 'ATOM-USD'],
  ['NEAR', 'NEAR-USD'],
  ['UNI', 'UNI-USD'],
  ['APT', 'APT-USD'],
  ['ARB', 'ARB-USD'],
  ['OP', 'OP-USD'],
  ['SUI', 'SUI-USD'],
  ['INJ', 'INJ-USD'],
  ['BCH', 'BCH-USD'],
  ['ETC', 'ETC-USD'],
  ['ALGO', 'ALGO-USD'],
  ['FIL', 'FIL-USD'],
  ['AAVE', 'AAVE-USD'],
  // Some symbols aren't on Coinbase US:
  ['BNB', null],
  ['TRX', null],
  ['TAO', null],
]);

interface RangeSpec {
  granularitySec: number;
  spanSec: number; // how far back to request
}

const RANGE_TO_SPEC: Record<string, RangeSpec> = {
  '1d': { granularitySec: 300, spanSec: 24 * 3600 }, // 5-min candles for 24h
  '7d': { granularitySec: 3600, spanSec: 7 * 24 * 3600 }, // hourly for 7 days
  '30d': { granularitySec: 21600, spanSec: 30 * 24 * 3600 }, // 6h for 30 days
  '90d': { granularitySec: 86400, spanSec: 90 * 24 * 3600 }, // daily for 90 days
  '1y': { granularitySec: 86400, spanSec: 300 * 24 * 3600 }, // Coinbase caps at 300 candles per call
};

export function resolveCoinbaseProduct(symbol: string): string | null {
  const up = symbol.toUpperCase();
  if (productOverride.has(up)) return productOverride.get(up) ?? null;
  return `${up}-USD`;
}

function markUnavailable(symbol: string): void {
  productOverride.set(symbol.toUpperCase(), null);
}

export async function getCoinbaseCandles(
  symbol: string,
  range: string,
): Promise<CoinbaseChartResult | null> {
  const product = resolveCoinbaseProduct(symbol);
  if (!product) return null;

  const spec = RANGE_TO_SPEC[range];
  if (!spec) throw new Error(`Unknown range ${range}`);

  // Coinbase wants ISO timestamps. End=now, start=now-spanSec.
  const end = new Date();
  const start = new Date(end.getTime() - spec.spanSec * 1000);
  const url =
    `${BASE}/products/${product}/candles?` +
    `granularity=${spec.granularitySec}` +
    `&start=${encodeURIComponent(start.toISOString())}` +
    `&end=${encodeURIComponent(end.toISOString())}`;

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    if (res.status === 404 || res.status === 400) {
      // Product doesn't exist (e.g. unsupported asset). Cache and bail out.
      markUnavailable(symbol);
      return null;
    }
    throw new Error(`Coinbase candles failed: ${res.status} ${res.statusText}`);
  }

  // Coinbase returns newest-first as [time, low, high, open, close, volume].
  // Time is in seconds. We sort ascending for the chart renderer.
  const raw = (await res.json()) as [number, number, number, number, number, number][];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const candles: CoinbaseCandle[] = raw
    .map(([time, low, high, open, close, volume]) => ({
      ts: time * 1000,
      open,
      high,
      low,
      close,
      // Convert base volume to USD volume so it's comparable to CoinGecko's total_volumes.
      volume: volume * close,
    }))
    .sort((a, b) => a.ts - b.ts);
  return { candles, product };
}
