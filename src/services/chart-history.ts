// Paged candle history for the chart: any timeframe, loading further back on
// demand (the app asks for the next older page when you scroll/zoom left).
//   crypto → Coinbase Exchange (5m/15m/1h/1d native; 4h and 1w built from 1h/1d)
//   stocks/ETFs → Twelve Data (all intervals native, paged with end_date)

import { config } from '../config.js';
import { resolveCoinbaseProduct } from './coinbase.js';
import type { OHLCV } from './ta.js';

export type ChartInterval = '5m' | '15m' | '1h' | '4h' | '1d' | '1w';

export const INTERVAL_MS: Record<ChartInterval, number> = {
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

export interface HistoryPage {
  candles: OHLCV[];
  has_more: boolean;
  source: 'coinbase' | 'twelvedata' | 'unavailable';
}

const cache = new Map<string, { at: number; ttl: number; page: HistoryPage }>();

// ---------------------------------------------------------------------------
// Coinbase
// ---------------------------------------------------------------------------

const COINBASE_NATIVE: Partial<Record<ChartInterval, number>> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '1d': 86400,
};
// Built by merging smaller candles: [base interval, how many per candle]
const COINBASE_AGG: Partial<Record<ChartInterval, [ChartInterval, number]>> = {
  '4h': ['1h', 4],
  '1w': ['1d', 7],
};

