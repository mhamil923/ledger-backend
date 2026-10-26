import { query } from '../db.js';
import { getCoinbaseCandles } from './coinbase.js';
import { getTwelveDataCandles, isTwelveDataConfigured } from './twelvedata.js';
import { getCryptoChartFull } from './coingecko.js';

/**
 * Trade journal — every structured trade idea Claude proposes is recorded here.
 * A lazy resolver walks price history to determine outcomes (triggered → target
 * hit / stop hit / expired). The journal feeds back into future analyses so
 * Claude can see its own track record and calibrate conviction over time.
 */

export type TradeStatus = 'pending' | 'active' | 'closed' | 'expired';
export type TradeDirection = 'long' | 'short';
export type AssetType = 'stock' | 'crypto' | 'etf';

export interface TradeIdeaRecord {
  id: string;
  symbol: string;
  asset_type: AssetType;
  external_id: string | null;
  display_name: string | null;
  direction: TradeDirection;
  entry_low: number;
  entry_high: number;
  stop_loss: number;
  targets: number[];
  bias: string;
  conviction: number;
  time_horizon: string;
  rationale: string | null;
  price_at_creation: number;
  rsi14_at_creation: number | null;
  macd_state_at_creation: string | null;
  fear_greed_at_creation: number | null;
  model: string;
  status: TradeStatus;
  triggered_at: string | null;
  triggered_price: number | null;
  resolved_at: string | null;
  resolved_price: number | null;
  resolution: string | null;
  realized_pnl_pct: number | null;
  created_at: string;
  updated_at: string;
}

export interface RecordIdeaInput {
  user_id: string;
  symbol: string;
  asset_type: AssetType;
  external_id?: string | null;
  display_name?: string | null;
  direction: TradeDirection;
  entry_zone: [number, number];
  stop_loss: number;
  targets: number[];
  bias: string;
  conviction: number;
  time_horizon: string;
  rationale?: string | null;
  price_at_creation: number;
  rsi14_at_creation?: number | null;
  macd_state_at_creation?: string | null;
  fear_greed_at_creation?: number | null;
  model: string;
  setup_id?: string | null;
  bt_win_rate?: number | null;
  bt_n?: number | null;
  bt_avg_r?: number | null;
}

/**
 * Persist a new trade idea. Returns the inserted row's id.
 *
 * To avoid duplicate rows from Claude proposing the same trade in the same
 * day (e.g. cached analysis hits), we de-dupe by user+symbol+date+direction.
 */
