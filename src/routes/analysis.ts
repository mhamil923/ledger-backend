import { Router } from 'express';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { query } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import {
  getAnthropicClient,
  isAnthropicConfigured,
  resolveModel,
  type ModelTier,
} from '../services/anthropic.js';
import { getQuote } from '../services/quotes.js';
import { getCryptoChart } from '../services/coingecko.js';
import {
  buildMarketContextBlock,
  indicatorSnapshot,
  type IndicatorSnapshot,
  type MarketSentiment,
} from '../services/indicators.js';
import { getCryptoFearGreed } from '../services/sentiment.js';
import {
  formatSymbolActivityForPrompt,
  formatTrackRecordForPrompt,
  getSymbolActivity,
  getTrackRecord,
  recordTradeIdea,
  resolvePendingTrades,
  type SymbolActivity,
} from '../services/trade-journal.js';

export const analysisRouter = Router();

const requestSchema = z.object({
  symbol: z.string().min(1).max(20).transform((s) => s.toUpperCase()),
  asset_type: z.enum(['stock', 'crypto', 'etf']),
  external_id: z.string().max(120).optional(),
  force_refresh: z.boolean().optional().default(false),
  model_tier: z.enum(['fast', 'deep']).optional().default('fast'),
  /**
   * Deprecated — analysis now always returns all 4 horizons in one call.
   * Accepted for backward compatibility with older clients but ignored.
   */
  analysis_horizon: z
    .enum(['intraday', 'short_term', 'medium_term', 'long_term'])
    .optional(),
});

type AnalysisHorizon = 'intraday' | 'short_term' | 'medium_term' | 'long_term';

export type EntryKind = 'trigger_now' | 'pullback' | 'breakout' | 'waiting';

export interface TradeIdea {
  direction: 'long' | 'short';
  entry_zone: [number, number];
  stop_loss: number;
  targets: number[];
  rationale: string;
  /** Per-horizon conviction (1-5). With one analysis covering 4 horizons each
   *  one rates separately — you might be 4/5 on the long-term hold but 1/5
   *  on the day trade. */
  conviction: number;
  /**
   * How the entry should be played relative to current price:
   * - trigger_now: enter immediately (entry zone is at/near spot)
   * - pullback: wait for a retrace into entry
   * - breakout: wait for price to break entry zone before entering
   * - waiting: setup not yet valid; watching for trigger
   */
  entry_kind?: EntryKind;
}

export interface TradeIdeasByHorizon {
  intraday: TradeIdea | null;
  short_term: TradeIdea | null;
  medium_term: TradeIdea | null;
  long_term: TradeIdea | null;
}

export interface AlternativeScenario {
  if: string;
  then: string;
}

export interface MultiTimeframe {
  short_term: string;
  medium_term: string;
  long_term: string;
}

export interface AnalysisData {
  headline: string;
  summary_markdown: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  /** Which of the 4 horizons Claude considers the highest-conviction play
   *  right now. Used by the client to default the horizon chip selection. */
  primary_horizon: 'intraday' | 'short_term' | 'medium_term' | 'long_term';
  /** Asset-wide top-line conviction (1-5). Per-horizon convictions live on
   *  each trade idea. */
  conviction: number;
  /** Legacy alias — same value as primary_horizon. Kept so older client
   *  code that reads time_horizon doesn't break during the transition. */
  time_horizon: 'intraday' | 'short_term' | 'medium_term' | 'long_term';
  /** All four trade ideas in one shot — replaces the old single trade_idea.
   *  Any slot can be null if Claude declines that timeframe. */
  trade_ideas: TradeIdeasByHorizon;
  key_levels: { support: number[]; resistance: number[] };
  risks: string[];
  // Deep-dive-only fields. Populated when model_tier='deep', otherwise undefined.
  confluence_factors?: string[];
  multi_timeframe?: MultiTimeframe;
  alternative_scenarios?: AlternativeScenario[];
  catalysts?: string[];
  position_sizing?: string;
  indicators?: IndicatorSnapshot;
  sentiment?: MarketSentiment | null;
}

interface CachedRow {
  id: string;
  content: string;
  model: string;
  analysis_date: Date;
  created_at: Date;
  analysis_data: AnalysisData | null;
}

/** Reusable sub-schema for a single trade idea. Used 4 times — once per
 *  horizon — so that one Claude call returns trade plans for day / swing /
 *  position / hold simultaneously. Each idea has its OWN conviction so the
 *  model can say "0/5 on the day trade, 4/5 on the long-term hold". */
const tradeIdeaSchema = {
  type: 'object',
  properties: {
    direction: { type: 'string', enum: ['long', 'short'] },
    entry_zone: {
      type: 'array',
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
    },
    entry_kind: {
      type: 'string',
      enum: ['trigger_now', 'pullback', 'breakout', 'waiting'],
      description:
        'trigger_now: enter immediately, zone within ±0.5% of AS OF price. pullback: wait for retrace. breakout: wait for the zone to clear. waiting: not yet actionable.',
    },
    stop_loss: { type: 'number' },
    targets: { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 3 },
    rationale: { type: 'string', description: 'One paragraph tailored to THIS horizon only.' },
    conviction: {
      type: 'integer',
      minimum: 1,
      maximum: 5,
      description: '1 = no edge, 5 = strong confluence FOR THIS HORIZON.',
    },
  },
  required: [
    'direction',
    'entry_zone',
    'entry_kind',
    'stop_loss',
    'targets',
    'rationale',
    'conviction',
  ],
};

const TRADE_IDEAS_PROPS = {
  intraday: {
    ...tradeIdeaSchema,
    description:
      'DAY TRADE — enter and exit within a single session (hours). Tight stops. Targets reachable within hours, not days. Lean on the last 24h hourly snapshot.',
  },
  short_term: {
    ...tradeIdeaSchema,
    description:
      'SWING — hold 3-14 days. Reference daily structure (SMA20, recent daily swing highs/lows). Targets reachable within 1-2 weeks.',
  },
  medium_term: {
    ...tradeIdeaSchema,
    description:
      'POSITION — hold 1-6 months. Reference weekly/30-90 day structure, SMA50, broader regime. Targets are 10-40% moves.',
  },
  long_term: {
    ...tradeIdeaSchema,
    description:
      'LONG-TERM HOLD — 6+ months. Frame entry_zone as a DCA accumulation band, stop_loss as the level that invalidates the long-term thesis (NOT a tight stop), targets as where you would trim over 1-3 years. entry_kind almost always "pullback" or "waiting".',
  },
};

