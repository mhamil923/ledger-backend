import { config } from '../config.js';

// Alpaca REST API for stock/ETF trade execution.
// Paper trading is fake-money with real market data; live is real money.
// Same endpoints + auth shape, different base URLs.

export type AlpacaEnv = 'paper' | 'live';

const BASE_URLS: Record<AlpacaEnv, string> = {
  paper: 'https://paper-api.alpaca.markets',
  live: 'https://api.alpaca.markets',
};

interface Credentials {
  key: string;
  secret: string;
}

function credentialsFor(env: AlpacaEnv): Credentials | null {
  if (env === 'paper') {
    if (!config.ALPACA_PAPER_API_KEY || !config.ALPACA_PAPER_API_SECRET) return null;
    return { key: config.ALPACA_PAPER_API_KEY, secret: config.ALPACA_PAPER_API_SECRET };
  }
  if (!config.ALPACA_LIVE_API_KEY || !config.ALPACA_LIVE_API_SECRET) return null;
  return { key: config.ALPACA_LIVE_API_KEY, secret: config.ALPACA_LIVE_API_SECRET };
}

export function isAlpacaConfigured(env: AlpacaEnv): boolean {
  return !!credentialsFor(env);
}

async function alpacaFetch<T>(env: AlpacaEnv, path: string, init: RequestInit = {}): Promise<T> {
  const creds = credentialsFor(env);
  if (!creds) throw new Error(`Alpaca ${env} credentials not configured`);
  const res = await fetch(`${BASE_URLS[env]}${path}`, {
    ...init,
    headers: {
      'APCA-API-KEY-ID': creds.key,
      'APCA-API-SECRET-KEY': creds.secret,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca ${path} failed: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export interface AlpacaAccount {
  id: string;
  account_number: string;
  status: string;
  currency: string;
  cash: string;
  buying_power: string;
  equity: string;
  last_equity: string;
  pattern_day_trader: boolean;
  trading_blocked: boolean;
  transfers_blocked: boolean;
  account_blocked: boolean;
}

export async function getAlpacaAccount(env: AlpacaEnv): Promise<AlpacaAccount> {
  return alpacaFetch<AlpacaAccount>(env, '/v2/account');
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  side: 'long' | 'short';
  avg_entry_price: string;
  current_price: string | null;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
}

export async function getAlpacaPositions(env: AlpacaEnv): Promise<AlpacaPosition[]> {
  return alpacaFetch<AlpacaPosition[]>(env, '/v2/positions');
}

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  status: string;
  symbol: string;
  side: string;
  qty: string;
  filled_qty: string;
  filled_avg_price: string | null;
  type: string;
  time_in_force: string;
  limit_price: string | null;
  stop_price: string | null;
  legs?: AlpacaOrder[] | null;
  created_at: string;
  updated_at: string;
}

export interface BracketOrderInput {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  /** Limit price for the entry leg. */
  limit_price: number;
  stop_loss: number;
  /** First take-profit price. Alpaca brackets only accept one target. */
  take_profit: number;
  /** day | gtc. Use 'gtc' for trades that should sit open until filled/cancelled. */
  time_in_force?: 'day' | 'gtc';
  client_order_id?: string;
}

/**
 * Place a bracket order: a limit entry with attached take-profit and stop-loss
 * legs. All three are submitted as a single atomic order class so the legs
 * cancel each other after a fill.
 */
export async function placeAlpacaBracketOrder(
  env: AlpacaEnv,
  input: BracketOrderInput,
): Promise<AlpacaOrder> {
  return alpacaFetch<AlpacaOrder>(env, '/v2/orders', {
    method: 'POST',
    body: JSON.stringify({
      symbol: input.symbol.toUpperCase(),
      qty: input.qty,
      side: input.side,
      type: 'limit',
      limit_price: input.limit_price,
      time_in_force: input.time_in_force ?? 'gtc',
      order_class: 'bracket',
      take_profit: { limit_price: input.take_profit },
      stop_loss: { stop_price: input.stop_loss },
      client_order_id: input.client_order_id,
    }),
  });
}

/** Cancel a single order by id. */
export async function cancelAlpacaOrder(env: AlpacaEnv, orderId: string): Promise<void> {
  await alpacaFetch<unknown>(env, `/v2/orders/${orderId}`, { method: 'DELETE' });
}
