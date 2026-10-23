// Transaction processing engine — runs after every bank sync.
//
// Modeled on Actual Budget's import pipeline
// (packages/loot-core/src/server/accounts/sync.ts + server/rules):
//
//   1. Transfer pairing. A -$500 in checking and a +$500 in savings (or on a
//      credit card) within 4 days are the two halves of one transfer, so both
//      are excluded from spending AND income.
//   2. Pattern transfers. One-sided transfers whose other account isn't linked
//      ("Payment to Chase card" when the card isn't connected).
//   3. Rules. Stage pre -> default -> post; inside a stage the more specific
//      rule runs later and wins.
//   4. Claude fallback for whatever no rule caught (only if ANTHROPIC_API_KEY
//      is set). Each merchant is only ever asked about once.
//
// Manual edits (category_source = 'manual', transfer_source = 'manual') are
// never overwritten by any step.

import type pg from 'pg';
import { pool } from '../db.js';
import { FAST_MODEL, getAnthropicClient, isAnthropicConfigured } from './anthropic.js';
import {
  isCardPaymentInflow,
  isTransferOrPayment,
  looksLikeTransfer,
  normalizeMerchant,
} from './transactions-classify.js';

const PAIR_WINDOW_MS = 4 * 86_400_000;
const AI_MIN_CONFIDENCE = 0.75;
const AI_MAX_MERCHANTS_PER_RUN = 80;

export interface RuleRow {
  id: string;
  stage: 'pre' | 'default' | 'post';
  field: 'any' | 'payee' | 'description';
  op: 'contains' | 'is' | 'starts_with' | 'pattern';
  value: string;
  amount_min: string | null;
  amount_max: string | null;
  account_id: string | null;
  category_id: string | null;
  set_transfer: boolean | null;
  source: string;
}

interface TxnRow {
  id: string;
  account_id: string;
  amount: string;
  description: string;
  merchant: string | null;
  posted_at: Date;
  pending: boolean;
  category_id: string | null;
  category_source: 'rule' | 'ai' | 'manual' | null;
  is_transfer: boolean;
  transfer_source: 'paired' | 'pattern' | 'rule' | 'manual' | null;
  transfer_txn_id: string | null;
  ai_category: string | null;
  account_type: string;
  on_budget: boolean;
}

interface TxnState {
  category_id: string | null;
  category_source: TxnRow['category_source'];
  is_transfer: boolean;
  transfer_source: TxnRow['transfer_source'];
  transfer_txn_id: string | null;
  ai_category: string | null;
  ai_confidence: number | null;
}

export interface ProcessResult {
  scanned: number;
  transfers_paired: number;
  transfers_by_pattern: number;
  categorized_by_rule: number;
  categorized_by_ai: number;
  uncategorized_spending: number;
  changed: number;
}

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

const STAGE_ORDER: Record<RuleRow['stage'], number> = { pre: 0, default: 1, post: 2 };
const OP_SPECIFICITY: Record<RuleRow['op'], number> = { contains: 1, pattern: 1, starts_with: 2, is: 3 };

function specificity(r: RuleRow): number {
  return (
    OP_SPECIFICITY[r.op] +
    (r.amount_min != null || r.amount_max != null ? 2 : 0) +
    (r.account_id ? 1 : 0) +
    Math.min(r.value.length, 200) / 1000
  );
}

/** Rules sorted so that applying them in order and letting the last match win
 *  gives Actual's semantics. */