const ANALYSIS_TOOL: Anthropic.Tool = {
  name: 'submit_analysis',
  description:
    'Submit your structured analysis for this asset, with trade ideas for all 4 timeframes in one call.',
  input_schema: {
    type: 'object',
    properties: {
      headline: {
        type: 'string',
        description: 'One-sentence summary of your overall read across timeframes.',
      },
      summary_markdown: {
        type: 'string',
        description:
          'Markdown analysis, 200-400 words. Cover the asset-wide picture (indicators, sentiment), then briefly call out which horizon has the best setup right now.',
      },
      bias: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
      conviction: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description:
          'Overall asset-level conviction (separate from per-horizon convictions inside trade_ideas).',
      },
      primary_horizon: {
        type: 'string',
        enum: ['intraday', 'short_term', 'medium_term', 'long_term'],
        description:
          'Which of the four trade ideas has the strongest setup right now. The UI defaults to showing this one. Pick the one with highest conviction + cleanest R:R.',
      },
      time_horizon: {
        type: 'string',
        enum: ['intraday', 'short_term', 'medium_term', 'long_term'],
        description: 'Same value as primary_horizon (kept for backward compat).',
      },
      key_levels: {
        type: 'object',
        properties: {
          support: { type: 'array', items: { type: 'number' } },
          resistance: { type: 'array', items: { type: 'number' } },
        },
        required: ['support', 'resistance'],
      },
      trade_ideas: {
        type: 'object',
        description:
          'All FOUR trade ideas — one per horizon. Each is independent: a horizon you have no conviction in still gets a fully-formed object with conviction=1.',
        properties: TRADE_IDEAS_PROPS,
        required: ['intraday', 'short_term', 'medium_term', 'long_term'],
      },
      risks: { type: 'array', items: { type: 'string' } },
    },
    required: [
      'headline',
      'summary_markdown',
      'bias',
      'conviction',
      'primary_horizon',
      'time_horizon',
      'key_levels',
      'trade_ideas',
      'risks',
    ],
  },
};

/**
 * Deep-dive variant: same multi-horizon shape as the default tool plus
 * required enrichment fields (confluence, multi-timeframe, scenarios,
 * catalysts, position sizing). All 4 trade_ideas are required.
 */
const DEEP_ANALYSIS_TOOL: Anthropic.Tool = {
  name: 'submit_analysis',
  description:
    'Submit a deep analysis with trade plans for ALL FOUR horizons (day/swing/position/hold) plus the enrichment fields.',
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string' },
      summary_markdown: {
        type: 'string',
        description:
          'Markdown analysis, 400-700 words. Cover: overall thesis, what each horizon looks like, multi-timeframe alignment, which horizon you trust most right now and why, what could go wrong, catalysts.',
      },
      bias: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
      conviction: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description: 'Overall asset-level conviction.',
      },
      primary_horizon: {
        type: 'string',
        enum: ['intraday', 'short_term', 'medium_term', 'long_term'],
        description:
          'Which of the 4 trade ideas has the strongest risk/reward right now. UI defaults to it.',
      },
      time_horizon: {
        type: 'string',
        enum: ['intraday', 'short_term', 'medium_term', 'long_term'],
        description: 'Same value as primary_horizon (kept for backward compat).',
      },
      key_levels: {
        type: 'object',
        properties: {
          support: { type: 'array', items: { type: 'number' } },
          resistance: { type: 'array', items: { type: 'number' } },
        },
        required: ['support', 'resistance'],
      },
      trade_ideas: {
        type: 'object',
        description:
          'All FOUR trade ideas. Required for deep analysis — every slot must be a fully-formed object with its own conviction. Use conviction=1 for horizons you have no edge on, never omit.',
        properties: TRADE_IDEAS_PROPS,
        required: ['intraday', 'short_term', 'medium_term', 'long_term'],
      },
      risks: { type: 'array', items: { type: 'string' } },
      confluence_factors: {
        type: 'array',
        items: { type: 'string' },
        description:
          '3-5 specific reasons that ALIGN behind the highest-conviction horizon (e.g. "RSI crossed up from 32", "price reclaimed SMA20 on increasing volume", "F&G shifted from Fear to Neutral").',
      },
      multi_timeframe: {
        type: 'object',
        description: 'How the chart looks at three reference windows.',
        properties: {
          short_term: { type: 'string', description: 'Hours-to-days view.' },
          medium_term: { type: 'string', description: 'Weeks view.' },
          long_term: { type: 'string', description: 'Months view.' },
        },
        required: ['short_term', 'medium_term', 'long_term'],
      },
      alternative_scenarios: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            if: { type: 'string' },
            then: { type: 'string' },
          },
          required: ['if', 'then'],
        },
        minItems: 2,
        maxItems: 3,
      },
      catalysts: { type: 'array', items: { type: 'string' } },
      position_sizing: { type: 'string' },
    },
    required: [
      'headline',
      'summary_markdown',
      'bias',
      'conviction',
      'primary_horizon',
      'time_horizon',
      'key_levels',
      'trade_ideas',
      'risks',
      'confluence_factors',
      'multi_timeframe',
      'alternative_scenarios',
      'catalysts',
      'position_sizing',
    ],
  },
};

