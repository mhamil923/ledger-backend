import { config } from '../config.js';

export type AssetType = 'stock' | 'crypto' | 'etf';

export interface AssetSearchResult {
  symbol: string;
  name: string;
  asset_type: AssetType;
  external_id: string | null;
  source: 'coingecko' | 'finnhub';
  rank: number | null;
  exchange: string | null;
  logo_url: string | null;
}

const COINGECKO_SEARCH = 'https://api.coingecko.com/api/v3/search';
const COINGECKO_PRO_SEARCH = 'https://pro-api.coingecko.com/api/v3/search';
const FINNHUB_SEARCH = 'https://finnhub.io/api/v1/search';

interface CoinGeckoSearchResponse {
  coins: Array<{
    id: string;
    name: string;
    symbol: string;
    market_cap_rank: number | null;
    /** Small icon URL — perfect for our 32×32 list rows. */
    thumb?: string;
    /** Larger version for high-DPI rendering if we want it later. */
    large?: string;
  }>;
}

interface FinnhubSearchResponse {
  count: number;
  result: Array<{
    description: string;
    displaySymbol: string;
    symbol: string;
    type: string;
  }>;
}

async function searchCoinGecko(query: string): Promise<AssetSearchResult[]> {
  const url = config.COINGECKO_API_KEY ? COINGECKO_PRO_SEARCH : COINGECKO_SEARCH;
  const headers: Record<string, string> = config.COINGECKO_API_KEY
    ? { 'x-cg-pro-api-key': config.COINGECKO_API_KEY }
    : {};
  const res = await fetch(`${url}?query=${encodeURIComponent(query)}`, { headers });
  if (!res.ok) throw new Error(`CoinGecko search failed: ${res.status}`);
  const data = (await res.json()) as CoinGeckoSearchResponse;
  return (data.coins ?? []).slice(0, 12).map((c) => ({
    symbol: c.symbol.toUpperCase(),
    name: c.name,
    asset_type: 'crypto' as const,
    external_id: c.id,
    source: 'coingecko' as const,
    rank: c.market_cap_rank,
    exchange: null,
    logo_url: c.large ?? c.thumb ?? null,
  }));
}

async function searchFinnhub(query: string): Promise<AssetSearchResult[]> {
  if (!config.FINNHUB_API_KEY) return [];
  const url = `${FINNHUB_SEARCH}?q=${encodeURIComponent(query)}&token=${config.FINNHUB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub search failed: ${res.status}`);
  const data = (await res.json()) as FinnhubSearchResponse;
  return (data.result ?? [])
    .slice(0, 12)
    .filter((r) => !r.symbol.includes('.')) // Skip exchange-suffixed dupes for cleaner UX
    .map((r) => {
      const isEtf = /etf/i.test(r.type) || /ETF/.test(r.description);
      return {
        symbol: r.displaySymbol || r.symbol,
        name: r.description,
        asset_type: (isEtf ? 'etf' : 'stock') as AssetType,
        external_id: null, // Finnhub uses the symbol directly for quote lookups
        source: 'finnhub' as const,
        rank: null,
        exchange: r.type || null,
        // Finnhub search doesn't return logos. We fetch them lazily via
        // company-profile2 when adding to the watchlist.
        logo_url: null,
      };
    });
}

interface FinnhubProfile {
  logo?: string;
  name?: string;
  ticker?: string;
  finnhubIndustry?: string;
}