export async function recordTradeIdea(input: RecordIdeaInput): Promise<string | null> {
  // Skip if we already have a same-direction idea for this user+symbol+today.
  const existing = await query<{ id: string }>(
    `SELECT id FROM trade_ideas
     WHERE user_id = $1 AND symbol = $2 AND direction = $3
       AND created_at::date = current_date
     LIMIT 1`,
    [input.user_id, input.symbol, input.direction],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const result = await query<{ id: string }>(
    `INSERT INTO trade_ideas (
       user_id, symbol, asset_type, external_id, display_name,
       direction, entry_low, entry_high, stop_loss, targets,
       bias, conviction, time_horizon, rationale,
       price_at_creation, rsi14_at_creation, macd_state_at_creation,
       fear_greed_at_creation, model, setup_id, bt_win_rate, bt_n, bt_avg_r
     )
     VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10,
       $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20, $21, $22, $23
     )
     RETURNING id`,
    [
      input.user_id,
      input.symbol,
      input.asset_type,
      input.external_id ?? null,
      input.display_name ?? null,
      input.direction,
      input.entry_zone[0],
      input.entry_zone[1],
      input.stop_loss,
      input.targets,
      input.bias,
      input.conviction,
      input.time_horizon,
      input.rationale ?? null,
      input.price_at_creation,
      input.rsi14_at_creation ?? null,
      input.macd_state_at_creation ?? null,
      input.fear_greed_at_creation ?? null,
      input.model,
      input.setup_id ?? null,
      input.bt_win_rate ?? null,
      input.bt_n ?? null,
      input.bt_avg_r ?? null,
    ],
  );
  return result.rows[0]?.id ?? null;
}

interface RawTradeRow {
  id: string;
  user_id: string;
  symbol: string;
  asset_type: AssetType;
  external_id: string | null;
  display_name: string | null;
  direction: TradeDirection;
  entry_low: string;
  entry_high: string;
  stop_loss: string;
  targets: string[];
  bias: string;
  conviction: number;
  time_horizon: string;
  rationale: string | null;
  price_at_creation: string;
  rsi14_at_creation: string | null;
  macd_state_at_creation: string | null;
  fear_greed_at_creation: number | null;
  model: string;
  status: TradeStatus;
  triggered_at: string | null;
  triggered_price: string | null;
  resolved_at: string | null;
  resolved_price: string | null;
  resolution: string | null;
  realized_pnl_pct: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: RawTradeRow): TradeIdeaRecord {
  return {
    id: row.id,
    symbol: row.symbol,
    asset_type: row.asset_type,
    external_id: row.external_id,
    display_name: row.display_name,
    direction: row.direction,
    entry_low: Number(row.entry_low),
    entry_high: Number(row.entry_high),
    stop_loss: Number(row.stop_loss),
    targets: row.targets.map(Number),
    bias: row.bias,
    conviction: row.conviction,
    time_horizon: row.time_horizon,
    rationale: row.rationale,
    price_at_creation: Number(row.price_at_creation),
    rsi14_at_creation: row.rsi14_at_creation == null ? null : Number(row.rsi14_at_creation),
    macd_state_at_creation: row.macd_state_at_creation,
    fear_greed_at_creation: row.fear_greed_at_creation,
    model: row.model,
    status: row.status,
    triggered_at: row.triggered_at,
    triggered_price: row.triggered_price == null ? null : Number(row.triggered_price),
    resolved_at: row.resolved_at,
    resolved_price: row.resolved_price == null ? null : Number(row.resolved_price),
    resolution: row.resolution,
    realized_pnl_pct: row.realized_pnl_pct == null ? null : Number(row.realized_pnl_pct),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SELECT_COLS = `
  id, user_id, symbol, asset_type, external_id, display_name,
  direction, entry_low::text, entry_high::text, stop_loss::text, targets,
  bias, conviction, time_horizon, rationale,
  price_at_creation::text, rsi14_at_creation::text, macd_state_at_creation,
  fear_greed_at_creation, model, status,
  triggered_at, triggered_price::text, resolved_at, resolved_price::text,
  resolution, realized_pnl_pct::text, created_at, updated_at
`;

interface CandleSlice {
  ts: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Fetch enough recent candles to cover from a trade's creation up to now.
 * Returns null if no chart data is available for this asset.
 */
async function fetchCandlesSince(
  symbol: string,
  asset_type: AssetType,
  external_id: string | null,
  sinceMs: number,
): Promise<CandleSlice[] | null> {
  const ageDays = (Date.now() - sinceMs) / (24 * 60 * 60 * 1000);
  // Pick the smallest range that covers the trade lifetime
  let range: '1d' | '7d' | '30d' | '90d' | '1y' = '7d';
  if (ageDays > 90) range = '1y';
  else if (ageDays > 30) range = '90d';
  else if (ageDays > 7) range = '30d';
  else if (ageDays > 1) range = '7d';
  else range = '1d';

  try {
    if (asset_type === 'crypto') {
      const cb = await getCoinbaseCandles(symbol, range);
      if (cb && cb.candles.length > 0) {
        return cb.candles.map((c) => ({ ts: c.ts, high: c.high, low: c.low, close: c.close }));
      }
      // Fall back to CoinGecko (no OHLC for points-only, derive from price)
      const cg = await getCryptoChartFull(symbol, external_id, daysFor(range));
      if (cg.points.length > 0) {
        // Synthesize OHLC=close for points-only data — pessimistic for outcome detection but better than nothing
        return cg.points.map((p) => ({ ts: p.ts, high: p.price, low: p.price, close: p.price }));
      }
      return null;
    }
    if (asset_type === 'stock' || asset_type === 'etf') {
      if (!isTwelveDataConfigured()) return null;
      const td = await getTwelveDataCandles(symbol, range);
      if (td && td.candles.length > 0) {
        return td.candles.map((c) => ({ ts: c.ts, high: c.high, low: c.low, close: c.close }));
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

function daysFor(range: string): number {
  return range === '1d' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 365;
}

interface ResolutionOutcome {
  status: TradeStatus;
  triggered_at?: Date;
  triggered_price?: number;
  resolved_at?: Date;
  resolved_price?: number;
  resolution?: string;
  realized_pnl_pct?: number;
}

/**
 * Walk price history forward from the trade's creation. Determine if it
 * triggered, then if it hit a target or stop. Standard backtest convention:
 * if a single candle straddles both stop and target, the stop wins (worst case).
 */
function resolveAgainstCandles(
  candles: CandleSlice[],
  createdAtMs: number,
  trade: {
    direction: TradeDirection;
    entry_low: number;
    entry_high: number;
    stop_loss: number;
    targets: number[];
    time_horizon: string;
    triggered_at_ms: number | null;
  },
): ResolutionOutcome | null {
  if (candles.length === 0) return null;
  // Only look at candles since trade creation.
  const since = trade.triggered_at_ms ?? createdAtMs;
  let triggered = trade.triggered_at_ms != null;
  let triggeredAtMs = trade.triggered_at_ms;
  for (const c of candles) {
    if (c.ts < createdAtMs) continue;

    if (!triggered) {
      // Did this candle touch the entry zone?
      if (c.low <= trade.entry_high && c.high >= trade.entry_low) {
        triggered = true;
        triggeredAtMs = c.ts;
        // We'd fill near the midpoint of the entry zone (assume limit order).
        // No "resolved" yet — keep walking to find stop/target.
        continue;
      }
      continue;
    }

    // Triggered — check stop and targets for this candle.
    if (c.ts < (triggeredAtMs ?? since)) continue;
    if (trade.direction === 'long') {
      const hitStop = c.low <= trade.stop_loss;
      const hitTargetIdx = findFirstTargetHit(trade.targets, c.high, 'long');
      if (hitStop) {
        const entryMid = (trade.entry_low + trade.entry_high) / 2;
        return {
          status: 'closed',
          triggered_at: new Date(triggeredAtMs ?? since),
          triggered_price: entryMid,
          resolved_at: new Date(c.ts),
          resolved_price: trade.stop_loss,
          resolution: 'stop_hit',
          realized_pnl_pct: ((trade.stop_loss - entryMid) / entryMid) * 100,
        };
      }
      if (hitTargetIdx >= 0) {
        const entryMid = (trade.entry_low + trade.entry_high) / 2;
        const target = trade.targets[hitTargetIdx]!;
        return {
          status: 'closed',
          triggered_at: new Date(triggeredAtMs ?? since),
          triggered_price: entryMid,
          resolved_at: new Date(c.ts),
          resolved_price: target,
          resolution: `target_${hitTargetIdx + 1}`,
          realized_pnl_pct: ((target - entryMid) / entryMid) * 100,
        };
      }
    } else {
      // Short
      const hitStop = c.high >= trade.stop_loss;
      const hitTargetIdx = findFirstTargetHit(trade.targets, c.low, 'short');
      if (hitStop) {
        const entryMid = (trade.entry_low + trade.entry_high) / 2;
        return {
          status: 'closed',
          triggered_at: new Date(triggeredAtMs ?? since),
          triggered_price: entryMid,
          resolved_at: new Date(c.ts),
          resolved_price: trade.stop_loss,
          resolution: 'stop_hit',
          realized_pnl_pct: ((entryMid - trade.stop_loss) / entryMid) * 100,
        };
      }
      if (hitTargetIdx >= 0) {
        const entryMid = (trade.entry_low + trade.entry_high) / 2;
        const target = trade.targets[hitTargetIdx]!;
        return {
          status: 'closed',
          triggered_at: new Date(triggeredAtMs ?? since),
          triggered_price: entryMid,
          resolved_at: new Date(c.ts),
          resolved_price: target,
          resolution: `target_${hitTargetIdx + 1}`,
          realized_pnl_pct: ((entryMid - target) / entryMid) * 100,
        };
      }
    }
  }

  // Walked all candles without resolution. Check if we should expire.
  if (shouldExpire(trade.time_horizon, createdAtMs)) {
    return { status: 'expired' };
  }
  return triggered
    ? {
        status: 'active',
        triggered_at: triggeredAtMs ? new Date(triggeredAtMs) : undefined,
        triggered_price: (trade.entry_low + trade.entry_high) / 2,
      }
    : { status: 'pending' };
}

function findFirstTargetHit(targets: number[], candleExtreme: number, dir: TradeDirection): number {
  // For long: target is above entry, so hit when candleExtreme (high) >= target.
  // For short: target is below entry, so hit when candleExtreme (low) <= target.
  // Hit the *furthest* target the price reached (give credit for best move).
  let bestIdx = -1;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const reached = dir === 'long' ? candleExtreme >= t : candleExtreme <= t;
    if (reached) bestIdx = i;
  }
  return bestIdx;
}

function shouldExpire(horizon: string, createdAtMs: number): boolean {
  const ageDays = (Date.now() - createdAtMs) / (24 * 60 * 60 * 1000);
  if (horizon === 'intraday') return ageDays > 2;
  if (horizon === 'short_term') return ageDays > 14;
  if (horizon === 'medium_term') return ageDays > 45;
  if (horizon === 'long_term') return ageDays > 180;
  return ageDays > 60;
}

/**
 * Refresh outcomes for the user's pending/active trades. Called lazily from
 * the analysis route so we don't need a background cron — each new analysis
 * also brings the journal up to date.
 */
export async function resolvePendingTrades(userId: string): Promise<number> {
  const pending = await query<RawTradeRow>(
    `SELECT ${SELECT_COLS} FROM trade_ideas
     WHERE user_id = $1 AND status IN ('pending', 'active')
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId],
  );
  let resolved = 0;
  for (const raw of pending.rows) {
    const row = rowToRecord(raw);
    const candles = await fetchCandlesSince(
      row.symbol,
      row.asset_type,
      row.external_id,
      new Date(row.created_at).getTime(),
    );
    if (!candles) continue;
    const outcome = resolveAgainstCandles(candles, new Date(row.created_at).getTime(), {
      direction: row.direction,
      entry_low: row.entry_low,
      entry_high: row.entry_high,
      stop_loss: row.stop_loss,
      targets: row.targets,
      time_horizon: row.time_horizon,
      triggered_at_ms: row.triggered_at ? new Date(row.triggered_at).getTime() : null,
    });
    if (!outcome || outcome.status === row.status) continue;
    await query(
      `UPDATE trade_ideas
       SET status = $1,
           triggered_at = COALESCE($2, triggered_at),
           triggered_price = COALESCE($3, triggered_price),
           resolved_at = $4,
           resolved_price = $5,
           resolution = $6,
           realized_pnl_pct = $7,
           updated_at = now()
       WHERE id = $8`,
      [
        outcome.status,
        outcome.triggered_at ?? null,
        outcome.triggered_price ?? null,
        outcome.resolved_at ?? null,
        outcome.resolved_price ?? null,
        outcome.resolution ?? null,
        outcome.realized_pnl_pct ?? null,
        row.id,
      ],
    );
    resolved++;
  }
  return resolved;
}

export interface TrackRecord {
  total: number;
  closed: number;
  winners: number;
  losers: number;
  pending: number;
  active: number;
  expired: number;
  win_rate_pct: number;
  /** Aggregate expectancy per trade (in %), i.e. E[pnl] across closed trades. */
  expectancy_pct: number;
  avg_win_pct: number;
  avg_loss_pct: number;
  /** Slice by (direction, horizon, conviction, RSI regime). Only closed slices
   *  are included so the sample size is meaningful. */
  breakdowns: {
    by_direction: JournalSlice[];
    by_horizon: JournalSlice[];
    by_conviction: JournalSlice[];
    by_rsi_regime: JournalSlice[];
  };
  recent: TradeIdeaRecord[];
}

export interface JournalSlice {
  label: string;
  n: number;
  wins: number;
  losses: number;
  win_rate_pct: number;
  avg_pnl_pct: number;
}

/**
 * Build the track record we feed back to Claude. Includes aggregate stats and
 * the actual recent ideas so the model can spot patterns in its own behavior.
 */
export async function getTrackRecord(
  userId: string,
  options: { symbol?: string; daysBack?: number; limit?: number } = {},
): Promise<TrackRecord> {
  const daysBack = options.daysBack ?? 60;
  const limit = options.limit ?? 12;

  // Pull ALL trades in the window for aggregate stats (breakdowns need
  // enough sample size to be meaningful), then pull the most recent N for
  // the individual-example list Claude sees inline.
  const params: unknown[] = [userId, daysBack];
  let symbolFilter = '';
  if (options.symbol) {
    symbolFilter = 'AND symbol = $3';
    params.push(options.symbol);
  }
  const [allRes, recentRes] = await Promise.all([
    query<RawTradeRow>(
      `SELECT ${SELECT_COLS} FROM trade_ideas
       WHERE user_id = $1 AND created_at > now() - ($2 || ' days')::interval ${symbolFilter}
       ORDER BY created_at DESC`,
      params,
    ),
    query<RawTradeRow>(
      `SELECT ${SELECT_COLS} FROM trade_ideas
       WHERE user_id = $1 AND created_at > now() - ($2 || ' days')::interval ${symbolFilter}
       ORDER BY created_at DESC
       LIMIT ${limit}`,
      params,
    ),
  ]);
  const all = allRes.rows.map(rowToRecord);
  const recent = recentRes.rows.map(rowToRecord);

  let winners = 0;
  let losers = 0;
  let closed = 0;
  let pending = 0;
  let active = 0;
  let expired = 0;
  let winsSum = 0;
  let lossesSum = 0;
  for (const t of all) {
    if (t.status === 'closed') {
      closed++;
      const isWin = t.resolution?.startsWith('target');
      const isLoss = t.resolution === 'stop_hit';
      if (isWin) {
        winners++;
        if (t.realized_pnl_pct != null) winsSum += t.realized_pnl_pct;
      } else if (isLoss) {
        losers++;
        if (t.realized_pnl_pct != null) lossesSum += t.realized_pnl_pct;
      }
    } else if (t.status === 'pending') pending++;
    else if (t.status === 'active') active++;
    else if (t.status === 'expired') expired++;
  }
  const winRate = closed > 0 ? (winners / closed) * 100 : 0;
  const avgWin = winners > 0 ? winsSum / winners : 0;
  const avgLoss = losers > 0 ? lossesSum / losers : 0;
  const expectancy = closed > 0 ? (winsSum + lossesSum) / closed : 0;

  const breakdowns = {
    by_direction: sliceBy(all, (t) => t.direction.toUpperCase()),
    by_horizon: sliceBy(all, (t) => t.time_horizon),
    by_conviction: sliceBy(all, (t) => `conv=${t.conviction}`),
    by_rsi_regime: sliceBy(all, (t) => {
      const r = t.rsi14_at_creation;
      if (r == null) return 'RSI=?';
      if (r < 30) return 'RSI<30 (oversold)';
      if (r > 70) return 'RSI>70 (overbought)';
      return 'RSI 30-70 (neutral)';
    }),
  };

  return {
    total: all.length,
    closed,
    winners,
    losers,
    pending,
    active,
    expired,
    win_rate_pct: winRate,
    expectancy_pct: expectancy,
    avg_win_pct: avgWin,
    avg_loss_pct: avgLoss,
    breakdowns,
    recent,
  };
}

/**
 * Group trades by a key extractor and compute win-rate + avg pnl per group.
 * Only includes groups with at least 2 CLOSED trades — smaller samples are
 * noise, not signal, and would mislead Claude's calibration.
 */
function sliceBy(
  trades: TradeIdeaRecord[],
  keyFn: (t: TradeIdeaRecord) => string,
): JournalSlice[] {
  const buckets = new Map<string, TradeIdeaRecord[]>();
  for (const t of trades) {
    if (t.status !== 'closed') continue;
    if (t.resolution !== 'stop_hit' && !t.resolution?.startsWith('target')) continue;
    const key = keyFn(t);
    const arr = buckets.get(key) ?? [];
    arr.push(t);
    buckets.set(key, arr);
  }
  const slices: JournalSlice[] = [];
  for (const [label, arr] of buckets) {
    if (arr.length < 2) continue; // ignore noise
    const wins = arr.filter((t) => t.resolution?.startsWith('target')).length;
    const losses = arr.filter((t) => t.resolution === 'stop_hit').length;
    const pnlSum = arr.reduce((s, t) => s + (t.realized_pnl_pct ?? 0), 0);
    slices.push({
      label,
      n: arr.length,
      wins,
      losses,
      win_rate_pct: (wins / arr.length) * 100,
      avg_pnl_pct: pnlSum / arr.length,
    });
  }
  slices.sort((a, b) => b.n - a.n);
  return slices;
}

/**
 * Format the track record as a compact prompt block for Claude. Keeps it
 * readable + concise. ~200-400 tokens depending on how many trades exist.
 */
export function formatTrackRecordForPrompt(symbol: string, tr: TrackRecord): string {
  if (tr.total === 0) {
    return 'No prior trade ideas on record for this user yet — first call.';
  }
  const lines: string[] = [];
  lines.push(
    `Your trade journal (last 60d): ${tr.total} ideas · ${tr.winners}W / ${tr.losers}L / ${tr.pending + tr.active} open / ${tr.expired} expired · win rate ${tr.win_rate_pct.toFixed(0)}%.`,
  );
  const payoffRatio =
    tr.avg_loss_pct !== 0 ? Math.abs(tr.avg_win_pct / tr.avg_loss_pct) : 0;
  lines.push(
    `  Avg win: ${tr.avg_win_pct >= 0 ? '+' : ''}${tr.avg_win_pct.toFixed(2)}% · Avg loss: ${tr.avg_loss_pct.toFixed(2)}% · Payoff ratio: ${payoffRatio.toFixed(2)}:1 · Expectancy per trade: ${tr.expectancy_pct >= 0 ? '+' : ''}${tr.expectancy_pct.toFixed(2)}%.`,
  );

  // Per-symbol breakdown if there were trades on this symbol
  const onSymbol = tr.recent.filter((t) => t.symbol === symbol);
  if (onSymbol.length > 0) {
    const w = onSymbol.filter((t) => t.resolution?.startsWith('target')).length;
    const l = onSymbol.filter((t) => t.resolution === 'stop_hit').length;
    lines.push(`On ${symbol} specifically: ${onSymbol.length} prior · ${w}W / ${l}L.`);
  }

  // Breakdowns — these are the calibration levers. If any slice has <50%
  // win rate at n≥5, Claude should be much more skeptical of matching setups.
  const renderSlice = (title: string, slices: JournalSlice[]): void => {
    if (slices.length === 0) return;
    lines.push('');
    lines.push(`${title}:`);
    for (const s of slices) {
      const rateColor =
        s.win_rate_pct >= 55 ? '✓' : s.win_rate_pct <= 40 ? '⚠️ LOSING' : ' ';
      lines.push(
        `  ${rateColor} ${s.label}: n=${s.n} · ${s.wins}W/${s.losses}L · ${s.win_rate_pct.toFixed(0)}% win rate · avg ${s.avg_pnl_pct >= 0 ? '+' : ''}${s.avg_pnl_pct.toFixed(2)}%`,
      );
    }
  };
  renderSlice('BY DIRECTION', tr.breakdowns.by_direction);
  renderSlice('BY HORIZON', tr.breakdowns.by_horizon);
  renderSlice(
    'BY CONVICTION (CRITICAL — check if higher conviction has worse win rate than lower conviction; if so you are over-confident)',
    tr.breakdowns.by_conviction,
  );
  renderSlice('BY RSI REGIME AT ENTRY', tr.breakdowns.by_rsi_regime);

  lines.push('');
  lines.push('Most recent ideas (oldest first):');
  for (const t of [...tr.recent].reverse()) {
    const tag = describeOutcome(t);
    const pnl = t.realized_pnl_pct != null ? ` (${t.realized_pnl_pct >= 0 ? '+' : ''}${t.realized_pnl_pct.toFixed(1)}%)` : '';
    const dateStr = new Date(t.created_at).toISOString().slice(0, 10);
    lines.push(
      `  ${dateStr} ${t.symbol} ${t.direction.toUpperCase()} conv=${t.conviction} ` +
        `entry=${formatNum(t.entry_low)}-${formatNum(t.entry_high)} stop=${formatNum(t.stop_loss)} ` +
        `[${t.bias}/${t.time_horizon}/RSI=${t.rsi14_at_creation?.toFixed(0) ?? '?'}/F&G=${t.fear_greed_at_creation ?? '?'}] → ${tag}${pnl}`,
    );
  }
  lines.push('');
  lines.push('CALIBRATION RULES — apply these BEFORE finalizing your trade ideas:');
  lines.push(
    '1. Look at BY DIRECTION. If your proposal matches a direction with <45% win rate at n≥5, downgrade conviction by 1 or switch to entry_kind="waiting".',
  );
  lines.push(
    '2. Look at BY HORIZON. If the horizon with the strongest setup has <45% win rate historically, prefer the horizon with the higher win rate — or use conviction=1 waiting on the weak horizon.',
  );
  lines.push(
    '3. Look at BY CONVICTION. If your assigned conviction (say 4) has WORSE win rate than a lower conviction (say 2), the model is over-confident. DOWNGRADE by 1-2 unless the setup is clearly stronger than the failed ones (say why in rationale).',
  );
  lines.push(
    '4. Look at BY RSI REGIME. If RSI-at-entry regime historically loses, factor that in — extreme regimes often trap.',
  );
  lines.push(
    '5. If expectancy is negative, you are systematically wrong. Be MORE willing to use entry_kind="waiting" and conviction=1 rather than forcing trades.',
  );
  return lines.join('\n');
}

function describeOutcome(t: TradeIdeaRecord): string {
  if (t.status === 'closed') {
    if (t.resolution?.startsWith('target')) return t.resolution.toUpperCase();
    if (t.resolution === 'stop_hit') return 'STOPPED';
    return t.resolution ?? 'CLOSED';
  }
  if (t.status === 'active') return 'IN TRADE';
  if (t.status === 'expired') return 'EXPIRED (never triggered)';
  return 'PENDING (waiting for entry)';
}

function formatNum(n: number): string {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs < 0.0001) return n.toExponential(3);
  if (abs < 1) return n.toFixed(6);
  if (abs < 100) return n.toFixed(4);
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Recent activity on a specific symbol — used to surface repeat-loss patterns
 * to Claude in the prompt AND to drive server-side cool-down / conviction
 * penalties on new ideas. The prompt-level warning alone isn't enough; the
 * gates in analysis.ts also use this to actually rewrite bad trades.
 */
export interface SymbolActivity {
  symbol: string;
  window_days: number;
  trades_in_window: number;
  losses_in_window: number;
  wins_in_window: number;
  /** Consecutive stop-outs on this symbol counting backward from most recent. */
  loss_streak: number;
  /** Direction of the most recent stop-out (for direction-flip whipsaw detection). */
  last_loss_direction: 'long' | 'short' | null;
  /** Are we in a cool-down (2+ stops in last 14d)? */
  cooldown: boolean;
  recent_losses: Array<{
    date: string;
    direction: 'long' | 'short';
    pnl_pct: number | null;
    horizon: string;
  }>;
}

export async function getSymbolActivity(
  userId: string,
  symbol: string,
  windowDays = 14,
): Promise<SymbolActivity> {
  const rows = await query<RawTradeRow>(
    `SELECT ${SELECT_COLS} FROM trade_ideas
     WHERE user_id = $1 AND symbol = $2
       AND created_at > now() - ($3 || ' days')::interval
     ORDER BY created_at DESC`,
    [userId, symbol, windowDays],
  );
  const trades = rows.rows.map(rowToRecord);
  const closed = trades.filter((t) => t.status === 'closed');
  const wins = closed.filter((t) => t.resolution?.startsWith('target'));
  const losses = closed.filter((t) => t.resolution === 'stop_hit');

  // Compute consecutive stop-outs from most recent backward.
  let lossStreak = 0;
  for (const t of closed) {
    if (t.resolution === 'stop_hit') lossStreak++;
    else break;
  }
  const lastLoss = losses[0];

  return {
    symbol,
    window_days: windowDays,
    trades_in_window: trades.length,
    losses_in_window: losses.length,
    wins_in_window: wins.length,
    loss_streak: lossStreak,
    last_loss_direction: lastLoss ? lastLoss.direction : null,
    cooldown: losses.length >= 2,
    recent_losses: losses.slice(0, 5).map((t) => ({
      date: new Date(t.created_at).toISOString().slice(0, 10),
      direction: t.direction,
      pnl_pct: t.realized_pnl_pct,
      horizon: t.time_horizon,
    })),
  };
}

/**
 * Format symbol-specific activity as an inline prompt block with explicit
 * warning flags. Placed near the top of the user message so it's visible to
 * Claude before it commits to a direction.
 */
export function formatSymbolActivityForPrompt(activity: SymbolActivity): string {
  if (activity.trades_in_window === 0) {
    return `\n=== ${activity.symbol} RECENT ACTIVITY (last ${activity.window_days}d) ===\nNo prior ideas on ${activity.symbol} in this window — no history bias.\n`;
  }
  const lines: string[] = [];
  lines.push(`\n=== ${activity.symbol} RECENT ACTIVITY (last ${activity.window_days}d) ===`);
  lines.push(
    `${activity.trades_in_window} trade${activity.trades_in_window === 1 ? '' : 's'} · ${activity.wins_in_window}W / ${activity.losses_in_window}L · loss streak: ${activity.loss_streak}.`,
  );

  if (activity.cooldown) {
    lines.push(
      '⚠️ COOL-DOWN TRIGGERED — 2+ stops on this symbol in the last 14d. New trade ideas on this symbol MUST use entry_kind="waiting" and conviction=1 (or ≤ conviction of the most recent losing trade, minus 1). Do not chase.',
    );
  }
  if (activity.loss_streak >= 2 && activity.last_loss_direction) {
    lines.push(
      `⚠️ LOSING STREAK — the last ${activity.loss_streak} closed ideas on ${activity.symbol} were STOP-OUTS. If you propose another ${activity.last_loss_direction.toUpperCase()}, downgrade AT LEAST 2 conviction levels vs the last one. If you propose the OPPOSITE direction (${activity.last_loss_direction === 'long' ? 'SHORT' : 'LONG'}), you must justify why the regime flipped — otherwise this is a whipsaw.`,
    );
  }

  if (activity.recent_losses.length > 0) {
    lines.push('Recent stop-outs on this symbol:');
    for (const l of activity.recent_losses) {
      lines.push(
        `  ${l.date} ${l.direction.toUpperCase()} · ${l.horizon} → STOPPED (${l.pnl_pct?.toFixed(1) ?? '?'}%)`,
      );
    }
  }
  return lines.join('\n');
}

export async function listUserTrades(
  userId: string,
  options: { symbol?: string; status?: TradeStatus; limit?: number } = {},
): Promise<TradeIdeaRecord[]> {
  const params: unknown[] = [userId];
  let where = 'user_id = $1';
  if (options.symbol) {
    params.push(options.symbol);
    where += ` AND symbol = $${params.length}`;
  }
  if (options.status) {
    params.push(options.status);
    where += ` AND status = $${params.length}`;
  }
  const limit = Math.min(options.limit ?? 50, 200);
  const result = await query<RawTradeRow>(
    `SELECT ${SELECT_COLS} FROM trade_ideas WHERE ${where} ORDER BY created_at DESC LIMIT ${limit}`,
    params,
  );
  return result.rows.map(rowToRecord);
}