function sanitizeTradeIdea(raw: unknown): TradeIdea | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.direction !== 'long' && r.direction !== 'short') return null;
  const zone = r.entry_zone;
  if (
    !Array.isArray(zone) ||
    zone.length !== 2 ||
    typeof zone[0] !== 'number' ||
    typeof zone[1] !== 'number' ||
    !Number.isFinite(zone[0]) ||
    !Number.isFinite(zone[1])
  ) {
    return null;
  }
  if (typeof r.stop_loss !== 'number' || !Number.isFinite(r.stop_loss)) return null;
  if (!Array.isArray(r.targets)) return null;
  const targets = r.targets.filter(
    (t): t is number => typeof t === 'number' && Number.isFinite(t),
  );
  if (targets.length === 0) return null;
  const entryKindRaw = r.entry_kind;
  const entry_kind: EntryKind | undefined =
    entryKindRaw === 'trigger_now' ||
    entryKindRaw === 'pullback' ||
    entryKindRaw === 'breakout' ||
    entryKindRaw === 'waiting'
      ? entryKindRaw
      : undefined;
  const conviction =
    typeof r.conviction === 'number' && Number.isFinite(r.conviction)
      ? Math.max(1, Math.min(5, Math.round(r.conviction)))
      : 1;
  return {
    direction: r.direction,
    entry_zone: [zone[0], zone[1]],
    entry_kind,
    stop_loss: r.stop_loss,
    targets,
    rationale: typeof r.rationale === 'string' ? r.rationale : '',
    conviction,
  };
}

function sanitizeTradeIdeas(raw: unknown): TradeIdeasByHorizon {
  const out: TradeIdeasByHorizon = {
    intraday: null,
    short_term: null,
    medium_term: null,
    long_term: null,
  };
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    out.intraday = sanitizeTradeIdea(r.intraday);
    out.short_term = sanitizeTradeIdea(r.short_term);
    out.medium_term = sanitizeTradeIdea(r.medium_term);
    out.long_term = sanitizeTradeIdea(r.long_term);
  }
  return out;
}

/**
 * Sanitize the full structured analysis returned by Claude. Applied to both
 * fresh responses and cached rows, so the client never receives malformed
 * shapes. Missing/invalid trade_idea → null. Missing key_levels → empty arrays.
 */
function sanitizeAnalysisData(raw: AnalysisData | null): AnalysisData | null {
  if (!raw || typeof raw !== 'object') return null;
  const supportRaw = raw.key_levels?.support;
  const resistanceRaw = raw.key_levels?.resistance;
  const support = Array.isArray(supportRaw)
    ? supportRaw.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
  const resistance = Array.isArray(resistanceRaw)
    ? resistanceRaw.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
  const risks = Array.isArray(raw.risks)
    ? raw.risks.filter((s): s is string => typeof s === 'string')
    : [];
  // Backward compat for cached rows from the per-horizon era: those rows had
  // a single `trade_idea` and no `trade_ideas`. Promote that one into the
  // matching slot so old caches still render something useful.
  const rawRecord = raw as unknown as Record<string, unknown>;
  const legacyTradeIdea = sanitizeTradeIdea(rawRecord.trade_idea);
  const rawTradeIdeas = rawRecord.trade_ideas;
  let trade_ideas: TradeIdeasByHorizon = sanitizeTradeIdeas(rawTradeIdeas);
  if (
    legacyTradeIdea &&
    !trade_ideas.intraday &&
    !trade_ideas.short_term &&
    !trade_ideas.medium_term &&
    !trade_ideas.long_term
  ) {
    const horizon =
      raw.time_horizon === 'intraday' ||
      raw.time_horizon === 'short_term' ||
      raw.time_horizon === 'medium_term' ||
      raw.time_horizon === 'long_term'
        ? raw.time_horizon
        : 'short_term';
    trade_ideas = { ...trade_ideas, [horizon]: legacyTradeIdea };
  }
  const time_horizon =
    raw.time_horizon === 'intraday' ||
    raw.time_horizon === 'short_term' ||
    raw.time_horizon === 'medium_term' ||
    raw.time_horizon === 'long_term'
      ? raw.time_horizon
      : 'short_term';
  const primaryRaw = rawRecord.primary_horizon;
  const primary_horizon =
    primaryRaw === 'intraday' ||
    primaryRaw === 'short_term' ||
    primaryRaw === 'medium_term' ||
    primaryRaw === 'long_term'
      ? primaryRaw
      : time_horizon;
  return {
    headline: typeof raw.headline === 'string' ? raw.headline : '',
    summary_markdown: typeof raw.summary_markdown === 'string' ? raw.summary_markdown : '',
    bias: raw.bias === 'bullish' || raw.bias === 'bearish' || raw.bias === 'neutral' ? raw.bias : 'neutral',
    conviction:
      typeof raw.conviction === 'number' && Number.isFinite(raw.conviction)
        ? Math.max(1, Math.min(5, Math.round(raw.conviction)))
        : 1,
    primary_horizon,
    time_horizon,
    trade_ideas,
    key_levels: { support, resistance },
    risks,
    confluence_factors: Array.isArray(raw.confluence_factors)
      ? raw.confluence_factors.filter((s): s is string => typeof s === 'string')
      : undefined,
    multi_timeframe:
      raw.multi_timeframe &&
      typeof raw.multi_timeframe.short_term === 'string' &&
      typeof raw.multi_timeframe.medium_term === 'string' &&
      typeof raw.multi_timeframe.long_term === 'string'
        ? raw.multi_timeframe
        : undefined,
    alternative_scenarios: Array.isArray(raw.alternative_scenarios)
      ? raw.alternative_scenarios.filter(
          (s): s is AlternativeScenario =>
            !!s && typeof s === 'object' && typeof s.if === 'string' && typeof s.then === 'string',
        )
      : undefined,
    catalysts: Array.isArray(raw.catalysts)
      ? raw.catalysts.filter((s): s is string => typeof s === 'string')
      : undefined,
    position_sizing:
      typeof raw.position_sizing === 'string' ? raw.position_sizing : undefined,
    indicators: raw.indicators,
    sentiment: raw.sentiment,
  };
}

