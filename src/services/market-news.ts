// Market news feed (Finnhub, free tier): general market + crypto headlines,
// plus company news for the stocks on your watchlist. Each story is tagged
// with the watchlist symbols it mentions.

import { config } from '../config.js';
import { query } from '../db.js';

export interface NewsItem {
  id: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  image: string | null;
  at: string;
  category: 'market' | 'crypto' | 'company';
  symbols: string[];
}

interface FinnhubNews {
  id: number;
  headline: string;
  summary: string;
  source: string;
  url: string;
  image?: string;
  datetime: number;
  related?: string;
  category?: string;
}

const cache = new Map<string, { at: number; rows: FinnhubNews[] }>();

async function finnhub(path: string, ttlMs: number): Promise<FinnhubNews[]> {
  if (!config.FINNHUB_API_KEY) return [];
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.rows;
  try {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`https://finnhub.io/api/v1${path}${sep}token=${config.FINNHUB_API_KEY}`);
    if (!res.ok) return hit?.rows ?? [];
    const rows = (await res.json()) as FinnhubNews[];
    if (!Array.isArray(rows)) return hit?.rows ?? [];
    cache.set(path, { at: Date.now(), rows });
    return rows;
  } catch {
    return hit?.rows ?? [];
  }
}

// Common names so "Stellar" tags XLM, "Hedera" tags HBAR, etc.
const CRYPTO_NAMES: Record<string, string[]> = {
  BTC: ['bitcoin'], ETH: ['ethereum', 'ether'], SOL: ['solana'], XRP: ['ripple', 'xrp'], ADA: ['cardano'],
  DOGE: ['dogecoin'], XLM: ['stellar', 'xlm'], HBAR: ['hedera', 'hbar'], AVAX: ['avalanche'], LINK: ['chainlink'],
  DOT: ['polkadot'], LTC: ['litecoin'], SHIB: ['shiba inu'], SUI: ['sui network', ' sui '], ALGO: ['algorand'],
  MATIC: ['polygon'], POL: ['polygon'], ONDO: ['ondo'], PEPE: ['pepe'], BCH: ['bitcoin cash'], NEAR: ['near protocol'],
};

function tagger(watch: Array<{ symbol: string; display_name: string | null }>): (text: string) => string[] {
  const pats = watch.map((w) => {
    const sym = w.symbol.toUpperCase();
    const words = [sym, ...(CRYPTO_NAMES[sym] ?? [])];
    if (w.display_name && w.display_name.length > 3) words.push(w.display_name.split(/[ ,.]/)[0]!);
    const esc = words.map((x) => x.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter((x) => x.length >= 2);
    return { sym, re: new RegExp(`(^|[^A-Za-z])(${esc.join('|')})(?=[^A-Za-z]|$)`, 'i'), short: sym.length <= 3 };
  });
  return (text) =>
    pats
      .filter((p) => {
        // 2–3 letter tickers must match in capitals ("SOL", not "sol"), names any case.
        const re = new RegExp(p.re.source, 'gi');
        for (const m of text.matchAll(re)) {
          const hit = m[2]!;
          if (!p.short || hit.toUpperCase() !== p.sym || hit === p.sym) return true;
        }
        return false;
      })
      .map((p) => p.sym);
}

export async function getMarketNews(userId: string, limit = 60): Promise<NewsItem[]> {
  const watch = (
    await query<{ symbol: string; asset_type: string; display_name: string | null }>(
      `SELECT DISTINCT ON (upper(symbol)) upper(symbol) AS symbol, asset_type, display_name
       FROM watchlist_items WHERE user_id = $1`,
      [userId],
    ).catch(() => ({ rows: [] as Array<{ symbol: string; asset_type: string; display_name: string | null }> }))
  ).rows;
  const tag = tagger(watch);

  const from = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const stocks = watch.filter((w) => w.asset_type !== 'crypto').slice(0, 10);
  const [general, crypto, ...company] = await Promise.all([
    finnhub('/news?category=general', 10 * 60_000),
    finnhub('/news?category=crypto', 10 * 60_000),
    ...stocks.map((s) => finnhub(`/company-news?symbol=${encodeURIComponent(s.symbol)}&from=${from}&to=${to}`, 30 * 60_000)),
  ]);

  const out = new Map<string, NewsItem>();
  const add = (r: FinnhubNews, category: NewsItem['category'], forced?: string): void => {
    if (!r?.headline || !r.url) return;
    const key = r.url;
    const syms = new Set(tag(`${r.headline} ${r.summary ?? ''}`));
    if (forced) syms.add(forced);
    const prev = out.get(key);
    if (prev) {
      for (const s of syms) if (!prev.symbols.includes(s)) prev.symbols.push(s);
      return;
    }
    out.set(key, {
      id: String(r.id ?? key),
      headline: r.headline,
      summary: (r.summary ?? '').slice(0, 400),
      source: r.source,
      url: r.url,
      image: r.image || null,
      at: new Date(r.datetime * 1000).toISOString(),
      category,
      symbols: [...syms],
    });
  };
  general.forEach((r) => add(r, 'market'));
  crypto.forEach((r) => add(r, 'crypto'));
  company.forEach((rows, i) => rows.slice(0, 8).forEach((r) => add(r, 'company', stocks[i]!.symbol)));

  return [...out.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
