// Technical-analysis primitives for the quant engine. Pure functions over
// OHLCV candles, no look-ahead: value[i] only uses candles[0..i].

export interface OHLCV {
  ts: number; // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (used by RSI, ATR, ADX). */
function wilder(values: number[], period: number, start: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < start + period) return out;
  let prev = 0;
  for (let i = start; i < start + period; i++) prev += values[i]!;
  prev /= period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]!) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], period = 14): number[] {
  const gains = closes.map((c, i) => (i === 0 ? 0 : Math.max(0, c - closes[i - 1]!)));
  const losses = closes.map((c, i) => (i === 0 ? 0 : Math.max(0, closes[i - 1]! - c)));
  const ag = wilder(gains, period, 1);
  const al = wilder(losses, period, 1);
  return closes.map((_, i) => {
    if (Number.isNaN(ag[i]!) || Number.isNaN(al[i]!)) return NaN;
    if (al[i] === 0) return 100;
    return 100 - 100 / (1 + ag[i]! / al[i]!);
  });
}

export function trueRange(c: OHLCV[]): number[] {
  return c.map((k, i) => {
    if (i === 0) return k.high - k.low;
    const pc = c[i - 1]!.close;
    return Math.max(k.high - k.low, Math.abs(k.high - pc), Math.abs(k.low - pc));
  });
}

export function atr(c: OHLCV[], period = 14): number[] {
  return wilder(trueRange(c), period, 0);
}

/** ADX(14): trend strength, 0–100. >20–25 = trending, <20 = choppy. */
export function adx(c: OHLCV[], period = 14): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const n = c.length;
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = c[i]!.high - c[i - 1]!.high;
    const down = c[i - 1]!.low - c[i]!.low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = wilder(trueRange(c), period, 1);
  const pdm = wilder(plusDM, period, 1);
  const mdm = wilder(minusDM, period, 1);
  const plusDI = tr.map((t, i) => (t > 0 ? (100 * pdm[i]!) / t : NaN));
  const minusDI = tr.map((t, i) => (t > 0 ? (100 * mdm[i]!) / t : NaN));
  const dx = plusDI.map((p, i) => {
    const m = minusDI[i]!;
    return Number.isNaN(p) || Number.isNaN(m) || p + m === 0 ? NaN : (100 * Math.abs(p - m)) / (p + m);
  });
  const firstValid = dx.findIndex((v) => !Number.isNaN(v));
  const adxArr = firstValid < 0 ? new Array<number>(n).fill(NaN) : wilder(dx.map((v) => (Number.isNaN(v) ? 0 : v)), period, firstValid);
  return { adx: adxArr, plusDI, minusDI };
}

export function bollinger(closes: number[], period = 20, mult = 2): { mid: number[]; upper: number[]; lower: number[] } {
  const mid = sma(closes, period);
  const upper = new Array<number>(closes.length).fill(NaN);
  const lower = new Array<number>(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j]! - mid[i]!) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = mid[i]! + mult * sd;
    lower[i] = mid[i]! - mult * sd;
  }
  return { mid, upper, lower };
}

/** Volume relative to its trailing average (1.0 = normal). */
export function relativeVolume(c: OHLCV[], period = 20): number[] {
  const vol = c.map((k) => k.volume);
  const avg = sma(vol, period);
  return vol.map((v, i) => (i > 0 && avg[i - 1]! > 0 ? v / avg[i - 1]! : NaN));
}

export function highest(values: number[], end: number, lookback: number): number {
  let m = -Infinity;
  for (let i = Math.max(0, end - lookback + 1); i <= end; i++) m = Math.max(m, values[i]!);
  return m;
}

export function lowest(values: number[], end: number, lookback: number): number {
  let m = Infinity;
  for (let i = Math.max(0, end - lookback + 1); i <= end; i++) m = Math.min(m, values[i]!);
  return m;
}

export interface Level {
  price: number;
  kind: 'support' | 'resistance';
  touches: number;
  last_touch_ts: number;
}

/**
 * Support/resistance from confirmed swing pivots (a high/low that's the
 * extreme of `wing` bars on each side), clustered within 0.6 ATR. Ranked by
 * number of touches, then recency.
 */
export function supportResistance(c: OHLCV[], atrNow: number, wing = 3, max = 4): { support: Level[]; resistance: Level[] } {
  const piv: Array<{ price: number; ts: number }> = [];
  for (let i = wing; i < c.length - wing; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;
      if (c[j]!.high >= c[i]!.high) isHigh = false;
      if (c[j]!.low <= c[i]!.low) isLow = false;
    }
    if (isHigh) piv.push({ price: c[i]!.high, ts: c[i]!.ts });
    if (isLow) piv.push({ price: c[i]!.low, ts: c[i]!.ts });
  }
  const tol = Math.max(atrNow * 0.6, (c[c.length - 1]?.close ?? 0) * 0.002);
  const clusters: Array<{ sum: number; n: number; last: number }> = [];
  for (const p of piv.sort((a, b) => a.price - b.price)) {
    const cl = clusters.find((k) => Math.abs(k.sum / k.n - p.price) <= tol);
    if (cl) {
      cl.sum += p.price;
      cl.n += 1;
      cl.last = Math.max(cl.last, p.ts);
    } else clusters.push({ sum: p.price, n: 1, last: p.ts });
  }
  const price = c[c.length - 1]!.close;
  const levels: Level[] = clusters.map((k) => {
    const lv = k.sum / k.n;
    return { price: lv, kind: lv < price ? 'support' : 'resistance', touches: k.n, last_touch_ts: k.last };
  });
  const rank = (a: Level, b: Level): number =>
    Math.abs(a.price - price) - Math.abs(b.price - price) || b.touches - a.touches;
  return {
    support: levels.filter((l) => l.kind === 'support').sort(rank).slice(0, max),
    resistance: levels.filter((l) => l.kind === 'resistance').sort(rank).slice(0, max),
  };
}

/** Wilson score lower bound — a win rate you can trust at small sample sizes. */
export function wilsonLower(wins: number, n: number, z = 1.28): number {
  if (n === 0) return 0;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}
