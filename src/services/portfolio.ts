import { query } from '../db.js';
import { getQuotes } from './quotes.js';

export interface LotRow {
  id: string;
  holding_id: string;
  quantity: string;
  cost_per_unit: string;
  acquired_at: string;
  notes: string | null;
  created_at: string;
}

export interface HoldingRow {
  id: string;
  user_id: string;
  symbol: string;
  asset_type: 'stock' | 'crypto' | 'etf';
  notes: string | null;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface HoldingSummary {
  id: string;
  symbol: string;
  asset_type: 'stock' | 'crypto' | 'etf';
  notes: string | null;
  total_quantity: number;
  total_cost: number;
  avg_cost: number;
  current_price: number | null;
  market_value: number | null;
  unrealized_pl: number | null;
  unrealized_pl_pct: number | null;
  quote_error: string | null;
  lot_count: number;
}

export interface PortfolioTotals {
  total_value: number;
  total_cost: number;
  unrealized_pl: number;
  unrealized_pl_pct: number;
  priced_value: number;
  unpriced_holdings: number;
}

export async function listHoldingsForUser(userId: string): Promise<{
  holdings: HoldingSummary[];
  totals: PortfolioTotals;
}> {
  const result = await query<{
    id: string;
    symbol: string;
    asset_type: 'stock' | 'crypto' | 'etf';
    notes: string | null;
    external_id: string | null;
    total_quantity: string;
    total_cost: string;
    lot_count: string;
  }>(
    `SELECT
       h.id,
       h.symbol,
       h.asset_type,
       h.notes,
       h.external_id,
       COALESCE(SUM(l.quantity), 0)::text AS total_quantity,
       COALESCE(SUM(l.quantity * l.cost_per_unit), 0)::text AS total_cost,
       COUNT(l.id)::text AS lot_count
     FROM holdings h
     LEFT JOIN holding_lots l ON l.holding_id = h.id
     WHERE h.user_id = $1
     GROUP BY h.id
     ORDER BY h.created_at ASC`,
    [userId],
  );

  if (result.rows.length === 0) {
    return {
      holdings: [],
      totals: {
        total_value: 0,
        total_cost: 0,
        unrealized_pl: 0,
        unrealized_pl_pct: 0,
        priced_value: 0,
        unpriced_holdings: 0,
      },
    };
  }

  const quotes = await getQuotes(
    result.rows.map((r) => ({
      symbol: r.symbol,
      asset_type: r.asset_type,
      external_id: r.external_id,
    })),
  );

  const holdings: HoldingSummary[] = result.rows.map((row, idx) => {
    const quantity = Number(row.total_quantity);
    const totalCost = Number(row.total_cost);
    const avgCost = quantity > 0 ? totalCost / quantity : 0;
    const quote = quotes[idx]!.quote;
    const price = quote?.price ?? null;
    const marketValue = price != null ? price * quantity : null;
    const pl = marketValue != null ? marketValue - totalCost : null;
    const plPct = pl != null && totalCost > 0 ? (pl / totalCost) * 100 : null;
    return {
      id: row.id,
      symbol: row.symbol,
      asset_type: row.asset_type,
      notes: row.notes,
      total_quantity: quantity,
      total_cost: totalCost,
      avg_cost: avgCost,
      current_price: price,
      market_value: marketValue,
      unrealized_pl: pl,
      unrealized_pl_pct: plPct,
      quote_error: quotes[idx]!.error,
      lot_count: Number(row.lot_count),
    };
  });

  const totals = computeTotals(holdings);
  return { holdings, totals };
}

export function computeTotals(holdings: HoldingSummary[]): PortfolioTotals {
  let totalValue = 0;
  let pricedValue = 0;
  let totalCost = 0;
  let unpriced = 0;
  for (const h of holdings) {
    totalCost += h.total_cost;
    if (h.market_value != null) {
      totalValue += h.market_value;
      pricedValue += h.market_value;
    } else {
      // Fall back to cost basis for unpriced holdings so the total isn't misleading
      totalValue += h.total_cost;
      unpriced++;
    }
  }
  const pl = pricedValue > 0 ? pricedValue - holdingsCostWithPricing(holdings) : 0;
  const costForPriced = holdingsCostWithPricing(holdings);
  const plPct = costForPriced > 0 ? (pl / costForPriced) * 100 : 0;
  return {
    total_value: totalValue,
    total_cost: totalCost,
    unrealized_pl: pl,
    unrealized_pl_pct: plPct,
    priced_value: pricedValue,
    unpriced_holdings: unpriced,
  };
}

function holdingsCostWithPricing(holdings: HoldingSummary[]): number {
  return holdings.filter((h) => h.market_value != null).reduce((acc, h) => acc + h.total_cost, 0);
}

export async function getHoldingWithLots(
  userId: string,
  holdingId: string,
): Promise<{ holding: HoldingSummary; lots: LotRow[] } | null> {
  const holdingResult = await query<HoldingRow>(
    'SELECT id, user_id, symbol, asset_type, notes, external_id, created_at, updated_at FROM holdings WHERE id = $1 AND user_id = $2',
    [holdingId, userId],
  );
  const holding = holdingResult.rows[0];
  if (!holding) return null;

  const lotsResult = await query<LotRow>(
    `SELECT id, holding_id, quantity::text, cost_per_unit::text, acquired_at::text, notes, created_at::text
     FROM holding_lots WHERE holding_id = $1 ORDER BY acquired_at DESC, created_at DESC`,
    [holdingId],
  );
  const lots = lotsResult.rows;

  const totalQuantity = lots.reduce((acc, l) => acc + Number(l.quantity), 0);
  const totalCost = lots.reduce((acc, l) => acc + Number(l.quantity) * Number(l.cost_per_unit), 0);

  const quotes = await getQuotes([
    { symbol: holding.symbol, asset_type: holding.asset_type, external_id: holding.external_id },
  ]);
  const quote = quotes[0]!.quote;
  const price = quote?.price ?? null;
  const marketValue = price != null ? price * totalQuantity : null;
  const pl = marketValue != null ? marketValue - totalCost : null;
  const plPct = pl != null && totalCost > 0 ? (pl / totalCost) * 100 : null;

  return {
    holding: {
      id: holding.id,
      symbol: holding.symbol,
      asset_type: holding.asset_type,
      notes: holding.notes,
      total_quantity: totalQuantity,
      total_cost: totalCost,
      avg_cost: totalQuantity > 0 ? totalCost / totalQuantity : 0,
      current_price: price,
      market_value: marketValue,
      unrealized_pl: pl,
      unrealized_pl_pct: plPct,
      quote_error: quotes[0]!.error,
      lot_count: lots.length,
    },
    lots,
  };
}
