// Quant engine: turns candles into measured, rule-based trade setups.
//
// For every setup below we (1) replay the asset's own history to measure how
// often it reached target 1 before its stop, and (2) check whether it is
// firing right now. Trade ideas shown in the app come from these candidates,
// so every idea carries a real, measured hit rate instead of a guess.
//
// All indicators are computed without look-ahead (value[i] only uses bars ≤ i).

import {
  adx as adxFn,
  atr as atrFn,
  bollinger,
  ema,
  highest,
  lowest,
  relativeVolume,
  rsi as rsiFn,
  supportResistance,
  wilsonLower,
  type Level,
  type OHLCV,
} from './ta.js';

export type QuantHorizon = 'intraday' | 'short_term' | 'medium_term';
export type Direction = 'long' | 'short';
export type Regime = 'uptrend' | 'downtrend' | 'range';

interface Profile {
  stopAtr: number; // stop distance in ATRs
  targetsR: number[]; // targets as multiples of risk (R)
  timeBars: number; // close the trade after this many bars
  orderBars: number; // pending orders expire after this many bars
}

export const PROFILES: Record<QuantHorizon, Profile> = {
  intraday: { stopAtr: 1.5, targetsR: [1, 2], timeBars: 24, orderBars: 4 }, // hourly bars
  short_term: { stopAtr: 1.5, targetsR: [1, 2], timeBars: 10, orderBars: 5 }, // daily bars
  medium_term: { stopAtr: 2.5, targetsR: [1, 2, 3], timeBars: 40, orderBars: 7 }, // daily bars
};

export interface SetupStats {
  n: number;
  wins: number; // target 1 reached before the stop
  losses: number;
  timeouts: number; // neither within the time limit (closed at market)
  win_rate: number; // wins / n
  win_rate_lower: number; // Wilson lower bound (~80% confidence)
  avg_r: number; // average result in R, exiting everything at target 1
  t2_rate: number; // share of trades that also reached target 2
}

export interface Candidate {
  setup_id: string;
  label: string;
  horizon: QuantHorizon;
  direction: Direction;
  entry_kind: 'trigger_now' | 'pullback' | 'breakout';
  entry_zone: [number, number];
  stop_loss: number;
  targets: number[];
  stats: SetupStats;
  why: string;
}

export interface Indicators {
  bar_ts: number;
  price: number;
  atr: number;
  atr_pct: number;
  ema20: number;
  ema50: number;
  ema200: number | null;
  rsi14: number;
  adx14: number;
  bb_pct_b: number; // 0 = lower band, 1 = upper band
  rel_volume: number | null;
  high20: number;
  low20: number;
  regime: Regime;
}

export interface TimeframeAnalysis {
  timeframe: 'hourly' | 'daily';
  bars: number;
  indicators: Indicators;
  support: Level[];
  resistance: Level[];
}

export interface QuantReport {
  daily: TimeframeAnalysis | null;
  hourly: TimeframeAnalysis | null;
  /** Every setup's backtest on this asset, per horizon — including ones not firing. */
  backtests: Array<{ horizon: QuantHorizon; setup_id: string; label: string; direction: Direction; stats: SetupStats }>;
  /** Setups whose conditions are met right now, best first per horizon. */
  candidates: Candidate[];
}

// ---------------------------------------------------------------------------

interface Series {
  c: OHLCV[];
  close: number[];
  high: number[];
  low: number[];
  ema20: number[];
  ema50: number[];
  ema200: number[];
  rsi: number[];
  atr: number[];
  adx: number[];
  bbU: number[];
  bbL: number[];
  bbM: number[];
  rv: number[];
}

function buildSeries(c: OHLCV[]): Series {
  const close = c.map((k) => k.close);
  const bb = bollinger(close, 20, 2);
  return {
    c,
    close,
    high: c.map((k) => k.high),
    low: c.map((k) => k.low),
    ema20: ema(close, 20),
    ema50: ema(close, 50),
    ema200: ema(close, 200),
    rsi: rsiFn(close, 14),
    atr: atrFn(c, 14),
    adx: adxFn(c, 14).adx,
    bbU: bb.upper,
    bbL: bb.lower,
    bbM: bb.mid,
    rv: relativeVolume(c, 20),
  };
}

