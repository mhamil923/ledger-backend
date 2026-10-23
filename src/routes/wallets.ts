import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import {
  WALLET_CHAINS,
  fetchWalletBalances,
  isValidAddress,
  type WalletChain,
} from '../services/wallets.js';
import { getQuote } from '../services/quotes.js';

export const walletsRouter = Router();
walletsRouter.use(requireAuth);

interface WalletRow {
  id: string;
  label: string;
  chain: WalletChain;
  address: string;
  last_synced_at: string | null;
  created_at: string;
}

interface BalanceRow {
  id: string;
  wallet_id: string;
  symbol: string;
  quantity: string;
  synced_at: string;
}

interface BalanceWithValue {
  symbol: string;
  quantity: number;
  usd_value: number | null;
  price: number | null;
  quote_error: string | null;
}

interface WalletWithBalances {
  id: string;
  label: string;
  chain: WalletChain;
  chain_label: string;
  address: string;
  last_synced_at: string | null;
  created_at: string;
  balances: BalanceWithValue[];
  total_usd_value: number;
}

async function loadBalancesWithQuotes(walletId: string): Promise<{
  balances: BalanceWithValue[];
  total: number;
}> {
  const result = await query<BalanceRow>(
    'SELECT id, wallet_id, symbol, quantity::text, synced_at::text FROM crypto_wallet_balances WHERE wallet_id = $1 ORDER BY quantity DESC',
    [walletId],
  );
  const balances: BalanceWithValue[] = [];
  let total = 0;
  for (const row of result.rows) {
    const qty = Number(row.quantity);
    let price: number | null = null;
    let usdValue: number | null = null;
    let quoteError: string | null = null;
    if (qty > 0) {
      try {
        const quote = await getQuote({ symbol: row.symbol, asset_type: 'crypto' });
        price = quote.price;
        usdValue = price * qty;
        total += usdValue;
      } catch (err) {
        quoteError = err instanceof Error ? err.message : String(err);
      }
    } else {
      usdValue = 0;
    }
    balances.push({ symbol: row.symbol, quantity: qty, usd_value: usdValue, price, quote_error: quoteError });
  }
  return { balances, total };
}

async function toWalletWithBalances(wallet: WalletRow): Promise<WalletWithBalances> {
  const { balances, total } = await loadBalancesWithQuotes(wallet.id);
  return {
    id: wallet.id,
    label: wallet.label,
    chain: wallet.chain,
    chain_label: WALLET_CHAINS[wallet.chain].label,
    address: wallet.address,
    last_synced_at: wallet.last_synced_at,
    created_at: wallet.created_at,
    balances,
    total_usd_value: total,
  };
}

walletsRouter.get('/chains', (_req, res) => {
  res.json({
    chains: Object.values(WALLET_CHAINS).map((c) => ({
      id: c.id,
      label: c.label,
      native_symbol: c.nativeSymbol,
    })),
  });
});

walletsRouter.get('/', async (req, res) => {
  const userId = req.user!.id;
  const result = await query<WalletRow>(
    `SELECT id, label, chain, address, last_synced_at::text, created_at::text
     FROM crypto_wallets WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId],
  );
  const wallets = await Promise.all(result.rows.map(toWalletWithBalances));
  const total = wallets.reduce((acc, w) => acc + w.total_usd_value, 0);
  res.json({ wallets, total_usd_value: total });
});

const addSchema = z.object({
  label: z.string().min(1).max(120),
  chain: z.enum(['ethereum', 'polygon', 'arbitrum', 'base', 'bitcoin', 'solana']),
  address: z.string().min(1).max(200),
});

walletsRouter.post('/', async (req, res) => {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', issues: parsed.error.issues });
    return;
  }
  const { label, chain, address } = parsed.data;
  if (!isValidAddress(chain, address)) {
    res.status(400).json({ error: `Address does not look like a valid ${chain} address` });
    return;
  }
  const userId = req.user!.id;
  const normalizedAddress = chain === 'bitcoin' || chain === 'solana' ? address : address.toLowerCase();

  // Fetch balance up front so we can fail fast if the address is bad / RPC unreachable
  let balances;
  try {
    balances = await fetchWalletBalances(chain, normalizedAddress);
  } catch (err) {
    res.status(502).json({
      error: 'Could not fetch wallet balance from the chain',
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  try {
    const walletId = await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO crypto_wallets (user_id, label, chain, address, last_synced_at)
         VALUES ($1, $2, $3, $4, now()) RETURNING id`,
        [userId, label, chain, normalizedAddress],
      );
      const id = inserted.rows[0]!.id;
      for (const b of balances) {
        await client.query(
          `INSERT INTO crypto_wallet_balances (wallet_id, symbol, quantity)
           VALUES ($1, $2, $3)`,
          [id, b.symbol, b.quantity],
        );
      }
      return id;
    });
    const walletRow = (
      await query<WalletRow>(
        `SELECT id, label, chain, address, last_synced_at::text, created_at::text
         FROM crypto_wallets WHERE id = $1`,
        [walletId],
      )
    ).rows[0]!;
    res.status(201).json(await toWalletWithBalances(walletRow));
  } catch (err) {
    if (err instanceof Error && /duplicate key/.test(err.message)) {
      res.status(409).json({ error: 'You already have a wallet for that chain and address.' });
      return;
    }
    throw err;
  }
});

walletsRouter.post('/:id/sync', async (req, res) => {
  const userId = req.user!.id;
  const wallet = (
    await query<WalletRow>(
      `SELECT id, label, chain, address, last_synced_at::text, created_at::text
       FROM crypto_wallets WHERE id = $1 AND user_id = $2`,
      [req.params.id, userId],
    )
  ).rows[0];
  if (!wallet) {
    res.status(404).json({ error: 'Wallet not found' });
    return;
  }

  let balances;
  try {
    balances = await fetchWalletBalances(wallet.chain, wallet.address);
  } catch (err) {
    res.status(502).json({
      error: 'Could not fetch wallet balance',
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  await withTransaction(async (client) => {
    for (const b of balances) {
      await client.query(
        `INSERT INTO crypto_wallet_balances (wallet_id, symbol, quantity, synced_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (wallet_id, symbol)
         DO UPDATE SET quantity = EXCLUDED.quantity, synced_at = now()`,
        [wallet.id, b.symbol, b.quantity],
      );
    }
    await client.query(
      'UPDATE crypto_wallets SET last_synced_at = now() WHERE id = $1',
      [wallet.id],
    );
  });

  const refreshed = (
    await query<WalletRow>(
      `SELECT id, label, chain, address, last_synced_at::text, created_at::text
       FROM crypto_wallets WHERE id = $1`,
      [wallet.id],
    )
  ).rows[0]!;
  res.json(await toWalletWithBalances(refreshed));
});

walletsRouter.delete('/:id', async (req, res) => {
  const userId = req.user!.id;
  const result = await query('DELETE FROM crypto_wallets WHERE id = $1 AND user_id = $2', [
    req.params.id,
    userId,
  ]);
  if (result.rowCount === 0) {
    res.status(404).json({ error: 'Wallet not found' });
    return;
  }
  res.json({ ok: true });
});