const SYSTEM_PROMPT = `You are a concise, data-driven analyst writing for an experienced retail trader.
The user message contains: an "AS OF" snapshot timestamp, current quote, 30-day price series, the last 24 hours of intraday action (when available), computed indicators (SMA20/50, RSI14, MACD), broader market sentiment, and a JOURNAL of your previous trade ideas with their actual outcomes.

CORE TASK: One call covers ALL FOUR timeframes. You MUST return four trade ideas in the trade_ideas field — intraday, short_term, medium_term, long_term — each with its OWN entry/stop/targets/rationale/conviction tailored to THAT horizon. The user picks which one to act on.

Per-horizon rules:
- intraday (DAY TRADE, hours): tight stops; targets reachable within hours; lean on the 24h hourly snapshot; do NOT propose "wait for SMA50 retest" — that's days away.
- short_term (SWING, 3-14 days): daily structure (SMA20, recent swing points); stops at the latest daily swing; targets within 1-2 weeks.
- medium_term (POSITION, 1-6 months): weekly structure, SMA50, regime; wider stops; targets are 10-40% moves over months.
- long_term (HOLD, 6+ months): reframe as ACCUMULATION — entry_zone is your DCA band, stop_loss is the thesis-invalidation level (NOT a tight stop), targets are 1-3 year trim levels. entry_kind almost always "pullback" or "waiting".

If you have no edge on a horizon, set its conviction=1 and propose a waiting-zone trade. NEVER omit a horizon.

Universal rules:
- Treat "AS OF" as RIGHT NOW.
- Reference specific numbers (RSI value, SMA distances, MACD state). No round-number anchoring.
- Direction must match the horizon's own logic (a horizon can disagree with another).
- Stop must invalidate the thesis but allow normal volatility.
- If RSI is extreme (>75 or <25), favour mean reversion at intraday/swing; on hold, that's just a DCA window.
- Always include "not investment advice" inside summary_markdown.

ENTRY KIND RULES (per idea):
- trigger_now: entry_zone within ±0.5% of AS OF price. Setup is live RIGHT NOW.
- pullback: entry below current (long) or above (short). Specify a real level.
- breakout: entry_zone is the level price must clear; enter AFTER the break.
- waiting: setup not actionable yet (conviction 1-2).
- NEVER submit a trigger_now whose entry has already been passed by AS OF price — switch to breakout or pullback.

CRITICAL — use your journal:
- The journal now includes AGGREGATE BREAKDOWNS by direction, horizon, conviction, and RSI regime. READ THEM. The prompt block below your context tells you exactly which of your past setups have won and which have lost.
- If your CURRENT proposal matches a slice with <45% win rate at n≥5, DOWNGRADE conviction by 1 or switch entry_kind to "waiting". Do not force a trade into a losing pattern.
- If your BY CONVICTION breakdown shows conviction=4 has a WORSE win rate than conviction=2 (this happens when the model is over-confident), do NOT assign conviction 4-5 to a new idea unless it is CLEARLY structurally cleaner than the past losers. Prefer conviction 2-3.
- If your overall expectancy is NEGATIVE, be MUCH more willing to use conviction=1 waiting trades. A pass is worth more than a bad committed trade.
- Reference the journal in summary_markdown ("my recent long trades in this RSI regime have a 30% win rate — sizing down / using waiting entry" is far more useful than "I feel bullish").

Always call submit_analysis exactly once with primary_horizon set to whichever idea has the strongest setup right now.`;

