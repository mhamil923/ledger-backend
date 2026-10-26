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

/**
 * Next scheduled earnings report within `days` (Finnhub earnings calendar).
 * Holding a swing trade through earnings turns it into a coin flip on the
 * report, so the analysis flags and caps those trades.
 */
export async function getNextEarnings(
  symbol: string,
  days = 45,
): Promise<{ date: string; hour: string | null } | null> {
  if (!config.FINNHUB_API_KEY) return null;
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const url = `${FINNHUB_BASE}/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(symbol)}&token=${config.FINNHUB_API_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { earningsCalendar?: Array<{ date: string; hour?: string; symbol: string }> };
    const next = (data.earningsCalendar ?? [])
      .filter((e) => e.symbol?.toUpperCase() === symbol.toUpperCase() && e.date >= from)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    return next ? { date: next.date, hour: next.hour || null } : null;
  } catch {
    return null;
  }
}
