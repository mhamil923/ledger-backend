import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config.js';

// Coinbase Advanced Trade API — real-money order placement.
//
// Auth: CDP API keys (the newer ECDSA key style). Every request signs a short-lived
// JWT (ES256) over the request URI. See:
// https://docs.cdp.coinbase.com/advanced-trade/docs/auth

const BASE = 'https://api.coinbase.com';

export function isCoinbaseTradeConfigured(): boolean {
  return !!config.COINBASE_API_KEY_NAME && !!config.COINBASE_API_PRIVATE_KEY;
}

interface JwtClaims {
  sub: string;
  iss: string;
  nbf: number;
  exp: number;
  uri: string;
}

function buildJwt(method: string, path: string): string {
  if (!config.COINBASE_API_KEY_NAME || !config.COINBASE_API_PRIVATE_KEY) {
    throw new Error('Coinbase trading credentials not configured');
  }
  const now = Math.floor(Date.now() / 1000);
  // Coinbase requires the URI claim to omit any query string — only the
  // METHOD + HOST + PATH up to the "?". Including `?limit=250` etc. causes
  // signature mismatch → 401 Unauthorized.
  const pathNoQuery = path.split('?')[0]!;
  const claims: JwtClaims = {
    sub: config.COINBASE_API_KEY_NAME,
    iss: 'cdp',
    nbf: now,
    exp: now + 120, // 2-minute window
    uri: `${method} ${BASE.replace('https://', '')}${pathNoQuery}`,
  };
  return jwt.sign(claims, config.COINBASE_API_PRIVATE_KEY, {
    algorithm: 'ES256',
    header: {
      alg: 'ES256',
      kid: config.COINBASE_API_KEY_NAME,
      nonce: crypto.randomBytes(16).toString('hex'),
      typ: 'JWT',
    } as jwt.JwtHeader,
  });
}

async function coinbaseFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = buildJwt(method, path);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Coinbase ${path} failed: ${res.status} ${res.statusText} — ${text.slice(0, 400)}`);
  }
  return (await res.json()) as T;
}

export interface CoinbaseAccount {
  uuid: string;
  name: string;
  currency: string;
  available_balance: { value: string; currency: string };
  hold: { value: string; currency: string };
  active: boolean;
  type: string;
  ready: boolean;
}

interface AccountsResponse {
  accounts: CoinbaseAccount[];
  has_next: boolean;
  cursor: string;
  size: number;
}

export interface CoinbasePortfolio {
  uuid: string;
  name: string;
  type: string;
  deleted?: boolean;
}

interface PortfoliosResponse {
  portfolios: CoinbasePortfolio[];
}

export async function listCoinbasePortfolios(): Promise<CoinbasePortfolio[]> {
  const data = await coinbaseFetch<PortfoliosResponse>('GET', '/api/v3/brokerage/portfolios');
  return data.portfolios ?? [];
}

export async function listCoinbaseAccounts(): Promise<CoinbaseAccount[]> {
  // Coinbase lists hundreds of currencies as "accounts" (most at zero balance),
  // so a single page of 250 misses anything alphabetically later. Paginate the
  // full list until `has_next` is false. Cap at 10 pages (2,500 entries) as a
  // safety net — Coinbase supports ~400 currencies today, so this is plenty.
  const out: CoinbaseAccount[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ limit: '250' });
    if (cursor) qs.set('cursor', cursor);
    const data = await coinbaseFetch<AccountsResponse>(
      'GET',
      `/api/v3/brokerage/accounts?${qs.toString()}`,
    );
    if (data.accounts?.length) out.push(...data.accounts);
    if (!data.has_next || !data.cursor) break;
    cursor = data.cursor;
  }
  return out;
}

export interface CoinbaseOrderInput {
  /** "BTC-USD", "ETH-USD", etc. */
  product_id: string;
  side: 'BUY' | 'SELL';
  /** Base currency size (e.g. 0.001 BTC) — exactly one of base_size or quote_size required. */
  base_size?: string;
  /** Quote currency size (e.g. 100 USD) — for market BUY only. */
  quote_size?: string;
  /** Limit price. Omit for market orders. */
  limit_price?: string;
  /** Stop price for stop-limit orders. */
  stop_price?: string;
  client_order_id: string;
}

interface CoinbaseOrderConfig {
  market_market_ioc?: { base_size?: string; quote_size?: string };
  limit_limit_gtc?: { base_size: string; limit_price: string; post_only?: boolean };
  stop_limit_stop_limit_gtc?: {
    base_size: string;
    limit_price: string;
    stop_price: string;
    stop_direction: 'STOP_DIRECTION_STOP_UP' | 'STOP_DIRECTION_STOP_DOWN';
  };
}

export interface CoinbaseOrderResponse {
  success: boolean;
  failure_reason?: string;
  order_id?: string;
  success_response?: { order_id: string; product_id: string; side: string; client_order_id: string };
  error_response?: { error: string; message: string; error_details: string };
}

/**
 * Place a single order on Coinbase. Coinbase Advanced Trade does NOT support
 * native bracket orders. We submit the entry; the caller is responsible for
 * placing separate stop/target orders after the fill (or doing them manually).
 */
export async function placeCoinbaseOrder(input: CoinbaseOrderInput): Promise<CoinbaseOrderResponse> {
  let order_configuration: CoinbaseOrderConfig;
  if (input.limit_price) {
    if (input.stop_price) {
      const stopDirection =
        input.side === 'BUY' ? 'STOP_DIRECTION_STOP_UP' : 'STOP_DIRECTION_STOP_DOWN';
      order_configuration = {
        stop_limit_stop_limit_gtc: {
          base_size: input.base_size ?? '0',
          limit_price: input.limit_price,
          stop_price: input.stop_price,
          stop_direction: stopDirection,
        },
      };
    } else {
      order_configuration = {
        limit_limit_gtc: {
          base_size: input.base_size ?? '0',
          limit_price: input.limit_price,
        },
      };
    }
  } else {
    order_configuration = {
      market_market_ioc:
        input.side === 'BUY'
          ? { quote_size: input.quote_size ?? input.base_size ?? '0' }
          : { base_size: input.base_size ?? '0' },
    };
  }
  return coinbaseFetch<CoinbaseOrderResponse>('POST', '/api/v3/brokerage/orders', {
    client_order_id: input.client_order_id,
    product_id: input.product_id,
    side: input.side,
    order_configuration,
  });
}