const DEEP_SYSTEM_PROMPT = `You are running in DEEP DIVE mode for an experienced retail trader. The user paid premium Opus tokens — match that expectation with substantially more thorough analysis.

THIS IS NON-NEGOTIABLE: an empty or refusing response is treated as a BUG and gets retried at higher cost. Every field below must contain real content. There is no acceptable "I decline" path. Even if every signal is mixed, you produce a watchful-but-committed analysis.

The user message contains: AS OF snapshot, current quote, 90-365 day price series, last 24h intraday action, computed indicators (SMA20/50, RSI14, MACD), broader market sentiment, and a JOURNAL of your previous trade ideas with their outcomes.

ABSOLUTE REQUIREMENT — trade_ideas MUST contain ALL FOUR fully-formed trade objects on every Deep Dive response. NO EXCEPTIONS.

EXAMPLE — for a horizon where you have NO edge whatsoever, use a watching/waiting plan like this (substitute real numbers from the data):
  {
    "direction": "long",                       // pick the cleaner side based on bias
    "entry_zone": [0.2100, 0.2110],            // tight band at the next plausible level (SMA20, prior support)
    "entry_kind": "waiting",
    "stop_loss": 0.2030,                       // FAR ENOUGH below the level that noise won't clip you
    "targets": [0.2300],                       // target gives R:R of at least 1.5:1 vs the stop
    "rationale": "No clean setup right now. Watching for retest of SMA20 at $0.2105 for entry consideration.",
    "conviction": 1
  }
Copy this pattern when uncertain — but ALWAYS PROVIDE A TRADE.

HARD QUALITY RULES — every trade you submit must satisfy:

1. R:R MINIMUM 1.5:1 to the FIRST target.
   Formula: |target1 - entry_mid| / |entry_mid - stop_loss| ≥ 1.5
   Server-side gate: any trade with R:R < 1.5 gets auto-downgraded to waiting/conviction=1.

2. STOP DISTANCE MUST SCALE WITH THE HORIZON. Do NOT apply a blanket 2% stop rule — that conflicts with intraday targets and produces R:R < 1 trades.
   - intraday: stop 0.5%–1.2% away. Target 1%–2%. R:R math works because both are small.
   - short_term: stop 1.5%–3% away. Target 3%–6%. R:R 1.5–2:1.
   - medium_term: stop 4%–8% away. Target 10%–25%. R:R 2–3:1.
   - long_term (accumulation): stop 15%+ below (thesis-invalidation level, NOT a trade stop). Target 30–100%+.

3. THE R:R-FIRST DISCIPLINE — how to actually build a trade:
   a. Identify the level that would invalidate the thesis. That's your stop.
   b. Measure how far it is from the entry midpoint.
   c. First target must be AT LEAST 1.5× that distance in the trade direction.
   d. If the nearest real resistance/support level is CLOSER than 1.5× the stop distance, this is NOT a tradeable setup. Set entry_kind="waiting", conviction=1, and say "no R:R that clears the bar — waiting for expansion" in the rationale.
   e. DO NOT jam a stop wider than the horizon calls for just to hit a distant target — that's how you get R:R math that looks good on paper and blows through the stop in the first hour.

4. BREAKOUT TRADES: stop must be below the entry_zone LOW by enough to survive a fake-out (typically 0.5-1× the recent intraday range). Never put the stop at the same level as a 90-day low or other obvious magnet.

5. CALIBRATION CHECK: cross-reference against the journal breakdowns. If your direction + horizon + RSI regime slice has <45% win rate at n≥5, downgrade — lower conviction or switch to waiting. Do not commit to a losing pattern.

6. If your best trade violates any of these, don't fake it. entry_kind="waiting", conviction=1, rationale explains what you're watching for.

The trade_ideas field has four slots — intraday, short_term, medium_term, long_term. Each slot is a fully populated trade object with:
- direction: "long" or "short"
- entry_zone: [low_price, high_price]
- entry_kind: "trigger_now" | "pullback" | "breakout" | "waiting"
- stop_loss
- targets (array, 1-3 numbers)
- rationale (paragraph tailored to THAT horizon)
- conviction (1-5, for THAT horizon)

Per-horizon expectations:
- intraday (DAY TRADE, hours): tight stops; targets within hours; lean on 24h hourly snapshot; conviction reflects intraday momentum.
- short_term (SWING, 3-14 days): daily structure; stops at the latest daily swing; targets within 1-2 weeks.
- medium_term (POSITION, 1-6 months): weekly structure, SMA50, regime, macro; wider stops; 10-40% targets.
- long_term (HOLD, 6+ months): accumulation plan — entry_zone is the DCA band, stop_loss is the THESIS-invalidation level, targets are 1-3 year trim points. entry_kind almost always "pullback" or "waiting".

If a horizon has no edge, set its conviction=1 and propose a waiting-zone trade. NEVER omit a horizon. NEVER return null in any slot.

ENTRY KIND RULES (apply per idea):
- The user reads this seconds after you submit. Treat AS OF as RIGHT NOW.
- trigger_now → entry_zone within ±0.5% of AS OF. Use only when setup is live right now.
- pullback → entry below current (long) or above (short). Specify a real level.
- breakout → entry_zone is the level price must clear; enter AFTER the break.
- waiting → setup not actionable yet (conviction 1-2). entry_zone is the level you're watching.
- If a trigger_now would already be invalidated by AS OF price, switch to breakout or pullback.

You MUST also provide (all required by the tool):
- primary_horizon: which of the 4 ideas has the strongest setup right now. UI defaults to this.
- 3-5 specific CONFLUENCE FACTORS aligning behind the primary horizon.
- A MULTI-TIMEFRAME read across short_term/medium_term/long_term reference windows.
- 2-3 ALTERNATIVE SCENARIOS as "if X then Y".
- 2-4 CATALYSTS to watch.
- A one-line POSITION SIZING suggestion.

summary_markdown: 400-700 words. Cover: overall thesis, each horizon briefly, multi-timeframe alignment, which horizon you trust most and why, risks, catalysts. Reference specific numbers (RSI, SMA distances, MACD state). Reference your journal when relevant. Always include "not investment advice".

DEGENERATE RESPONSES (will be rejected and retried):
- headline: ""
- summary_markdown: "" or under 200 words
- key_levels with empty support OR empty resistance arrays
- risks: [] (empty)
- ANY trade_ideas slot set to null
- ANY trade_ideas slot missing required fields (direction, entry_zone, stop_loss, targets, rationale, conviction)

Call submit_analysis exactly once. Do not return plain text — the UI only renders tool output.`;

/**
 * Compute risk/reward ratio (target1 vs stop) from an entry midpoint.
 * Returns null for malformed input so callers can degrade gracefully.
 */
function computeRR(idea: TradeIdea): number | null {
  const [lo, hi] = idea.entry_zone;
  const entryMid = (lo + hi) / 2;
  const risk = Math.abs(entryMid - idea.stop_loss);
  if (risk <= 0) return null;
  const firstTarget = idea.targets[0];
  if (firstTarget == null) return null;
  const reward = Math.abs(firstTarget - entryMid);
  return reward / risk;
}

interface GateResult {
  ideas: TradeIdeasByHorizon;
  notes: string[];
}

/**
 * Server-side enforcement of quality rules. Runs AFTER Claude returns but
 * BEFORE we save to the journal or reply to the client.
 *
 * Philosophy: the R:R gate is a hard math check — a trade with R:R < 1.5 is
 * a losing proposition and gets forced to waiting. The cool-down and
 * loss-streak gates are softer risk signals — they cap conviction but let
 * Claude keep proposing a real trade if it can defend the setup.
 */
