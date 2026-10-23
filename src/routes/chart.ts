import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { getCryptoChartFull, getCryptoOhlc, type CryptoCandle } from '../services/coingecko.js';
import { getCoinbaseCandles, type CoinbaseCandle } from '../services/coinbase.js';
import {
  getTwelveDataCandles,
  isTwelveDataConfigured,
  type TwelveDataCandle,
} from '../services/twelvedata.js';
import { rsi, simpleMovingAverage } from '../services/indicators.js';

export const chartRouter = Router();
chartRouter.use(requireAuth);

export interface ChartPoint {
  ts: number;
  price: number;
}

export interface ChartOverlay {
  key: 'sma20' | 'sma50';
  label: string;
  points: { ts: number; value: number }[];
}

export interface VolumePoint {
  ts: number;
  value: number;
}

export interface IndicatorSeries {
  key: 'rsi14';
  label: string;
  points: { ts: number; value: number }[];
}

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ChartResponse {
  symbol: string;
  asset_type: string;
  range: string;
  chart_type: 'line' | 'candle';
  points: ChartPoint[];
  candles: Candle[];
  overlays: ChartOverlay[];
  volumes: VolumePoint[];
  indicator_series: IndicatorSeries[];
  source: 'coingecko' | 'coinbase' | 'twelvedata' | 'finnhub' | 'unavailable';
}

const querySchema = z.object({
  symbol: z.string().min(1).max(20),
  asset_type: z.enum(['stock', 'crypto', 'etf']),
  external_id: z.string().max(120).optional(),
  range: z.enum(['1d', '7d', '30d', '90d', '1y']).optional().default('7d'),
  chart_type: z.enum(['line', 'candle']).optional().default('line'),
});

const RANGE_TO_DAYS: Record<string, number> = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

const DAILY_RESOLUTION_RANGES = new Set(['30d', '90d', '1y']);

interface CacheEntry {
  expires: number;
  data: ChartResponse;
}
const cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60_000;

function cacheKey(
  symbol: string,
  externalId: string | null | undefined,
  range: string,
  chartType: string,
): string {
  return `${range}:${chartType}:${(externalId ?? symbol).toUpperCase()}`;
}

function buildOverlays(points: ChartPoint[], range: string, fromCandles: boolean): ChartOverlay[] {
  // For candle-resolution data (Binance), we always have meaningful periods so build overlays.
  if (!fromCandles && !DAILY_RESOLUTION_RANGES.has(range)) return [];
  const overlays: ChartOverlay[] = [];
  if (points.length >= 20) {
    overlays.push({ key: 'sma20', label: 'SMA 20', points: simpleMovingAverage(points, 20) });
  }
  if (points.length >= 50) {
    overlays.push({ key: 'sma50', label: 'SMA 50', points: simpleMovingAverage(points, 50) });
  }
  return overlays;
}

function buildIndicatorSeries(points: ChartPoint[]): IndicatorSeries[] {
  if (points.length < 15) return [];
  const prices = points.map((p) => p.price);
  const rsiValues = rsi(prices, 14);
  const series: { ts: number; value: number }[] = [];
  for (let i = 0; i < rsiValues.length; i++) {
    const v = rsiValues[i];
    if (v != null && !Number.isNaN(v)) {
      series.push({ ts: points[i]!.ts, value: v });
    }
  }
  if (series.length === 0) return [];
  return [{ key: 'rsi14', label: 'RSI 14', points: series }];
}

function toCgCandles(raw: CryptoCandle[]): Candle[] {
  return raw.map((c) => ({ ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close }));
}