function regimeAt(s: Series, i: number): Regime {
  const e20 = s.ema20[i]!;
  const e50 = s.ema50[i]!;
  const a = s.adx[i]!;
  const cl = s.close[i]!;
  if ([e20, e50, a].some((v) => Number.isNaN(v))) return 'range';
  if (a >= 20 && e20 > e50 && cl > e50) return 'uptrend';
  if (a >= 20 && e20 < e50 && cl < e50) return 'downtrend';
  return 'range';
}

type Order = { type: 'market' } | { type: 'limit'; price: number } | { type: 'stop'; price: number };

interface SetupDef {
  id: string;
  label: string;
  direction: Direction;
  entryKind: Candidate['entry_kind'];
  /** Returns an order if the setup's conditions are met at bar i. */
  detect: (s: Series, i: number) => { order: Order; why: string } | null;
}

const fmt = (n: number): string => (Math.abs(n) >= 100 ? n.toFixed(2) : n.toPrecision(5));

const SETUPS: SetupDef[] = [
  {
    id: 'trend_pullback_long',
    label: 'Trend pullback (long)',
    direction: 'long',
    entryKind: 'pullback',
    detect: (s, i) => {
      if (regimeAt(s, i) !== 'uptrend') return null;
      const dist = s.close[i]! - s.ema20[i]!;
      if (dist <= 0 || dist > 1.5 * s.atr[i]!) return null;
      if (s.rsi[i]! < 40 || s.rsi[i]! > 65) return null;
      return {
        order: { type: 'limit', price: s.ema20[i]! },
        why: `Uptrend (ADX ${s.adx[i]!.toFixed(0)}, EMA20 > EMA50); buy a dip to EMA20 at ${fmt(s.ema20[i]!)}`,
      };
    },
  },
  {
    id: 'trend_pullback_short',
    label: 'Trend pullback (short)',
    direction: 'short',
    entryKind: 'pullback',
    detect: (s, i) => {
      if (regimeAt(s, i) !== 'downtrend') return null;
      const dist = s.ema20[i]! - s.close[i]!;
      if (dist <= 0 || dist > 1.5 * s.atr[i]!) return null;
      if (s.rsi[i]! < 35 || s.rsi[i]! > 60) return null;
      return {
        order: { type: 'limit', price: s.ema20[i]! },
        why: `Downtrend (ADX ${s.adx[i]!.toFixed(0)}, EMA20 < EMA50); short a bounce into EMA20 at ${fmt(s.ema20[i]!)}`,
      };
    },
  },
  {
    id: 'breakout_long',
    label: '20-bar breakout (long)',
    direction: 'long',
    entryKind: 'breakout',
    detect: (s, i) => {
      if (i < 21) return null;
      const hi = highest(s.high, i - 1, 20);
      const a = s.atr[i]!;
      if (s.close[i]! >= hi || hi - s.close[i]! > 0.5 * a) return null;
      if (s.adx[i]! < 15 || s.close[i]! < s.ema50[i]!) return null;
      const level = hi + 0.1 * a;
      return { order: { type: 'stop', price: level }, why: `Pressing the 20-bar high ${fmt(hi)}; buy a break above ${fmt(level)}` };
    },
  },
  {
    id: 'breakdown_short',
    label: '20-bar breakdown (short)',
    direction: 'short',
    entryKind: 'breakout',
    detect: (s, i) => {
      if (i < 21) return null;
      const lo = lowest(s.low, i - 1, 20);
      const a = s.atr[i]!;
      if (s.close[i]! <= lo || s.close[i]! - lo > 0.5 * a) return null;
      if (s.adx[i]! < 15 || s.close[i]! > s.ema50[i]!) return null;
      const level = lo - 0.1 * a;
      return { order: { type: 'stop', price: level }, why: `Pressing the 20-bar low ${fmt(lo)}; short a break below ${fmt(level)}` };
    },
  },
  {
    id: 'range_reversion_long',
    label: 'Range bounce off lower band (long)',
    direction: 'long',
    entryKind: 'trigger_now',
    detect: (s, i) => {
      if (s.adx[i]! >= 20) return null;
      if (!(s.close[i]! < s.bbL[i]!) || s.rsi[i]! > 32) return null;
      return { order: { type: 'market' }, why: `Choppy market (ADX ${s.adx[i]!.toFixed(0)}), closed below the lower Bollinger band with RSI ${s.rsi[i]!.toFixed(0)}` };
    },
  },
  {
    id: 'range_reversion_short',
    label: 'Range fade off upper band (short)',
    direction: 'short',
    entryKind: 'trigger_now',
    detect: (s, i) => {
      if (s.adx[i]! >= 20) return null;
      if (!(s.close[i]! > s.bbU[i]!) || s.rsi[i]! < 68) return null;
      return { order: { type: 'market' }, why: `Choppy market (ADX ${s.adx[i]!.toFixed(0)}), closed above the upper Bollinger band with RSI ${s.rsi[i]!.toFixed(0)}` };
    },
  },
];

