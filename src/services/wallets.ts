// Public-RPC wallet balance reads. No API keys required.
// Native-asset only for v1 — ERC-20 / SPL token balances would require an indexer (Alchemy, Etherscan, Helius).

export type WalletChain =
  | 'ethereum'
  | 'polygon'
  | 'arbitrum'
  | 'base'
  | 'bitcoin'
  | 'solana';

export interface WalletChainMeta {
  id: WalletChain;
  label: string;
  nativeSymbol: string;
  addressPattern: RegExp;
}

export const WALLET_CHAINS: Record<WalletChain, WalletChainMeta> = {
  ethereum: {
    id: 'ethereum',
    label: 'Ethereum',
    nativeSymbol: 'ETH',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  polygon: {
    id: 'polygon',
    label: 'Polygon',
    nativeSymbol: 'MATIC',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  arbitrum: {
    id: 'arbitrum',
    label: 'Arbitrum',
    nativeSymbol: 'ETH',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  base: {
    id: 'base',
    label: 'Base',
    nativeSymbol: 'ETH',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  bitcoin: {
    id: 'bitcoin',
    label: 'Bitcoin',
    nativeSymbol: 'BTC',
    addressPattern: /^(bc1[a-z0-9]{6,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
  },
  solana: {
    id: 'solana',
    label: 'Solana',
    nativeSymbol: 'SOL',
    addressPattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  },
};

const EVM_RPCS: Record<string, string> = {
  ethereum: 'https://ethereum.publicnode.com',
  polygon: 'https://polygon-rpc.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  base: 'https://mainnet.base.org',
};

const EVM_DECIMALS = 18;
const BTC_SATOSHI = 1e8;
const SOL_LAMPORT = 1e9;

export interface WalletBalance {
  symbol: string;
  quantity: number;
}

export function isValidAddress(chain: WalletChain, address: string): boolean {
  return WALLET_CHAINS[chain].addressPattern.test(address.trim());
}

export async function fetchWalletBalances(
  chain: WalletChain,
  address: string,
): Promise<WalletBalance[]> {
  switch (chain) {
    case 'ethereum':
    case 'polygon':
    case 'arbitrum':
    case 'base':
      return fetchEvmBalance(chain, address);
    case 'bitcoin':
      return fetchBitcoinBalance(address);
    case 'solana':
      return fetchSolanaBalance(address);
  }
}

async function fetchEvmBalance(chain: string, address: string): Promise<WalletBalance[]> {
  const rpc = EVM_RPCS[chain];
  if (!rpc) throw new Error(`No RPC configured for ${chain}`);
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBalance',
      params: [address, 'latest'],
    }),
  });
  if (!res.ok) throw new Error(`${chain} RPC failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { result?: string; error?: { message: string } };
  if (data.error) throw new Error(`${chain} RPC error: ${data.error.message}`);
  if (!data.result) throw new Error(`${chain} RPC returned no result`);
  const wei = BigInt(data.result);
  const native = Number(wei) / 10 ** EVM_DECIMALS;
  const symbol = WALLET_CHAINS[chain as WalletChain].nativeSymbol;
  return [{ symbol, quantity: native }];
}

async function fetchBitcoinBalance(address: string): Promise<WalletBalance[]> {
  const res = await fetch(`https://mempool.space/api/address/${encodeURIComponent(address)}`);
  if (!res.ok) {
    if (res.status === 400) throw new Error('Invalid Bitcoin address');
    throw new Error(`Bitcoin API failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    chain_stats?: { funded_txo_sum: number; spent_txo_sum: number };
    mempool_stats?: { funded_txo_sum: number; spent_txo_sum: number };
  };
  const confirmed =
    (data.chain_stats?.funded_txo_sum ?? 0) - (data.chain_stats?.spent_txo_sum ?? 0);
  const unconfirmed =
    (data.mempool_stats?.funded_txo_sum ?? 0) - (data.mempool_stats?.spent_txo_sum ?? 0);
  const sats = confirmed + unconfirmed;
  const btc = sats / BTC_SATOSHI;
  return [{ symbol: 'BTC', quantity: btc }];
}

async function fetchSolanaBalance(address: string): Promise<WalletBalance[]> {
  const res = await fetch('https://api.mainnet-beta.solana.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [address],
    }),
  });
  if (!res.ok) throw new Error(`Solana RPC failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as {
    result?: { value: number };
    error?: { message: string };
  };
  if (data.error) throw new Error(`Solana RPC error: ${data.error.message}`);
  if (!data.result) throw new Error('Solana RPC returned no result');
  const sol = data.result.value / SOL_LAMPORT;
  return [{ symbol: 'SOL', quantity: sol }];
}