function applyQualityGates(
  trade_ideas: TradeIdeasByHorizon,
  activity: SymbolActivity | null,
): GateResult {
  const notes: string[] = [];
  const horizons: (keyof TradeIdeasByHorizon)[] = [
    'intraday',
    'short_term',
    'medium_term',
    'long_term',
  ];
  const out: TradeIdeasByHorizon = {
    intraday: trade_ideas.intraday,
    short_term: trade_ideas.short_term,
    medium_term: trade_ideas.medium_term,
    long_term: trade_ideas.long_term,
  };

  // Cool-down bar raised from 2+ to 3+ stops. Two losses in 14d isn't a
  // pattern, it's noise — three is a signal.
  const cooldown = (activity?.losses_in_window ?? 0) >= 3;
  const lossStreak = activity?.loss_streak ?? 0;
  const lastLossDir = activity?.last_loss_direction ?? null;

  for (const h of horizons) {
    const idea = out[h];
    if (!idea) continue;

    // Gate 1: R:R < 1.5 → force waiting. This is math, not a risk signal —
    // the trade is negative-expectancy no matter what. Non-negotiable.
    const rr = computeRR(idea);
    if (rr != null && rr < 1.5) {
      notes.push(
        `${h}: R:R was ${rr.toFixed(2)} (<1.5) — forced to waiting. The math on this trade doesn't work.`,
      );
      out[h] = {
        ...idea,
        entry_kind: 'waiting',
        conviction: 1,
        rationale:
          `[server override: R:R ${rr.toFixed(2)} — reward smaller than 1.5× risk] ` +
          idea.rationale,
      };
      continue;
    }

    // Gate 2: cool-down. Cap conviction at 2 but let the trade fire if the
    // R:R is clean. The user still wants tradeable ideas — just sized down.
    if (cooldown && idea.conviction > 2) {
      notes.push(
        `${h}: symbol cool-down (${activity!.losses_in_window} losses in ${activity!.window_days}d) — conviction capped from ${idea.conviction} to 2.`,
      );
      out[h] = {
        ...idea,
        conviction: 2,
        rationale:
          `[server override: ${activity!.losses_in_window} recent stops on ${activity!.symbol} — conviction capped at 2] ` +
          idea.rationale,
      };
      continue;
    }

    // Gate 3: same-direction loss-streak. Cap conviction at 2 but allow the
    // trade — Claude may have real reason to think the regime has changed.
    if (lossStreak >= 2 && lastLossDir && idea.direction === lastLossDir && idea.conviction > 2) {
      notes.push(
        `${h}: ${lossStreak} consecutive ${lastLossDir.toUpperCase()} stops on this symbol — conviction capped from ${idea.conviction} to 2.`,
      );
      out[h] = {
        ...idea,
        conviction: 2,
        rationale:
          `[server override: ${lossStreak} consecutive ${lastLossDir} stops on ${activity!.symbol} — conviction capped at 2] ` +
          idea.rationale,
      };
      continue;
    }
  }

  return { ideas: out, notes };
}