async function coinbaseRange(
  product: string,
  granularitySec: number,
  endMs: number,
  count: number,
): Promise<{ candles: OHLCV[]; exhausted: boolean }> {
  const out = new Map<number, OHLCV>();
  let end = endMs;
  let exhausted = false;
  const pageMs = 300 * granularitySec * 1000;
  while (out.size < count) {
    const start = end - pageMs;
    const url =
      `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${granularitySec}` +
      `&start=${new Date(start).toISOString()}&end=${new Date(end - 1000).toISOString()}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      if (out.size > 0) break;
      if (res.status === 404 || res.status === 400) return { candles: [], exhausted: true };
      throw new Error(`Coinbase candles ${res.status}`);
    }
    const raw = (await res.json()) as [number, number, number, number, number, number][];
    if (!Array.isArray(raw) || raw.length === 0) {
      exhausted = true; // before the asset was listed
      break;
    }
    for (const [t, low, high, open, close, volume] of raw) {
      const ts = t * 1000;
      if (ts < endMs) out.set(ts, { ts, open, high, low, close, volume: volume * close });
    }
    end = start;
  }
  const candles = [...out.values()].sort((a, b) => a.ts - b.ts);
  return { candles: candles.slice(-count), exhausted };
}

/** Merge candles into fixed buckets (4h aligned to UTC, weeks start Monday). */
function aggregate(c: OHLCV[], interval: ChartInterval): OHLCV[] {
  const size = INTERVAL_MS[interval];
  const offset = interval === '1w' ? 4 * 86_400_000 : 0; // 1970-01-05 was a Monday
  const buckets = new Map<number, OHLCV>();
  for (const k of c) {
    const key = Math.floor((k.ts - offset) / size) * size + offset;
    const b = buckets.get(key);
    if (!b) buckets.set(key, { ...k, ts: key });
    else {
      b.high = Math.max(b.high, k.high);
      b.low = Math.min(b.low, k.low);
      b.close = k.close;
      b.volume += k.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

async function coinbaseHistory(symbol: string, interval: ChartInterval, before: number, limit: number): Promise<HistoryPage> {
  const product = resolveCoinbaseProduct(symbol);
  if (!product) return { candles: [], has_more: false, source: 'unavailable' };
  const native = COINBASE_NATIVE[interval];
  if (native) {
    const r = await coinbaseRange(product, native, before, limit);
    // Empty newest page = not on Coinbase; empty older page = reached the listing date.
    if (r.candles.length === 0) return { candles: [], has_more: false, source: before >= Date.now() ? 'unavailable' : 'coinbase' };
    return { candles: r.candles, has_more: !r.exhausted && r.candles.length >= limit * 0.9, source: 'coinbase' };
  }
  const [base, factor] = COINBASE_AGG[interval]!;
  // Align the page end to a bucket boundary so every returned candle is complete.
  const size = INTERVAL_MS[interval];
  const offset = interval === '1w' ? 4 * 86_400_000 : 0;
  const alignedBefore = before >= Date.now() ? before : Math.floor((before - offset) / size) * size + offset;
  const r = await coinbaseRange(product, COINBASE_NATIVE[base]!, alignedBefore, limit * factor + factor);
  let agg = aggregate(r.candles, interval);
  // The oldest bucket is usually partial (we cut mid-bucket) — drop it unless
  // it's the very start of the asset's history.
  if (!r.exhausted && agg.length > 1) agg = agg.slice(1);
  return { candles: agg.slice(-limit), has_more: !r.exhausted && agg.length >= limit * 0.9, source: 'coinbase' };
}

// ---------------------------------------------------------------------------
// Twelve Data
// ---------------------------------------------------------------------------

const TD_INTERVAL: Record<ChartInterval, string> = {
  '5m': '5min',
  '15m': '15min',
  '1h': '1h',
  '4h': '4h',
  '1d': '1day',
  '1w': '1week',
};

function tdDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

async function twelveDataHistory(symbol: string, interval: ChartInterval, before: number, limit: number): Promise<HistoryPage> {
  if (!config.TWELVE_DATA_API_KEY) return { candles: [], has_more: false, source: 'unavailable' };
  const isLatest = before >= Date.now();
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol.toUpperCase())}` +
    `&interval=${TD_INTERVAL[interval]}&outputsize=${limit}&timezone=UTC` +
    (isLatest ? '' : `&end_date=${encodeURIComponent(tdDate(before - 1000))}`) +
    `&apikey=${config.TWELVE_DATA_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twelve Data ${res.status}`);
  const json = (await res.json()) as {
    status?: string;
    code?: number;
    message?: string;
    values?: Array<{ datetime: string; open: string; high: string; low: string; close: string; volume?: string }>;
  };
  if (json.status === 'error') {
    // "No data is available on the specified dates" = reached the start.
    if (json.code === 400 && /no data/i.test(json.message ?? '')) return { candles: [], has_more: false, source: 'twelvedata' };
    if (json.code === 400 || json.code === 404) return { candles: [], has_more: false, source: 'unavailable' };
    throw new Error(json.message ?? 'Twelve Data error');
  }
  const candles = (json.values ?? [])
    .map((v) => {
      const iso = v.datetime.length <= 10 ? `${v.datetime}T00:00:00Z` : `${v.datetime.replace(' ', 'T')}Z`;
      const close = Number(v.close);
      return {
        ts: Date.parse(iso),
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close,
        volume: v.volume ? Number(v.volume) * close : 0,
      };
    })
    .filter((c) => Number.isFinite(c.close) && c.ts < before)
    .sort((a, b) => a.ts - b.ts);
  return { candles, has_more: candles.length >= limit * 0.9, source: 'twelvedata' };
}

// ---------------------------------------------------------------------------

export async function getHistory(
  symbol: string,
  assetType: 'stock' | 'crypto' | 'etf',
  interval: ChartInterval,
  before: number | null,
  limit: number,
): Promise<HistoryPage> {
  const latest = before == null;
  const end = before ?? Date.now() + INTERVAL_MS[interval]; // include the forming candle
  const key = `${assetType}:${symbol.toUpperCase()}:${interval}:${latest ? 'latest' : before}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.page;

  const page =
    assetType === 'crypto'
      ? await coinbaseHistory(symbol, interval, end, limit)
      : await twelveDataHistory(symbol, interval, end, limit);

  // Latest page changes every tick; older pages never change.
  const ttl = latest ? (INTERVAL_MS[interval] <= 3_600_000 ? 10_000 : 30_000) : 60 * 60_000;
  cache.set(key, { at: Date.now(), ttl, page });
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
    for (const [k] of oldest) cache.delete(k);
  }
  return page;
}