const WARMUP = 60;

interface Trade {
  entryIdx: number;
  exitIdx: number;
  r: number;
  win: boolean;
  loss: boolean;
  hitT2: boolean;
}

/**
 * Fill an order on the bars after the signal; returns [fillIdx, fillPrice].
 * Deliberately pessimistic, like a real fill: stop orders slip 0.1 ATR past
 * the level, and limit orders only count if price trades 0.05 ATR through
 * them (touching the level isn't a guaranteed fill).
 */
const STOP_SLIP_ATR = 0.1;
const LIMIT_THROUGH_ATR = 0.05;
function fill(s: Series, i: number, order: Order, dir: Direction, orderBars: number): [number, number] | null {
  if (order.type === 'market') return [i, s.close[i]!];
  const a = s.atr[i]!;
  for (let j = i + 1; j <= Math.min(s.c.length - 1, i + orderBars); j++) {
    const open = s.c[j]!.open;
    if (order.type === 'limit') {
      if (dir === 'long' && s.low[j]! <= order.price - LIMIT_THROUGH_ATR * a) return [j, Math.min(order.price, open)];
      if (dir === 'short' && s.high[j]! >= order.price + LIMIT_THROUGH_ATR * a) return [j, Math.max(order.price, open)];
    } else {
      if (dir === 'long' && s.high[j]! >= order.price) return [j, Math.max(order.price, open) + STOP_SLIP_ATR * a];
      if (dir === 'short' && s.low[j]! <= order.price) return [j, Math.min(order.price, open) - STOP_SLIP_ATR * a];
    }
  }
  return null;
}

/** Walk forward from the fill. Stop is checked before target within a bar (conservative). */
function simulate(
  s: Series,
  fillIdx: number,
  entry: number,
  dir: Direction,
  risk: number,
  p: Profile,
  filledIntraBar: boolean,
): Trade | null {
  const sign = dir === 'long' ? 1 : -1;
  const stop = entry - sign * risk;
  const t1 = entry + sign * risk * p.targetsR[0]!;
  const t2 = entry + sign * risk * (p.targetsR[1] ?? p.targetsR[0]!);
  const last = Math.min(s.c.length - 1, fillIdx + p.timeBars);
  if (last <= fillIdx) return null; // not enough future bars to judge
  // A pending order filled part-way through a bar: we can't know if the rest
  // of that bar hit the stop, so assume the worst (target there doesn't count).
  if (filledIntraBar && (dir === 'long' ? s.low[fillIdx]! <= stop : s.high[fillIdx]! >= stop)) {
    return { entryIdx: fillIdx, exitIdx: fillIdx, r: -1, win: false, loss: true, hitT2: false };
  }
  let won = false;
  for (let j = fillIdx + 1; j <= last; j++) {
    const lo = s.low[j]!;
    const hi = s.high[j]!;
    const stopHit = dir === 'long' ? lo <= stop : hi >= stop;
    if (!won && stopHit) return { entryIdx: fillIdx, exitIdx: j, r: -1, win: false, loss: true, hitT2: false };
    if (!won && (dir === 'long' ? hi >= t1 : lo <= t1)) {
      won = true;
    }
    if (won) {
      // Keep watching for target 2 (or a return to entry) to measure t2_rate.
      for (let k = j; k <= last; k++) {
        if (dir === 'long' ? s.high[k]! >= t2 : s.low[k]! <= t2) {
          return { entryIdx: fillIdx, exitIdx: j, r: p.targetsR[0]!, win: true, loss: false, hitT2: true };
        }
        if (k > j && (dir === 'long' ? s.low[k]! <= entry : s.high[k]! >= entry)) break;
      }
      return { entryIdx: fillIdx, exitIdx: j, r: p.targetsR[0]!, win: true, loss: false, hitT2: false };
    }
  }
  if (s.c.length - 1 < fillIdx + p.timeBars) return null; // still open — don't count
  const r = (sign * (s.close[last]! - entry)) / risk;
  return { entryIdx: fillIdx, exitIdx: last, r, win: false, loss: false, hitT2: false };
}