analysisRouter.post('/', requireAuth, async (req, res) => {
  if (!isAnthropicConfigured()) {
    res.status(503).json({ error: 'AI analysis is unavailable — ANTHROPIC_API_KEY not configured.' });
    return;
  }
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', issues: parsed.error.issues });
    return;
  }
  const { symbol, asset_type, external_id, force_refresh, model_tier } = parsed.data;
  const userId = req.user!.id;

  // Freshness window: how recent the cached analysis must be to reuse it.
  // Markets move fast — a 9 AM trade idea is useless by 3 PM. Crypto is 24/7
  // and especially volatile, so its window is the tightest.
  const cacheTtlMinutes = asset_type === 'crypto' ? 5 : 10;
  const cacheCutoff = new Date(Date.now() - cacheTtlMinutes * 60_000);
  const expectedModel = resolveModel(model_tier as ModelTier);

  if (!force_refresh) {
    // One analysis now covers all 4 horizons, so we no longer need to filter
    // the cache by horizon — any fresh row at the same model tier is reusable.
    const cached = await query<CachedRow>(
      `SELECT id, content, model, analysis_date, created_at, analysis_data
       FROM ai_analyses
       WHERE user_id = $1 AND symbol = $2
         AND created_at > $3
         AND model = $4
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, symbol, cacheCutoff, expectedModel],
    );
    if (cached.rows[0]) {
      const r = cached.rows[0];
      res.json({
        cached: true,
        id: r.id,
        content: r.content,
        model: r.model,
        analysis_date: r.analysis_date,
        created_at: r.created_at,
        data: sanitizeAnalysisData(r.analysis_data),
      });
      return;
    }
  }

  // Lazy resolve any pending trades for this user — keeps the journal current
  // without needing a background cron.
  try {
    await resolvePendingTrades(userId);
  } catch (err) {
    console.warn('resolvePendingTrades failed (non-fatal):', err);
  }

  let quote;
  try {
    quote = await getQuote({ symbol, asset_type, external_id });
  } catch (err) {
    res.status(502).json({
      error: 'Could not fetch market data for analysis',
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const asOf = new Date();
  let contextBlock = `AS OF: ${asOf.toISOString()} — treat this as RIGHT NOW.\nAsset: ${symbol} (${asset_type})\nCurrent price: ${quote.price}\n24h change: ${quote.change_pct.toFixed(2)}%`;
  let indicators: IndicatorSnapshot | undefined;
  let sentiment: MarketSentiment | null = null;

  if (asset_type === 'crypto') {
    try {
      // Always pull 365 days now — the analysis covers all 4 horizons,
      // including long_term, so Claude needs the multi-quarter context.
      const dailyDays = 365;
      // The intraday call is best-effort — CoinGecko sometimes rate-limits it,
      // and the analysis still works without it (Claude just falls back to the
      // daily series). Use Promise.allSettled so a single failure doesn't drop
      // the whole context.
      const [pointsRes, fgRes, intradayRes] = await Promise.allSettled([
        getCryptoChart(symbol, external_id, dailyDays),
        getCryptoFearGreed(),
        getCryptoChart(symbol, external_id, 1),
      ]);
      const points = pointsRes.status === 'fulfilled' ? pointsRes.value : [];
      sentiment = fgRes.status === 'fulfilled' ? fgRes.value : null;
      const intraday = intradayRes.status === 'fulfilled' ? intradayRes.value : undefined;
      indicators = indicatorSnapshot(points);
      const last30 = points.slice(-30);
      const prices90 = points.map((p) => p.price);
      const prices30 = last30.map((p) => p.price);
      if (points.length > 0) {
        contextBlock = buildMarketContextBlock({
          symbol,
          asset_type,
          current_price: quote.price,
          change_24h_pct: quote.change_pct,
          sample_points: last30,
          intraday_points: intraday,
          indicators,
          range_30d: { high: Math.max(...prices30), low: Math.min(...prices30) },
          range_90d: { high: Math.max(...prices90), low: Math.min(...prices90) },
          sentiment,
          as_of: asOf,
        });
      }
    } catch {
      // Fall back to the basic spot quote if upstream is rate-limited.
    }
  }

  // Build the track record block — Claude's recent ideas + outcomes so it can
  // calibrate from its own history. Also pull symbol-specific activity for
  // cool-down + loss-streak warnings, which get enforced server-side even if
  // Claude doesn't follow the prompt hint.
  let trackRecordBlock = '';
  let symbolActivity: SymbolActivity | null = null;
  try {
    const [tr, sa] = await Promise.all([
      getTrackRecord(userId, { daysBack: 60, limit: 12 }),
      getSymbolActivity(userId, symbol, 14),
    ]);
    symbolActivity = sa;
    trackRecordBlock =
      '\n\n=== YOUR TRADE JOURNAL ===\n' +
      formatTrackRecordForPrompt(symbol, tr) +
      formatSymbolActivityForPrompt(sa);
  } catch (err) {
    console.warn('journal fetch failed (non-fatal):', err);
  }

  const client = getAnthropicClient();
  const model = resolveModel(model_tier as ModelTier);
  const isDeep = model_tier === 'deep';
  let message: Anthropic.Message;
  try {
    // Deep dive uses forced tool_choice so Anthropic enforces the required fields
    // in the rich schema. Adaptive thinking is mutually exclusive with forced
    // tool use, and in practice the thinking variant produced THINNER output
    // (fewer enrichment fields filled), so we prioritize reliable structured
    // output over the thinking step.
    message = await client.messages.create({
      model,
      // Bumped because the response now contains FOUR trade ideas plus shared
      // analysis. ~2x the old budget; still ~75% cheaper than 4 separate calls.
      max_tokens: isDeep ? 10_000 : 3500,
      system: isDeep ? DEEP_SYSTEM_PROMPT : SYSTEM_PROMPT,
      tools: [isDeep ? DEEP_ANALYSIS_TOOL : ANALYSIS_TOOL],
      tool_choice: { type: 'tool', name: 'submit_analysis' },
      messages: [{ role: 'user', content: contextBlock + trackRecordBlock }],
    });
  } catch (err) {
    res.status(502).json({
      error: 'Claude analysis failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const toolBlock = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'submit_analysis',
  );
  if (!toolBlock) {
    res.status(502).json({ error: 'Model did not return a structured analysis.' });
    return;
  }

  const claudeData = toolBlock.input as Omit<AnalysisData, 'indicators' | 'sentiment'>;
  let merged: AnalysisData = { ...claudeData, indicators, sentiment };
  let analysisData = sanitizeAnalysisData(merged);

  // Deep tier promises a fully-formed response: real headline/summary, key
  // levels populated, AND all 4 trade_ideas filled. If Opus returns a
  // degenerate response (empty fields, null slots), retry up to twice with
  // escalating firmness. If it STILL fails after retries, transparently fall
  // back to the Fast tier so the user gets a real answer instead of nothing.
  // Degeneracy = the response is so empty it'd be useless to the user.
  // Loosened to require: real headline + real summary + key_levels populated
  // + the primary_horizon's trade idea exists. Other horizons can be null —
  // a response with only the primary idea is still actionable.
  const isDegenerate = (d: AnalysisData | null): string | false => {
    if (!d) return 'null analysis';
    if (!d.headline || d.headline.trim().length < 4) return 'empty headline';
    if (!d.summary_markdown || d.summary_markdown.trim().length < 80) {
      return `summary too short (${d.summary_markdown?.trim().length ?? 0} chars)`;
    }
    if (
      (!d.key_levels?.support || d.key_levels.support.length === 0) &&
      (!d.key_levels?.resistance || d.key_levels.resistance.length === 0)
    ) {
      return 'no key_levels';
    }
    const primaryIdea = d.trade_ideas[d.primary_horizon];
    if (!primaryIdea) return `primary_horizon (${d.primary_horizon}) has no trade idea`;
    return false;
  };

  if (isDeep) {
    const firstReason = isDegenerate(analysisData);
    if (firstReason) {
      console.warn(`[deep ${symbol}] initial response degenerate: ${firstReason}. Retrying.`);
    }
    let lastToolBlock = toolBlock;
    for (let attempt = 1; attempt <= 2 && isDegenerate(analysisData); attempt++) {
      try {
        const reminder =
          attempt === 1
            ? 'Your previous response was degenerate (empty headline / summary / key_levels, or null trade_ideas slots). The user paid Opus tokens — an empty response is unacceptable. Re-submit with: a real headline, a 400+ word summary_markdown referencing specific indicator values, populated support AND resistance arrays, populated risks, AND four fully-formed trade ideas (use the watching-trade example from the system prompt for horizons with no edge — conviction=1, entry_kind="waiting", but still complete).'
            : 'Second attempt was still degenerate. ONE MORE TRY. Be concrete. Copy the watching-trade example from the system prompt verbatim, substituting real numbers (SMA20=0.2110 from the data, etc.). Every field must contain real content.';
        const retryMessage = await client.messages.create({
          model,
          max_tokens: 10_000,
          system: DEEP_SYSTEM_PROMPT,
          tools: [DEEP_ANALYSIS_TOOL],
          tool_choice: { type: 'tool', name: 'submit_analysis' },
          // When echoing the assistant's prior tool_use back, Anthropic's
          // API requires the next user message to START with a tool_result
          // block referencing the tool_use_id. Adding the reminder as a
          // following text block lets us include both in one user turn.
          messages: [
            { role: 'user', content: contextBlock + trackRecordBlock },
            { role: 'assistant', content: [lastToolBlock] },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: lastToolBlock.id,
                  content:
                    'Rejected: response was degenerate (empty fields or missing trade ideas).',
                  is_error: true,
                },
                { type: 'text', text: reminder },
              ],
            },
          ],
        });
        const retryToolBlock = retryMessage.content.find(
          (b): b is Anthropic.ToolUseBlock =>
            b.type === 'tool_use' && b.name === 'submit_analysis',
        );
        if (!retryToolBlock) break;
        lastToolBlock = retryToolBlock;
        const retryData = retryToolBlock.input as Omit<AnalysisData, 'indicators' | 'sentiment'>;
        const retryMerged: AnalysisData = { ...retryData, indicators, sentiment };
        const retrySan = sanitizeAnalysisData(retryMerged);
        if (retrySan) {
          analysisData = retrySan;
          merged = retryMerged;
        }
        const stillBad = isDegenerate(analysisData);
        if (stillBad) {
          console.warn(`[deep ${symbol}] retry ${attempt} still degenerate: ${stillBad}`);
        } else {
          console.warn(`[deep ${symbol}] retry ${attempt} succeeded`);
        }
      } catch (err) {
        console.warn(`[deep ${symbol}] retry ${attempt} threw:`, err);
        break;
      }
    }

    // Last-resort Sonnet fallback. If Opus still won't produce a real
    // response after 2 retries, use the Fast tier so the user gets SOMETHING
    // useful instead of a $X refusal.
    const stillDegenerate = isDegenerate(analysisData);
    if (stillDegenerate) {
      console.warn(
        `[deep ${symbol}] still degenerate after 2 retries (${stillDegenerate}). Falling back to Sonnet.`,
      );
      try {
        const fallbackModel = resolveModel('fast');
        const fallbackMsg = await client.messages.create({
          model: fallbackModel,
          max_tokens: 3500,
          system: SYSTEM_PROMPT,
          tools: [ANALYSIS_TOOL],
          tool_choice: { type: 'tool', name: 'submit_analysis' },
          messages: [{ role: 'user', content: contextBlock + trackRecordBlock }],
        });
        const fallbackBlock = fallbackMsg.content.find(
          (b): b is Anthropic.ToolUseBlock =>
            b.type === 'tool_use' && b.name === 'submit_analysis',
        );
        if (fallbackBlock) {
          const fbData = fallbackBlock.input as Omit<AnalysisData, 'indicators' | 'sentiment'>;
          const fbMerged: AnalysisData = { ...fbData, indicators, sentiment };
          const fbSan = sanitizeAnalysisData(fbMerged);
          const fbBad = isDegenerate(fbSan);
          if (fbSan && !fbBad) {
            analysisData = fbSan;
            merged = fbMerged;
            (analysisData as AnalysisData & { model_override?: string }).model_override =
              fallbackModel;
            console.warn(`[deep ${symbol}] Sonnet fallback succeeded`);
          } else {
            console.warn(
              `[deep ${symbol}] Sonnet fallback also degenerate: ${fbBad || 'sanitizer rejected'}`,
            );
          }
        } else {
          console.warn(`[deep ${symbol}] Sonnet fallback returned no tool_use block`);
        }
      } catch (err) {
        console.warn(`[deep ${symbol}] Sonnet fallback threw:`, err);
      }
    }
  }

  // If we STILL have a degenerate response after all retries + fallback,
  // refuse to persist it so we don't poison the cache and so the user can
  // try again. Return a clear error instead.
  const finalReason = isDeep ? isDegenerate(analysisData) : false;
  if (finalReason) {
    console.warn(`[deep ${symbol}] giving up — final reason: ${finalReason}`);
    res.status(502).json({
      error:
        'Deep Dive returned an empty response and the fallback also failed. Try Re-run, or switch to the Default tier.',
    });
    return;
  }

  if (!analysisData) {
    res.status(502).json({ error: 'Model returned an unusable analysis shape.' });
    return;
  }

  // Apply server-side quality gates. Claude's prompt tells it to follow these
  // rules but empirically it doesn't — repeat-loss patterns and low-R:R trades
  // still leak through. The gates rewrite bad ideas to waiting/conviction=1
  // and emit notes we surface in the summary so the user knows what was
  // downgraded and why.
  const gated = applyQualityGates(analysisData.trade_ideas, symbolActivity);
  analysisData = { ...analysisData, trade_ideas: gated.ideas };
  if (gated.notes.length > 0) {
    console.warn(`[gates ${symbol}] applied ${gated.notes.length} override(s):`);
    for (const n of gated.notes) console.warn(`  - ${n}`);
    const gateNote =
      '\n\n---\n_Quality gates applied:_\n' +
      gated.notes.map((n) => `- ${n}`).join('\n');
    analysisData = {
      ...analysisData,
      summary_markdown: (analysisData.summary_markdown ?? '') + gateNote,
    };
  }
  const content = analysisData.summary_markdown ?? '';

  // Record the primary-horizon trade idea so future analyses can learn from how
  // it plays out. Recording only the primary keeps the journal compact; the
  // other 3 horizons are reference data on the cached row.
  const primaryIdea = analysisData.trade_ideas[analysisData.primary_horizon];
  if (primaryIdea) {
    try {
      await recordTradeIdea({
        user_id: userId,
        symbol,
        asset_type,
        external_id: external_id ?? null,
        direction: primaryIdea.direction,
        entry_zone: primaryIdea.entry_zone,
        stop_loss: primaryIdea.stop_loss,
        targets: primaryIdea.targets,
        bias: analysisData.bias,
        conviction: primaryIdea.conviction,
        time_horizon: analysisData.primary_horizon,
        rationale: primaryIdea.rationale,
        price_at_creation: quote.price,
        rsi14_at_creation: indicators?.rsi14 ?? null,
        macd_state_at_creation: indicators?.macd_state ?? null,
        fear_greed_at_creation: sentiment?.fear_greed_index ?? null,
        model,
      });
    } catch (err) {
      console.warn('recordTradeIdea failed (non-fatal):', err);
    }
  }

  const inserted = await query<{ id: string; created_at: Date; analysis_date: Date }>(
    `INSERT INTO ai_analyses
       (user_id, symbol, asset_type, content, model, input_tokens, output_tokens, analysis_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (user_id, symbol, analysis_date)
     DO UPDATE SET content = EXCLUDED.content, model = EXCLUDED.model,
                   input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens,
                   analysis_data = EXCLUDED.analysis_data
     RETURNING id, created_at, analysis_date`,
    [
      userId,
      symbol,
      asset_type,
      content,
      model,
      message.usage.input_tokens,
      message.usage.output_tokens,
      JSON.stringify(analysisData),
    ],
  );
  const row = inserted.rows[0]!;

  res.json({
    cached: false,
    id: row.id,
    content,
    model,
    analysis_date: row.analysis_date,
    created_at: row.created_at,
    data: analysisData,
  });
});
