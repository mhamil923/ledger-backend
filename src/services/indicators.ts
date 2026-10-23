export interface ChartPoint {
  ts: number;
  price: number;
}

export interface OverlayPoint {
  ts: number;
  value: number;
}

/**
 * Simple moving average — for each index i >= period-1, the average of the
 * previous `period` prices. Returns one point per source point that has
 * enough history; earlier points are skipped.
 */
export function simpleMovingAverage(points: ChartPoint[], period: number): OverlayPoint[] {
  if (period <= 0 || points.length < period) return [];
  const out: OverlayPoint[] = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += points[i]!.price;
  out.push({ ts: points[period - 1]!.ts, value: sum / period });
  for (let i = period; i < points.length; i++) {
    sum += points[i]!.price - points[i - period]!.price;
    out.push({ ts: points[i]!.ts, value: sum / period });
  }
  return out;
}

/** Exponential moving average. Seeds with the SMA of the first `period` values, then applies α=2/(period+1). */
export function exponentialMovingAverage(prices: number[], period: number): number[] {
  if (period <= 0 || prices.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = new Array(prices.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i]!;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < prices.length; i++) {
    const ema = prices[i]! * k + prev * (1 - k);
    out[i] = ema;
    prev = ema;
  }
  return out;
}

/**
 * Relative Strength Index using Wilder's smoothing. Returns the RSI series
 * (NaN until enough data). Last element is the latest RSI value.
 */
export function rsi(prices: number[], period = 14): number[] {
  const out: number[] = new Array(prices.length).fill(NaN);
  if (prices.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i]! - prices[i - 1]!;
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i]! - prices[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

/**
 * MACD(12, 26, 9). Standard formula:
 *   MACD line   = EMA12 − EMA26
 *   Signal line = EMA9 of MACD line
 *   Histogram   = MACD − Signal
 */
export function macd(
  prices: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdResult {
  const emaFast = exponentialMovingAverage(prices, fast);
  const emaSlow = exponentialMovingAverage(prices, slow);
  const macdLine: number[] = prices.map((_, i) => {
    const f = emaFast[i];
    const s = emaSlow[i];
    if (f == null || s == null || Number.isNaN(f) || Number.isNaN(s)) return NaN;
    return f - s;
  });
  // Signal is EMA of MACD — but EMA needs no NaNs, so feed only the valid slice
  const validStart = macdLine.findIndex((v) => !Number.isNaN(v));
  let signal: number[] = new Array(prices.length).fill(NaN);
  if (validStart >= 0) {
    const slice = macdLine.slice(validStart);
    const sigSlice = exponentialMovingAverage(slice, signalPeriod);
    for (let i = 0; i < sigSlice.length; i++) {
      signal[validStart + i] = sigSlice[i]!;
    }
  }
  const histogram: number[] = macdLine.map((m, i) => {
    const s = signal[i];
    if (m == null || s == null || Number.isNaN(m) || Number.isNaN(s)) return NaN;
    return m - s;
  });
  return { macd: macdLine, signal, histogram };
}

export interface IndicatorSnapshot {
  rsi14: number | null;
  rsi14_state: 'oversold' | 'neutral' | 'overbought' | null;
  macd: number | null;
  macd_signal: number | null;
  macd_histogram: number | null;
  macd_state: 'bullish_cross' | 'bearish_cross' | 'bullish' | 'bearish' | null;
  sma20_last: number | null;
  sma50_last: number | null;
  price_vs_sma20_pct: number | null;
  price_vs_sma50_pct: number | null;
}

/** Compute a compact snapshot of all indicators for the latest data point. */
export function indicatorSnapshot(points: ChartPoint[]): IndicatorSnapshot {
  const prices = points.map((p) => p.price);
  const last = prices[prices.length - 1] ?? null;
  const sma20 = simpleMovingAverage(points, 20);
  const sma50 = simpleMovingAverage(points, 50);
  const sma20Last = sma20[sma20.length - 1]?.value ?? null;
  const sma50Last = sma50[sma50.length - 1]?.value ?? null;
  const rsiSeries = rsi(prices, 14);
  const rsiLast = lastValid(rsiSeries);
  const macdResult = macd(prices);
  const macdLast = lastValid(macdResult.macd);
  const signalLast = lastValid(macdResult.signal);
  const histLast = lastValid(macdResult.histogram);
  const histPrev = secondLastValid(macdResult.histogram);

  let rsiState: IndicatorSnapshot['rsi14_state'] = null;
  if (rsiLast != null) {
    if (rsiLast < 30) rsiState = 'oversold';
    else if (rsiLast > 70) rsiState = 'overbought';
    else rsiState = 'neutral';
  }

  let macdState: IndicatorSnapshot['macd_state'] = null;
  if (histLast != null) {
    if (histPrev != null && histPrev <= 0 && histLast > 0) macdState = 'bullish_cross';
    else if (histPrev != null && histPrev >= 0 && histLast < 0) macdState = 'bearish_cross';
    else if (histLast > 0) macdState = 'bullish';
    else macdState = 'bearish';
  }

  return {
    rsi14: rsiLast,
    rsi14_state: rsiState,
    macd: macdLast,
    macd_signal: signalLast,
    macd_histogram: histLast,
    macd_state: macdState,
    sma20_last: sma20Last,
    sma50_last: sma50Last,
    price_vs_sma20_pct: last != null && sma20Last != null ? ((last - sma20Last) / sma20Last) * 100 : null,
    price_vs_sma50_pct: last != null && sma50Last != null ? ((last - sma50Last) / sma50Last) * 100 : null,
  };
}

function lastValid(arr: number[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v != null && !Number.isNaN(v)) return v;
  }
  return null;
}

function secondLastValid(arr: number[]): number | null {
  let found = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v != null && !Number.isNaN(v)) {
      found++;
      if (found === 2) return v;
    }
  }
  return null;
}