export function backtest(s: Series, setup: SetupDef, p: Profile, upTo: number): SetupStats {
  const trades: Trade[] = [];
  let i = WARMUP;
  while (i < upTo) {
    const sig = setup.detect(s, i);
    if (!sig) {
      i++;
      continue;
    }
    const f = fill(s, i, sig.order, setup.direction, p.orderBars);
    if (!f) {
      i++;
      continue;
    }
    const [fi, price] = f;
    const risk = p.stopAtr * s.atr[i]!;
    if (!(risk > 0)) {
      i++;
      continue;
    }
    const t = simulate(s, fi, price, setup.direction, risk, p, sig.order.type !== 'market');
    if (!t) break;
    trades.push(t);
    i = t.exitIdx + 1; // no overlapping trades
  }
  const n = trades.length;
  const wins = trades.filter((t) => t.win).length;
  const losses = trades.filter((t) => t.loss).length;
  return {
    n,
    wins,
    losses,
    timeouts: n - wins - losses,
    win_rate: n ? wins / n : 0,
    win_rate_lower: wilsonLower(wins, n),
    avg_r: n ? trades.reduce((a, t) => a + t.r, 0) / n : 0,
    t2_rate: n ? trades.filter((t) => t.hitT2).length / n : 0,
  };
}

function snapshot(s: Series, i: number, timeframe: 'hourly' | 'daily'): TimeframeAnalysis {
  const price = s.close[s.c.length - 1]!;
  const a = s.atr[i]!;
  const range = s.bbU[i]! - s.bbL[i]!;
  const sr = supportResistance(s.c.slice(Math.max(0, s.c.length - 250)), a);
  return {
    timeframe,
    bars: s.c.length,
    indicators: {
      bar_ts: s.c[i]!.ts,
      price,
      atr: a,
      atr_pct: (a / price) * 100,
      ema20: s.ema20[i]!,
      ema50: s.ema50[i]!,
      ema200: Number.isNaN(s.ema200[i]!) ? null : s.ema200[i]!,
      rsi14: s.rsi[i]!,
      adx14: s.adx[i]!,
      bb_pct_b: range > 0 ? (s.close[i]! - s.bbL[i]!) / range : 0.5,
      rel_volume: Number.isNaN(s.rv[i]!) ? null : s.rv[i]!,
      high20: highest(s.high, i, 20),
      low20: lowest(s.low, i, 20),
      regime: regimeAt(s, i),
    },
    support: sr.support,
    resistance: sr.resistance,
  };
}

/** Index of the last fully-closed bar (the newest candle may still be forming). */
function lastClosed(c: OHLCV[], barMs: number): number {
  const last = c.length - 1;
  return Date.now() - c[last]!.ts < barMs ? last - 1 : last;
}

function candidatesFor(
  s: Series,
  horizon: QuantHorizon,
  barMs: number,
  report: QuantReport,
): Candidate[] {
  const p = PROFILES[horizon];
  const i = lastClosed(s.c, barMs);
  const price = s.close[s.c.length - 1]!;
  const out: Candidate[] = [];
  for (const setup of SETUPS) {
    const stats = backtest(s, setup, p, i);
    report.backtests.push({ horizon, setup_id: setup.id, label: setup.label, direction: setup.direction, stats });
    const sig = setup.detect(s, i);
    if (!sig) continue;
    const sign = setup.direction === 'long' ? 1 : -1;
    const entry = sig.order.type === 'market' ? price : sig.order.price;
    // Skip pending orders that price has already blown through.
    if (sig.order.type === 'limit' && sign * (price - entry) < 0) continue;
    if (sig.order.type === 'stop' && sign * (price - entry) > 0) continue;
    const risk = p.stopAtr * s.atr[i]!;
    const band = Math.max(s.atr[i]! * 0.1, entry * 0.0005);
    out.push({
      setup_id: setup.id,
      label: setup.label,
      horizon,
      direction: setup.direction,
      entry_kind: sig.order.type === 'market' ? 'trigger_now' : setup.entryKind,
      entry_zone: sig.order.type === 'market' ? [price - band, price + band] : [entry - band, entry + band],
      stop_loss: entry - sign * risk,
      targets: p.targetsR.map((r) => entry + sign * risk * r),
      stats,
      why: sig.why,
    });
  }
  return out.sort((a, b) => b.stats.avg_r - a.stats.avg_r);
}