function coinbaseToChartResponse(
  symbol: string,
  range: string,
  chart_type: 'line' | 'candle',
  cb: CoinbaseCandle[],
): Omit<ChartResponse, 'asset_type'> {
  const points: ChartPoint[] = cb.map((c) => ({ ts: c.ts, price: c.close }));
  const candles: Candle[] = cb.map((c) => ({
    ts: c.ts,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
  const volumes: VolumePoint[] = cb.map((c) => ({ ts: c.ts, value: c.volume }));
  return {
    symbol,
    range,
    chart_type,
    points,
    candles: chart_type === 'candle' ? candles : [],
    overlays: buildOverlays(points, range, true),
    volumes,
    indicator_series: buildIndicatorSeries(points),
    source: 'coinbase',
  };
}

function twelveDataToChartResponse(
  symbol: string,
  range: string,
  chart_type: 'line' | 'candle',
  td: TwelveDataCandle[],
): Omit<ChartResponse, 'asset_type'> {
  const points: ChartPoint[] = td.map((c) => ({ ts: c.ts, price: c.close }));
  const candles: Candle[] = td.map((c) => ({
    ts: c.ts,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
  const volumes: VolumePoint[] = td.map((c) => ({ ts: c.ts, value: c.volume }));
  return {
    symbol,
    range,
    chart_type,
    points,
    candles: chart_type === 'candle' ? candles : [],
    overlays: buildOverlays(points, range, true),
    volumes,
    indicator_series: buildIndicatorSeries(points),
    source: 'twelvedata',
  };
}

chartRouter.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
    return;
  }
  const { symbol, asset_type, external_id, range, chart_type } = parsed.data;
  const days = RANGE_TO_DAYS[range] ?? 7;

  const key = cacheKey(symbol, external_id, range, chart_type);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    res.json(cached.data);
    return;
  }

  if (asset_type === 'crypto') {
    // Try Coinbase first — 10 req/sec (~600/min), OHLC + volume in one call,
    // US-friendly, no key required. Falls through to CoinGecko if the symbol
    // isn't on Coinbase US or upstream is transiently down.
    try {
      const cb = await getCoinbaseCandles(symbol, range);
      if (cb && cb.candles.length > 0) {
        const payload: ChartResponse = {
          ...coinbaseToChartResponse(symbol, range, chart_type, cb.candles),
          asset_type,
        };
        cache.set(key, { expires: Date.now() + TTL_MS, data: payload });
        res.json(payload);
        return;
      }
    } catch (err) {
      console.warn(`Coinbase fetch failed for ${symbol} ${range}, falling back to CoinGecko:`, err);
    }

    // Fallback: CoinGecko (for coins not on Binance, e.g. niche/new tokens).
    try {
      const [chartFull, ohlcRaw] = await Promise.all([
        getCryptoChartFull(symbol, external_id, days),
        chart_type === 'candle'
          ? getCryptoOhlc(symbol, external_id, days).catch(() => [] as CryptoCandle[])
          : Promise.resolve([] as CryptoCandle[]),
      ]);
      const { points, volumes } = chartFull;
      const payload: ChartResponse = {
        symbol,
        asset_type,
        range,
        chart_type,
        points,
        candles: toCgCandles(ohlcRaw),
        overlays: buildOverlays(points, range, false),
        volumes,
        indicator_series: buildIndicatorSeries(points),
        source: 'coingecko',
      };
      cache.set(key, { expires: Date.now() + TTL_MS, data: payload });
      res.json(payload);
    } catch (err) {
      res.status(502).json({
        error: 'Could not fetch crypto chart',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Stocks + ETFs: use Twelve Data. Free tier 800/day, 8/min. Needs an API key.
  if ((asset_type === 'stock' || asset_type === 'etf') && isTwelveDataConfigured()) {
    try {
      const td = await getTwelveDataCandles(symbol, range);
      if (td && td.candles.length > 0) {
        const payload: ChartResponse = {
          ...twelveDataToChartResponse(symbol, range, chart_type, td.candles),
          asset_type,
        };
        cache.set(key, { expires: Date.now() + TTL_MS, data: payload });
        res.json(payload);
        return;
      }
    } catch (err) {
      console.warn(`Twelve Data chart failed for ${symbol} ${range}:`, err);
    }
  }

  const payload: ChartResponse = {
    symbol,
    asset_type,
    range,
    chart_type,
    points: [],
    candles: [],
    overlays: [],
    volumes: [],
    indicator_series: [],
    source: 'unavailable',
  };
  res.json(payload);
});
