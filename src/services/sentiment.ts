import type { MarketSentiment } from './indicators.js';

// Free, no key required. Updates daily.
const ENDPOINT = 'https://api.alternative.me/fng/?limit=1';

// 1-hour cache is plenty — the index only updates once per day.
let cached: { expires: number; data: MarketSentiment } | null = null;
const TTL_MS = 60 * 60_000;

interface AlternativeMeResponse {
  data?: Array<{ value: string; value_classification: string; timestamp: string; time_until_update?: string }>;
}

/**
 * Fetches the Crypto Fear & Greed Index. Returns `null` if the source is
 * unreachable (we don't want analysis to fail just because sentiment is down).
 */
export async function getCryptoFearGreed(): Promise<MarketSentiment | null> {
  const now = Date.now();
  if (cached && cached.expires > now) return cached.data;
  try {
    const res = await fetch(ENDPOINT);
    if (!res.ok) return null;
    const json = (await res.json()) as AlternativeMeResponse;
    const entry = json.data?.[0];
    if (!entry) return null;
    const value = parseInt(entry.value, 10);
    if (Number.isNaN(value)) return null;
    const data: MarketSentiment = {
      fear_greed_index: value,
      fear_greed_label: entry.value_classification,
      source: 'alternative.me',
      ts: parseInt(entry.timestamp, 10) * 1000,
    };
    cached = { expires: now + TTL_MS, data };
    return data;
  } catch {
    return null;
  }
}