export function runQuant(input: { daily: OHLCV[]; hourly: OHLCV[] }): QuantReport {
  const report: QuantReport = { daily: null, hourly: null, backtests: [], candidates: [] };
  const DAY = 86_400_000;
  const HOUR = 3_600_000;
  if (input.daily.length >= WARMUP + 20) {
    const s = buildSeries(input.daily);
    report.daily = snapshot(s, lastClosed(s.c, DAY), 'daily');
    report.candidates.push(...candidatesFor(s, 'short_term', DAY, report));
    report.candidates.push(...candidatesFor(s, 'medium_term', DAY, report));
  }
  if (input.hourly.length >= WARMUP + 20) {
    const s = buildSeries(input.hourly);
    report.hourly = snapshot(s, lastClosed(s.c, HOUR), 'hourly');
    report.candidates.push(...candidatesFor(s, 'intraday', HOUR, report));
  }
  return report;
}

/**
 * How much the measured stats support a trade. Uses the Wilson lower bound so
 * a 5-for-6 streak doesn't look like an 83% sure thing.
 */
export function convictionFromStats(st: SetupStats): number {
  if (st.n < 8 || st.avg_r <= 0) return 1;
  if (st.win_rate_lower >= 0.55 && st.avg_r >= 0.2) return 5;
  if (st.win_rate_lower >= 0.5 && st.avg_r >= 0.15) return 4;
  if (st.win_rate_lower >= 0.42 && st.avg_r >= 0.08) return 3;
  return 2;
}

/** Text block for the model: facts it must build trade ideas from. */
export function formatQuantForPrompt(q: QuantReport): string {
  const lines: string[] = ['=== QUANT ENGINE (computed from real candles — authoritative) ==='];
  const tf = (t: TimeframeAnalysis | null): void => {
    if (!t) return;
    const x = t.indicators;
    lines.push(
      `${t.timeframe.toUpperCase()} (${t.bars} bars): regime=${x.regime}, price=${fmt(x.price)}, ATR14=${fmt(x.atr)} (${x.atr_pct.toFixed(2)}%), ` +
        `EMA20=${fmt(x.ema20)}, EMA50=${fmt(x.ema50)}${x.ema200 != null ? `, EMA200=${fmt(x.ema200)}` : ''}, RSI14=${x.rsi14.toFixed(1)}, ADX14=${x.adx14.toFixed(1)}, ` +
        `Bollinger %B=${x.bb_pct_b.toFixed(2)}, rel.volume=${x.rel_volume?.toFixed(2) ?? 'n/a'}, 20-bar range ${fmt(x.low20)}–${fmt(x.high20)}`,
    );
    lines.push(
      `  support: ${t.support.map((l) => `${fmt(l.price)} (${l.touches} touches)`).join(', ') || 'none found'}`,
    );
    lines.push(
      `  resistance: ${t.resistance.map((l) => `${fmt(l.price)} (${l.touches} touches)`).join(', ') || 'none found'}`,
    );
  };
  tf(q.daily);
  tf(q.hourly);
  lines.push('', 'BACKTEST of each setup on THIS asset (win = target 1 before stop; avgR exits at target 1):');
  for (const b of q.backtests) {
    if (b.stats.n === 0) continue;
    lines.push(
      `  [${b.horizon}] ${b.setup_id}: n=${b.stats.n}, win ${(b.stats.win_rate * 100).toFixed(0)}% (conservative ${(b.stats.win_rate_lower * 100).toFixed(0)}%), avg ${b.stats.avg_r >= 0 ? '+' : ''}${b.stats.avg_r.toFixed(2)}R, reached T2 ${(b.stats.t2_rate * 100).toFixed(0)}%`,
    );
  }
  lines.push('', 'CANDIDATES FIRING NOW (the only trades you may propose, by setup_id):');
  if (q.candidates.length === 0) lines.push('  none — no setup conditions are met on any horizon right now.');
  for (const c of q.candidates) {
    lines.push(
      `  [${c.horizon}] ${c.setup_id} ${c.direction.toUpperCase()} ${c.entry_kind}: entry ${fmt(c.entry_zone[0])}–${fmt(c.entry_zone[1])}, stop ${fmt(c.stop_loss)}, targets ${c.targets.map(fmt).join(' / ')} | ` +
        `backtest n=${c.stats.n}, win ${(c.stats.win_rate * 100).toFixed(0)}%, avg ${c.stats.avg_r.toFixed(2)}R | ${c.why}`,
    );
  }
  return lines.join('\n');
}
export { buildSeries, SETUPS };