export interface MarketSentiment {
  fear_greed_index: number;
  fear_greed_label: string;
  source: 'alternative.me';
  ts: number;
}

export interface MarketContext {
  symbol: string;
  asset_type: string;
  current_price: number;
  change_24h_pct: number;
  sample_points: ChartPoint[];
  /**
   * Intraday context: most-recent ~24h of price action so Claude can reason
   * about what just happened in the last few hours. Bucketed to hourly bars
   * before being formatted into the prompt.
   */
  intraday_points?: ChartPoint[];
  indicators?: IndicatorSnapshot;
  range_30d: { high: number; low: number };
  range_90d?: { high: number; low: number };
  sentiment?: MarketSentiment | null;
  /** ISO timestamp of when this snapshot was assembled. Defaults to "now". */
  as_of?: Date;
}

/**
 * Build a textual context block for Claude that summarises recent price action,
 * indicators, and market sentiment so the model can reason about real levels
 * rather than guessing at round numbers.
 */
export function buildMarketContextBlock(ctx: MarketContext): string {
  const lines: string[] = [];
  const asOf = ctx.as_of ?? new Date();
  lines.push(`AS OF: ${asOf.toISOString()} — treat this as RIGHT NOW.`);
  lines.push(`Asset: ${ctx.symbol} (${ctx.asset_type})`);
  lines.push(`Current price: ${formatPrice(ctx.current_price)}`);
  lines.push(`24h change: ${ctx.change_24h_pct.toFixed(2)}%`);
  lines.push(`30-day range: ${formatPrice(ctx.range_30d.low)} – ${formatPrice(ctx.range_30d.high)}`);
  if (ctx.range_90d) {
    lines.push(`90-day range: ${formatPrice(ctx.range_90d.low)} – ${formatPrice(ctx.range_90d.high)}`);
  }

  if (ctx.indicators) {
    const ind = ctx.indicators;
    lines.push('');
    lines.push('Technical indicators (latest values):');
    if (ind.sma20_last != null) {
      lines.push(
        `  SMA20: ${formatPrice(ind.sma20_last)}${
          ind.price_vs_sma20_pct != null ? ` (price ${ind.price_vs_sma20_pct >= 0 ? '+' : ''}${ind.price_vs_sma20_pct.toFixed(2)}% vs SMA20)` : ''
        }`,
      );
    }
    if (ind.sma50_last != null) {
      lines.push(
        `  SMA50: ${formatPrice(ind.sma50_last)}${
          ind.price_vs_sma50_pct != null ? ` (price ${ind.price_vs_sma50_pct >= 0 ? '+' : ''}${ind.price_vs_sma50_pct.toFixed(2)}% vs SMA50)` : ''
        }`,
      );
    }
    if (ind.rsi14 != null) {
      lines.push(`  RSI(14): ${ind.rsi14.toFixed(1)} — ${ind.rsi14_state}`);
    }
    if (ind.macd != null && ind.macd_signal != null && ind.macd_histogram != null) {
      lines.push(
        `  MACD(12,26,9): line ${ind.macd.toFixed(4)}, signal ${ind.macd_signal.toFixed(4)}, histogram ${ind.macd_histogram.toFixed(4)} — ${ind.macd_state}`,
      );
    }
  }

  if (ctx.sentiment) {
    lines.push('');
    lines.push(
      `Crypto market sentiment (Fear & Greed Index): ${ctx.sentiment.fear_greed_index} — ${ctx.sentiment.fear_greed_label} (whole-market gauge, not asset-specific)`,
    );
  }

  if (ctx.intraday_points && ctx.intraday_points.length > 0) {
    const hourly = bucketHourly(ctx.intraday_points);
    if (hourly.length > 0) {
      lines.push('');
      lines.push('Last 24h hourly snapshot (oldest → newest, most relevant for short-term entry):');
      for (const p of hourly) {
        const d = new Date(p.ts);
        const stamp = `${d.toISOString().slice(11, 16)}Z`;
        lines.push(`  ${stamp}: ${formatPrice(p.price)}`);
      }
    }
  }

  lines.push('');
  lines.push('Recent daily closes (oldest → newest):');
  const downsampled = downsample(ctx.sample_points, 30);
  for (const p of downsampled) {
    const date = new Date(p.ts).toISOString().slice(0, 10);
    lines.push(`  ${date}: ${formatPrice(p.price)}`);
  }
  return lines.join('\n');
}

/**
 * Bucket fine-grained intraday points into one sample per hour. Picks the last
 * sample within each hour bucket so the most-recent intra-hour price wins.
 */
function bucketHourly(points: ChartPoint[]): ChartPoint[] {
  const byHour = new Map<number, ChartPoint>();
  for (const p of points) {
    const bucket = Math.floor(p.ts / 3_600_000);
    byHour.set(bucket, p);
  }
  return [...byHour.values()].sort((a, b) => a.ts - b.ts);
}

function downsample(points: ChartPoint[], target: number): ChartPoint[] {
  if (points.length <= target) return points;
  const step = points.length / target;
  const out: ChartPoint[] = [];
  for (let i = 0; i < target; i++) {
    const idx = Math.min(Math.floor(i * step), points.length - 1);
    out.push(points[idx]!);
  }
  return out;
}

function formatPrice(value: number): string {
  if (value === 0) return '$0';
  const abs = Math.abs(value);
  if (abs < 0.0001) return `$${value.toExponential(3)}`;
  if (abs < 1) return `$${value.toFixed(6)}`;
  if (abs < 100) return `$${value.toFixed(4)}`;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
