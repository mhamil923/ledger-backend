import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { getQuotes } from '../services/quotes.js';
import { fetchFinnhubLogo } from '../services/search.js';

export const watchlistRouter = Router();

interface WatchlistRow {
  id: string;
  symbol: string;
  asset_type: 'stock' | 'crypto' | 'etf';
  display_name: string | null;
  external_id: string | null;
  logo_url: string | null;
  sort_order: number;
  created_at: Date;
}

const SELECT_COLUMNS =
  'id, symbol, asset_type, display_name, external_id, logo_url, sort_order, created_at';

watchlistRouter.get('/', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const result = await query<WatchlistRow>(
    `SELECT ${SELECT_COLUMNS} FROM watchlist_items WHERE user_id = $1 ORDER BY sort_order ASC, created_at ASC`,
    [userId],
  );
  const items = result.rows;

  const includeQuotes = req.query.quotes !== 'false';
  if (!includeQuotes || items.length === 0) {
    res.json({ items: items.map((i) => ({ ...i, quote: null, error: null })) });
    return;
  }

  const quotes = await getQuotes(
    items.map((i) => ({ symbol: i.symbol, asset_type: i.asset_type, external_id: i.external_id })),
  );
  const merged = items.map((i, idx) => ({ ...i, quote: quotes[idx]!.quote, error: quotes[idx]!.error }));
  res.json({ items: merged });
});

const addSchema = z.object({
  symbol: z.string().min(1).max(20).transform((s) => s.toUpperCase()),
  asset_type: z.enum(['stock', 'crypto', 'etf']),
  display_name: z.string().max(120).optional(),
  external_id: z.string().max(120).optional(),
  logo_url: z.string().url().max(500).optional(),
});

watchlistRouter.post('/', requireAuth, async (req, res) => {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', issues: parsed.error.issues });
    return;
  }
  const { symbol, asset_type, display_name, external_id } = parsed.data;
  let { logo_url } = parsed.data;
  const userId = req.user!.id;

  // For stocks/ETFs without a client-provided logo, try Finnhub's profile endpoint.
  if (!logo_url && (asset_type === 'stock' || asset_type === 'etf')) {
    logo_url = (await fetchFinnhubLogo(symbol)) ?? undefined;
  }

  const max = await query<{ max: number | null }>(
    'SELECT MAX(sort_order) AS max FROM watchlist_items WHERE user_id = $1',
    [userId],
  );
  const nextOrder = (max.rows[0]?.max ?? -1) + 1;

  try {
    const result = await query<WatchlistRow>(
      `INSERT INTO watchlist_items
         (user_id, symbol, asset_type, display_name, external_id, logo_url, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${SELECT_COLUMNS}`,
      [
        userId,
        symbol,
        asset_type,
        display_name ?? null,
        external_id ?? null,
        logo_url ?? null,
        nextOrder,
      ],
    );
    res.status(201).json({ item: result.rows[0] });
  } catch (err) {
    if (err instanceof Error && /duplicate key/.test(err.message)) {
      res.status(409).json({ error: 'Already in watchlist' });
      return;
    }
    throw err;
  }
});

/**
 * One-shot helper: scan the user's watchlist, fill in logo_url for any item
 * that's missing one. Uses CoinGecko's coin endpoint for crypto and Finnhub's
 * profile endpoint for stocks/ETFs.
 */
watchlistRouter.post('/refresh-logos', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const rows = await query<WatchlistRow>(
    `SELECT ${SELECT_COLUMNS} FROM watchlist_items WHERE user_id = $1 AND logo_url IS NULL`,
    [userId],
  );
  let updated = 0;
  for (let i = 0; i < rows.rows.length; i++) {
    const row = rows.rows[i]!;
    let logo: string | null = null;
    if (row.asset_type === 'crypto') {
      const coinId =
        row.external_id ??
        (await resolveCoinIdBySymbol(row.symbol));
      if (coinId) {
        logo = await fetchCoinGeckoLogo(coinId);
        if (!row.external_id) {
          await query('UPDATE watchlist_items SET external_id = $1 WHERE id = $2', [coinId, row.id]);
        }
      }
    } else {
      logo = await fetchFinnhubLogo(row.symbol);
    }
    if (logo) {
      await query('UPDATE watchlist_items SET logo_url = $1 WHERE id = $2', [logo, row.id]);
      updated++;
    }
    // Space out CoinGecko hits to stay under the free-tier 30/min cap.
    if (row.asset_type === 'crypto' && i < rows.rows.length - 1) {
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  res.json({ scanned: rows.rows.length, updated });
});

async function fetchCoinGeckoLogo(coinId: string): Promise<string | null> {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = (await r.json()) as { image?: { large?: string; small?: string; thumb?: string } };
    return data.image?.large ?? data.image?.small ?? data.image?.thumb ?? null;
  } catch {
    return null;
  }
}

async function resolveCoinIdBySymbol(symbol: string): Promise<string | null> {
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`,
    );
    if (!r.ok) return null;
    const data = (await r.json()) as { coins?: Array<{ id: string; symbol: string }> };
    // Pick the highest-ranked coin whose symbol matches exactly.
    const match = data.coins?.find((c) => c.symbol.toUpperCase() === symbol.toUpperCase());
    return match?.id ?? null;
  } catch {
    return null;
  }
}

watchlistRouter.delete('/:id', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const result = await query('DELETE FROM watchlist_items WHERE id = $1 AND user_id = $2', [
    req.params.id,
    userId,
  ]);
  if (result.rowCount === 0) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json({ ok: true });
});

const reorderSchema = z.object({
  order: z.array(z.string().uuid()).min(1),
});

watchlistRouter.post('/reorder', requireAuth, async (req, res) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }
  const userId = req.user!.id;
  await withTransaction(async (client) => {
    for (let i = 0; i < parsed.data.order.length; i++) {
      await client.query(
        'UPDATE watchlist_items SET sort_order = $1 WHERE id = $2 AND user_id = $3',
        [i, parsed.data.order[i], userId],
      );
    }
  });
  res.json({ ok: true });
});