export function sortRules(rules: RuleRow[]): RuleRow[] {
  return [...rules].sort(
    (a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || specificity(a) - specificity(b),
  );
}

const patternCache = new Map<string, RegExp>();
function likeToRegex(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (!re) {
    const body = pattern
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*')
      .replace(/_/g, '.');
    re = new RegExp(`^${body}$`, 'i');
    patternCache.set(pattern, re);
  }
  return re;
}

function textMatches(op: RuleRow['op'], value: string, text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  const v = value.toLowerCase().trim();
  if (!v) return false;
  switch (op) {
    case 'contains':
      return t.includes(v);
    case 'is':
      return t === v;
    case 'starts_with':
      return t.startsWith(v);
    case 'pattern':
      // Legacy patterns like "AMZN%" were written as LIKE expressions; also
      // accept them as plain substrings of the text so "COSTCO%" still
      // matches "POS COSTCO WHSE".
      return likeToRegex(v).test(t) || t.includes(v.replace(/%/g, ''));
  }
}

export function ruleMatches(
  rule: RuleRow,
  txn: { description: string; merchant: string | null; amount: number; account_id: string },
): boolean {
  if (rule.account_id && rule.account_id !== txn.account_id) return false;
  const abs = Math.abs(txn.amount);
  if (rule.amount_min != null && abs < Number(rule.amount_min)) return false;
  if (rule.amount_max != null && abs > Number(rule.amount_max)) return false;
  const desc = txn.description ?? '';
  const payee = txn.merchant ?? '';
  switch (rule.field) {
    case 'payee':
      return textMatches(rule.op, rule.value, payee);
    case 'description':
      return textMatches(rule.op, rule.value, desc);
    case 'any':
      return (
        textMatches(rule.op, rule.value, payee) ||
        textMatches(rule.op, rule.value, desc) ||
        (rule.op !== 'is' && textMatches(rule.op, rule.value, `${desc} ${payee}`))
      );
  }
}

export function applyRules(
  sorted: RuleRow[],
  txn: { description: string; merchant: string | null; amount: number; account_id: string },
): { category_id: string | null; set_transfer: boolean | null } {
  let category_id: string | null = null;
  let set_transfer: boolean | null = null;
  for (const r of sorted) {
    if (!ruleMatches(r, txn)) continue;
    if (r.category_id) category_id = r.category_id;
    if (r.set_transfer != null) set_transfer = r.set_transfer;
  }
  return { category_id, set_transfer };
}

export async function loadRules(userId: string, client?: pg.PoolClient): Promise<RuleRow[]> {
  const q = client ?? pool;
  const res = await q.query<RuleRow>(
    `SELECT r.id, r.stage, r.field, r.op, r.value, r.amount_min, r.amount_max,
            r.account_id, r.category_id, r.set_transfer, r.source
     FROM category_rules r
     WHERE r.user_id = $1`,
    [userId],
  );
  return sortRules(res.rows);
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

function cents(amount: string | number): number {
  return Math.round(Number(amount) * 100);
}

/**
 * Process a user's transactions. `since` limits the scan to recent
 * transactions (used after a sync); omit it to reprocess everything.
 */
export async function processTransactions(
  userId: string,
  options: { since?: Date; ai?: boolean } = {},
): Promise<ProcessResult> {
  // Look a few extra days back so a transfer whose first half landed just
  // before the window can still be paired.
  const since = options.since ? new Date(options.since.getTime() - PAIR_WINDOW_MS - 86_400_000) : null;
  const res = await pool.query<TxnRow>(
    `SELECT t.id, t.account_id, t.amount::text, t.description, t.merchant, t.posted_at,
            t.pending, t.category_id, t.category_source, t.is_transfer,
            t.transfer_source, t.transfer_txn_id, t.ai_category,
            ba.account_type, ba.on_budget
     FROM transactions t
     JOIN bank_accounts ba ON ba.id = t.account_id
     WHERE t.user_id = $1 ${since ? 'AND t.posted_at >= $2' : ''}
     ORDER BY t.posted_at ASC`,
    since ? [userId, since] : [userId],
  );
  const txns = res.rows;
  const rules = await loadRules(userId);

  const state = new Map<string, TxnState>();
  for (const t of txns) {
    state.set(t.id, {
      category_id: t.category_id,
      category_source: t.category_source,
      is_transfer: t.is_transfer,
      transfer_source: t.transfer_source,
      transfer_txn_id: t.transfer_txn_id,
      ai_category: t.ai_category,
      ai_confidence: null,
    });
  }
  const result: ProcessResult = {
    scanned: txns.length,
    transfers_paired: 0,
    transfers_by_pattern: 0,
    categorized_by_rule: 0,
    categorized_by_ai: 0,
    uncategorized_spending: 0,
    changed: 0,
  };

  // 1. Transfer pairing between on-budget accounts.
  const isManualTransfer = (t: TxnRow): boolean => t.transfer_source === 'manual';
  const openInflows = new Map<number, TxnRow[]>();
  for (const t of txns) {
    if (!t.on_budget || t.pending || isManualTransfer(t) || t.transfer_txn_id) continue;
    if (Number(t.amount) <= 0) continue;
    const key = cents(t.amount);
    const list = openInflows.get(key);
    if (list) list.push(t);
    else openInflows.set(key, [t]);
  }
  const claimed = new Set<string>();
  for (const a of txns) {
    if (!a.on_budget || a.pending || isManualTransfer(a) || a.transfer_txn_id) continue;
    if (Number(a.amount) >= 0) continue;
    const candidates = openInflows.get(-cents(a.amount));
    if (!candidates) continue;
    let best: TxnRow | null = null;
    let bestDist = Infinity;
    for (const b of candidates) {
      if (claimed.has(b.id) || b.account_id === a.account_id) continue;
      const dist = Math.abs(b.posted_at.getTime() - a.posted_at.getTime());
      if (dist > PAIR_WINDOW_MS) continue;
      // Same amount + opposite sign isn't enough on its own (a card refund
      // can coincide with an unrelated purchase), so one side has to read
      // like a transfer or card payment.
      const plausible =
        ((b.account_type === 'credit_card' || b.account_type === 'loan') &&
          isCardPaymentInflow(b.description, b.merchant)) ||
        looksLikeTransfer(a.description, a.merchant) ||
        looksLikeTransfer(b.description, b.merchant) ||
        isTransferOrPayment(a.description, a.merchant);
      if (!plausible) continue;
      if (dist < bestDist) {
        best = b;
        bestDist = dist;
      }
    }
    if (!best) continue;
    claimed.add(best.id);
    claimed.add(a.id);
    for (const [self, other] of [
      [a, best],
      [best, a],
    ] as const) {
      const s = state.get(self.id)!;
      s.is_transfer = true;
      s.transfer_source = 'paired';
      s.transfer_txn_id = other.id;
    }
    result.transfers_paired += 1;
  }

  // 2 + 3. Pattern transfers and rules.
  for (const t of txns) {
    const s = state.get(t.id)!;
    const amount = Number(t.amount);
    const match = applyRules(rules, { ...t, amount });

    if (s.transfer_source !== 'manual' && s.transfer_source !== 'paired' && !claimed.has(t.id)) {
      let transfer = false;
      let source: TxnState['transfer_source'] = null;
      if (match.set_transfer != null) {
        transfer = match.set_transfer;
        source = 'rule';
      } else if (match.category_id) {
        // A category rule wins over transfer wording for one-sided entries:
        // "Online transfer to Fidelity" leaves the budget, so it must land in
        // a category (e.g. Investing), not vanish as a transfer.
        transfer = false;
      } else if (
        (amount < 0 && isTransferOrPayment(t.description, t.merchant)) ||
        (amount > 0 && t.account_type === 'credit_card' && isCardPaymentInflow(t.description, t.merchant)) ||
        (amount > 0 && /\b(online )?transfer from\b/i.test(`${t.description} ${t.merchant ?? ''}`))
      ) {
        transfer = true;
        source = 'pattern';
      }
      s.is_transfer = transfer;
      s.transfer_source = transfer ? source : null;
      s.transfer_txn_id = null;
      if (transfer && source === 'pattern') result.transfers_by_pattern += 1;
    }

    if (s.category_source === 'manual') continue;
    if (s.is_transfer) {
      s.category_id = null;
      s.category_source = null;
      continue;
    }
    if (match.category_id) {
      s.category_id = match.category_id;
      s.category_source = 'rule';
      result.categorized_by_rule += 1;
    } else if (s.category_source === 'rule') {
      // The rule that put it here was edited or removed.
      s.category_id = null;
      s.category_source = null;
    }
  }

  // 4. Claude fallback.
  if (options.ai !== false && isAnthropicConfigured()) {
    try {
      result.categorized_by_ai = await aiCategorize(userId, txns, state);
    } catch (err) {
      console.error('AI categorization failed (continuing without it):', err);
    }
  }

  for (const t of txns) {
    const s = state.get(t.id)!;
    if (t.on_budget && !s.is_transfer && !s.category_id && Number(t.amount) < 0) {
      result.uncategorized_spending += 1;
    }
  }

  // Persist only rows that changed.
  const changed = txns.filter((t) => {
    const s = state.get(t.id)!;
    return (
      s.category_id !== t.category_id ||
      s.category_source !== t.category_source ||
      s.is_transfer !== t.is_transfer ||
      s.transfer_source !== t.transfer_source ||
      s.transfer_txn_id !== t.transfer_txn_id ||
      s.ai_category !== t.ai_category
    );
  });
  result.changed = changed.length;
  const CHUNK = 500;
  for (let i = 0; i < changed.length; i += CHUNK) {
    const chunk = changed.slice(i, i + CHUNK);
    const s = chunk.map((t) => state.get(t.id)!);
    await pool.query(
      `UPDATE transactions t SET
         category_id = v.category_id,
         category_source = v.category_source,
         is_transfer = v.is_transfer,
         transfer_source = v.transfer_source,
         transfer_txn_id = v.transfer_txn_id,
         ai_category = v.ai_category,
         ai_confidence = COALESCE(v.ai_confidence, t.ai_confidence)
       FROM (
         SELECT * FROM unnest(
           $1::uuid[], $2::uuid[], $3::text[], $4::boolean[], $5::text[], $6::uuid[], $7::text[], $8::numeric[]
         ) AS x(id, category_id, category_source, is_transfer, transfer_source, transfer_txn_id, ai_category, ai_confidence)
       ) v
       WHERE t.id = v.id AND t.user_id = $9`,
      [
        chunk.map((t) => t.id),
        s.map((x) => x.category_id),
        s.map((x) => x.category_source),
        s.map((x) => x.is_transfer),
        s.map((x) => x.transfer_source),
        s.map((x) => x.transfer_txn_id),
        s.map((x) => x.ai_category),
        s.map((x) => x.ai_confidence),
        userId,
      ],
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Claude fallback
// ---------------------------------------------------------------------------

async function aiCategorize(
  userId: string,
  txns: TxnRow[],
  state: Map<string, TxnState>,
): Promise<number> {
  const cats = await pool.query<{ id: string; name: string; is_income: boolean }>(
    `SELECT id, name, is_income FROM categories WHERE user_id = $1 AND hidden = false ORDER BY name`,
    [userId],
  );
  if (cats.rows.length === 0) return 0;
  const byName = new Map(cats.rows.map((c) => [c.name.toLowerCase(), c]));

  // Group the still-uncategorized, never-asked transactions by merchant.
  const groups = new Map<string, { sample: TxnRow; ids: string[]; inflow: boolean }>();
  for (const t of txns) {
    const s = state.get(t.id)!;
    if (!t.on_budget || s.is_transfer || s.category_id || s.ai_category != null) continue;
    const inflow = Number(t.amount) > 0;
    const key = `${normalizeMerchant(t.merchant || t.description) || t.description.slice(0, 40)}|${inflow ? 'in' : 'out'}`;
    const g = groups.get(key);
    if (g) g.ids.push(t.id);
    else groups.set(key, { sample: t, ids: [t.id], inflow });
  }
  const entries = [...groups.entries()]
    .sort((a, b) => b[1].ids.length - a[1].ids.length)
    .slice(0, AI_MAX_MERCHANTS_PER_RUN);
  if (entries.length === 0) return 0;

  const lines = entries.map(
    ([, g], i) =>
      `${i}. ${g.inflow ? 'MONEY IN' : 'MONEY OUT'} | payee: ${g.sample.merchant ?? '-'} | description: ${g.sample.description} | amount: ${Math.abs(Number(g.sample.amount)).toFixed(2)}`,
  );
  const prompt = `You categorize personal bank transactions for a budgeting app.

Categories (use the exact name, or null if none fits well):
${cats.rows.map((c) => `- ${c.name}${c.is_income ? ' (income: paychecks, interest, dividends, reimbursements)' : ''}`).join('\n')}

Rules:
- MONEY OUT goes to a spending category.
- MONEY IN is "Income" when it is earnings; a refund or return goes to the spending category it came from.
- If you are not confident, return null. Never invent a category name.

Transactions:
${lines.join('\n')}

Reply with only JSON: {"results":[{"i":0,"category":"Name or null","confidence":0.0}]}`;

  const client = getAnthropicClient();
  const msg = await client.messages.create({
    model: FAST_MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let parsed: { results?: Array<{ i: number; category: string | null; confidence: number }> };
  try {
    parsed = JSON.parse(json);
  } catch {
    console.error('AI categorization returned non-JSON:', text.slice(0, 300));
    return 0;
  }

  let count = 0;
  for (const r of parsed.results ?? []) {
    const entry = entries[r.i];
    if (!entry) continue;
    const cat = r.category ? byName.get(r.category.toLowerCase()) : undefined;
    const ok = !!cat && Number(r.confidence) >= AI_MIN_CONFIDENCE;
    for (const id of entry[1].ids) {
      const s = state.get(id)!;
      // Remember that we asked, so this merchant isn't sent again every sync.
      s.ai_category = cat ? cat.name : 'none';
      s.ai_confidence = Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : null;
      if (ok) {
        s.category_id = cat!.id;
        s.category_source = 'ai';
        count += 1;
      }
    }
  }
  return count;
}
