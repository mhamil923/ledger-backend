import { config } from '../config.js';

export interface StockQuote {
  symbol: string;
  price: number;
  change: number;
  change_pct: number;
  prev_close: number;
  high: number;
  low: number;
  open: number;
  ts: number;
}

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

export function isFinnhubConfigured(): boolean {
  return !!config.FINNHUB_API_KEY;
}

export async function getStockQuote(symbol: string): Promise<StockQuote> {
  if (!config.FINNHUB_API_KEY) {
    throw new Error('FINNHUB_API_KEY is not configured');
  }
  const url = `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(symbol)}&token=${config.FINNHUB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Finnhub quote failed for ${symbol}: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    c: number;
    d: number;
    dp: number;
    h: number;
    l: number;
    o: number;
    pc: number;
    t: number;
  };
  if (!data || data.c === 0) {
    throw new Error(`Finnhub returned no quote for ${symbol}`);
  }
  return {
    symbol,
    price: data.c,
    change: data.d,
    change_pct: data.dp,
    prev_close: data.pc,
    high: data.h,
    low: data.l,
    open: data.o,
    ts: data.t * 1000,
  };
}