/** Best-effort logo lookup for a stock/ETF via Finnhub's company-profile2 endpoint. */
export async function fetchFinnhubLogo(symbol: string): Promise<string | null> {
  if (!config.FINNHUB_API_KEY) return null;
  try {
    const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${config.FINNHUB_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as FinnhubProfile;
    return data.logo ?? null;
  } catch {
    return null;
  }
}

export interface SearchOptions {
  query: string;
  types?: AssetType[];
}

/**
 * Curated commodity / sector ETF index so that searching natural-language
 * keywords like "gold" or "silver" returns the obvious tradeable instruments.
 * Finnhub's search only matches on ticker/company-name and tends to miss
 * these — without this index, "gold" returns nothing useful.
 */
interface CuratedEtf {
  symbol: string;
  name: string;
  keywords: string[];
}
const CURATED_COMMODITY_ETFS: CuratedEtf[] = [
  { symbol: 'GLD', name: 'SPDR Gold Shares', keywords: ['gold', 'gld', 'precious metal', 'bullion'] },
  { symbol: 'IAU', name: 'iShares Gold Trust', keywords: ['gold', 'iau', 'precious metal'] },
  { symbol: 'SGOL', name: 'abrdn Physical Gold Shares ETF', keywords: ['gold', 'sgol'] },
  { symbol: 'GLDM', name: 'SPDR Gold MiniShares Trust', keywords: ['gold', 'gldm'] },
  { symbol: 'BAR', name: 'GraniteShares Gold Trust', keywords: ['gold', 'bar'] },
  { symbol: 'SLV', name: 'iShares Silver Trust', keywords: ['silver', 'slv', 'precious metal'] },
  { symbol: 'SIVR', name: 'abrdn Physical Silver Shares ETF', keywords: ['silver', 'sivr'] },
  { symbol: 'PPLT', name: 'abrdn Physical Platinum Shares ETF', keywords: ['platinum', 'pplt', 'precious metal'] },
  { symbol: 'PALL', name: 'abrdn Physical Palladium Shares ETF', keywords: ['palladium', 'pall', 'precious metal'] },
  { symbol: 'USO', name: 'United States Oil Fund', keywords: ['oil', 'uso', 'crude', 'wti', 'energy'] },
  { symbol: 'BNO', name: 'United States Brent Oil Fund', keywords: ['oil', 'bno', 'brent', 'crude', 'energy'] },
  { symbol: 'UNG', name: 'United States Natural Gas Fund', keywords: ['natural gas', 'ung', 'gas', 'energy'] },
  { symbol: 'URA', name: 'Global X Uranium ETF', keywords: ['uranium', 'ura', 'nuclear', 'energy'] },
  { symbol: 'URNM', name: 'Sprott Uranium Miners ETF', keywords: ['uranium', 'urnm', 'nuclear'] },
  { symbol: 'DBC', name: 'Invesco DB Commodity Index Tracking Fund', keywords: ['commodities', 'dbc', 'broad commodity'] },
  { symbol: 'PDBC', name: 'Invesco Optimum Yield Diversified Commodity Strategy', keywords: ['commodities', 'pdbc'] },
  { symbol: 'GSG', name: 'iShares S&P GSCI Commodity-Indexed Trust', keywords: ['commodities', 'gsg'] },
  { symbol: 'COPX', name: 'Global X Copper Miners ETF', keywords: ['copper', 'copx', 'mining'] },
  { symbol: 'WEAT', name: 'Teucrium Wheat Fund', keywords: ['wheat', 'weat', 'agriculture'] },
  { symbol: 'CORN', name: 'Teucrium Corn Fund', keywords: ['corn', 'agriculture'] },
];

function searchCuratedEtfs(query: string): AssetSearchResult[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return CURATED_COMMODITY_ETFS.filter((etf) => {
    if (etf.symbol.toLowerCase() === q) return true;
    return etf.keywords.some((k) => k.includes(q) || q.includes(k));
  }).map((etf) => ({
    symbol: etf.symbol,
    name: etf.name,
    asset_type: 'etf' as AssetType,
    external_id: null,
    source: 'finnhub' as const,
    rank: null,
    exchange: 'NYSE Arca',
    logo_url: null,
  }));
}

export async function searchAssets(
  options: SearchOptions,
): Promise<{ results: AssetSearchResult[]; sources: { coingecko: boolean; finnhub: boolean } }> {
  const query = options.query.trim();
  const wantCrypto = !options.types || options.types.includes('crypto');
  const wantStockEtf = !options.types || options.types.some((t) => t === 'stock' || t === 'etf');

  const [cgRaw, fhRaw] = await Promise.allSettled([
    wantCrypto ? searchCoinGecko(query) : Promise.resolve([]),
    wantStockEtf ? searchFinnhub(query) : Promise.resolve([]),
  ]);

  const cg = cgRaw.status === 'fulfilled' ? cgRaw.value : [];
  const fh = fhRaw.status === 'fulfilled' ? fhRaw.value : [];
  // Curated commodity ETFs (gold/silver/oil/etc.) — prepended so they show
  // up first when a keyword matches. Skip if the caller asked for crypto only.
  const curated = wantStockEtf ? searchCuratedEtfs(query) : [];

  // Interleave: best crypto, best stock, then alternating to keep both kinds visible
  const merged: AssetSearchResult[] = [...curated];
  const seenSymbols = new Set(curated.map((c) => `${c.asset_type}:${c.symbol}`));
  const max = Math.max(cg.length, fh.length);
  for (let i = 0; i < max; i++) {
    const c = cg[i];
    if (c && !seenSymbols.has(`${c.asset_type}:${c.symbol}`)) {
      merged.push(c);
      seenSymbols.add(`${c.asset_type}:${c.symbol}`);
    }
    const s = fh[i];
    if (s && !seenSymbols.has(`${s.asset_type}:${s.symbol}`)) {
      merged.push(s);
      seenSymbols.add(`${s.asset_type}:${s.symbol}`);
    }
  }

  return {
    results: merged.slice(0, 20),
    sources: {
      coingecko: cgRaw.status === 'fulfilled',
      finnhub: fhRaw.status === 'fulfilled' && !!config.FINNHUB_API_KEY,
    },
  };
}
