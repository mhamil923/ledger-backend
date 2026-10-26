// Candles for the quant engine: daily (~600 bars) + hourly (~700 bars).
//   crypto → Coinbase Exchange (free, no key), paged 300 candles at a time
//   stocks/ETFs → Twelve Data (2 credits per analysis)
// Cached in memory for 10 minutes per symbol so repeated analyses are cheap.

import { resolveCoinbaseProduct } from './coinbase.js';
import { getTwelveDataCandles, isTwelveDataConfigured } from './twelvedata.js';
import type { OHLCV } from './ta.js';

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; data: { daily: OHLCV[]; hourly: OHLCV[]; source: string } }>();

async function coinbasePaged(product: string, granularitySec: number, bars: number): Promise<OHLCV[]> {
  const out = new Map<number, OHLCV>();
  let end = Date.now();
  const pageSpan = 300 * granularitySec * 1000;
  for (let fetched = 0; fetched < bars; fetched += 300) {
    const start = end - pageSpan;
    const url =
      `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${granularitySec}` +
      `&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      if (out.size > 0) break; // keep what we have
      throw new Error(`Coinbase candles ${res.status}`);
    }
    const raw = (await res.json()) as [number, number, number, number, number, number][];
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const [t, low, high, open, close, volume] of raw) {
      out.set(t * 1000, { ts: t * 1000, open, high, low, close, volume: volume * close });
    }
    end = start;
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

export async function getQuantCandles(
  symbol: string,
  assetType: 'stock' | 'crypto' | 'etf',
): Promise<{ daily: OHLCV[]; hourly: OHLCV[]; source: string } | null> {
  const key = `${assetType}:${symbol.toUpperCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  let data: { daily: OHLCV[]; hourly: OHLCV[]; source: string } | null = null;
  if (assetType === 'crypto') {
    const product = resolveCoinbaseProduct(symbol);
    if (!product) return null;
    const [daily, hourly] = await Promise.all([
      coinbasePaged(product, 86_400, 600),
      coinbasePaged(product, 3_600, 900),
    ]);
    data = { daily, hourly, source: 'coinbase' };
  } else {
    if (!isTwelveDataConfigured()) return null;
    const [d, h] = await Promise.all([
      getTwelveDataCandles(symbol, 'quant_daily'),
      getTwelveDataCandles(symbol, 'quant_hourly'),
    ]);
    if (!d) return null;
    data = { daily: d.candles, hourly: h?.candles ?? [], source: 'twelvedata' };
  }
  if (data.daily.length === 0 && data.hourly.length === 0) return null;
  cache.set(key, { at: Date.now(), data });
  return data;
}
