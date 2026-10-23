import { config } from '../config.js';

// Twelve Data — free tier 800 calls/day, 8 calls/min, includes intraday + EOD.
// US-friendly, well-documented, key required. Used for stock/ETF historical
// charts since Finnhub's free tier dropped candles and Yahoo started blocking IPs.

export interface TwelveDataCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TwelveDataChartResult {
  candles: TwelveDataCandle[];
  symbol: string;
  last_close: number;
  change_pct_24h: number | null;
}

const BASE = 'https://api.twelvedata.com';

interface RangeSpec {
  interval: string;
  outputsize: number;
}

// Free tier limits + reasonable visual densities.
const RANGE_TO_SPEC: Record<string, RangeSpec> = {
  '1d': { interval: '5min', outputsize: 78 }, // ~6.5 trading hours × 12 candles/hour
  '7d': { interval: '30min', outputsize: 91 }, // 5 trading days × ~13 30-min slots + cushion
  '30d': { interval: '1day', outputsize: 22 },
  '90d': { interval: '1day', outputsize: 65 },
  '1y': { interval: '1day', outputsize: 252 },
};

interface TimeSeriesResponse {
  meta?: { symbol?: string };
  values?: Array<{
    datetime: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume?: string;
  }>;
  status?: string;
  code?: number;
  message?: string;
}

export function isTwelveDataConfigured(): boolean {
  return !!config.TWELVE_DATA_API_KEY;
}

export async function getTwelveDataCandles(
  symbol: string,
  range: string,
): Promise<TwelveDataChartResult | null> {
  if (!config.TWELVE_DATA_API_KEY) {
    throw new Error('TWELVE_DATA_API_KEY is not configured');
  }
  const spec = RANGE_TO_SPEC[range];
  if (!spec) throw new Error(`Unknown range ${range}`);

  const url =
    `${BASE}/time_series?symbol=${encodeURIComponent(symbol.toUpperCase())}` +
    `&interval=${spec.interval}&outputsize=${spec.outputsize}` +
    `&apikey=${config.TWELVE_DATA_API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Twelve Data request failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as TimeSeriesResponse;

  // Twelve Data wraps errors in a 200 response with status:"error".
  if (json.status === 'error') {
    // 404 / unknown symbol cases: return null so the caller can mark unavailable.
    if (json.code === 400 || json.code === 404) return null;
    throw new Error(json.message ?? 'Twelve Data error');
  }

  const values = json.values;
  if (!values || values.length === 0) return null;

  // Twelve Data returns newest-first. We sort ascending for the chart renderer.
  const candles: TwelveDataCandle[] = values
    .map((v) => ({
      ts: Date.parse(v.datetime),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: v.volume ? Number(v.volume) * Number(v.close) : 0,
    }))
    .filter((c) => Number.isFinite(c.close))
    .sort((a, b) => a.ts - b.ts);

  if (candles.length === 0) return null;

  const lastClose = candles[candles.length - 1]!.close;
  const prevClose = candles.length > 1 ? candles[candles.length - 2]!.close : null;
  const changePct =
    prevClose != null && prevClose > 0 ? ((lastClose - prevClose) / prevClose) * 100 : null;

  return {
    candles,
    symbol: symbol.toUpperCase(),
    last_close: lastClose,
    change_pct_24h: changePct,
  };
}

/** Quick spot quote via the latest 1-day data point. */
export async function getTwelveDataQuote(symbol: string): Promise<{
  price: number;
  change_pct: number;
  prev_close: number | null;
  ts: number;
} | null> {
  const result = await getTwelveDataCandles(symbol, '1d');
  if (!result) return null;
  const last = result.candles[result.candles.length - 1]!;
  const prev = result.candles.length > 1 ? result.candles[result.candles.length - 2]! : null;
  return {
    price: result.last_close,
    change_pct: result.change_pct_24h ?? 0,
    prev_close: prev?.close ?? null,
    ts: last.ts,
  };
}
