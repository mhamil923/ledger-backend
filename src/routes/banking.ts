import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import {
  fetchSimpleFinAccounts,
  redeemSetupToken,
  type SimpleFinAccount,
} from '../services/simplefin.js';
import {
  decryptSecret,
  encryptSecret,
  isBankingCryptoConfigured,
} from '../services/crypto.js';
import { isTransferOrPayment } from '../services/transactions-classify.js';

export const bankingRouter = Router();
bankingRouter.use(requireAuth);

// Initial sync window — pull 2 years of history so we can detect annual
// recurring charges (which by definition appear at most once in 12 months).
// SimpleFIN returns whatever its institution actually retained, so this is an
// upper bound; common in practice: 12-24 months.
const TXN_SYNC_WINDOW_DAYS = 730;

interface ConnectionRow {
  id: string;
  encrypted_access: string;
  status: string;
  last_synced_at: Date | null;
}

interface BankAccountRow {
  id: string;
  provider_account_id: string;
  institution: string | null;
  name: string;
  account_type: string;
  mask: string | null;
  currency: string;
  current_balance: string | null;
  last_synced_at: Date | null;
}

interface TransactionRow {
  id: string;
  account_id: string;
  posted_at: Date;
  amount: string;
  currency: string;
  description: string;
  merchant: string | null;
  category: string | null;
  pending: boolean;
}

function bankingDisabled(res: import('express').Response): boolean {
  if (!isBankingCryptoConfigured()) {
    res.status(503).json({
      error:
        'Banking is disabled — BANKING_ENC_KEY is not configured on the server. Add a 32-byte base64 key to .env and restart.',
    });
    return true;
  }
  return false;
}

/**
 * Resolve account_type from SimpleFIN account name + balance.
 * SimpleFIN doesn't return a clean type field, so we lean on the name and
 * use balance sign as a tiebreaker (credit cards typically carry a negative
 * "owed" balance even with no card-specific word in the name like "Sapphire"
 * or "Freedom Flex").
 */
function inferAccountType(name: string, balance: number | null): string {
  const n = name.toLowerCase();
  // Direct hits.
  if (n.includes('credit') || n.includes('card')) return 'credit_card';
  // Common card product names — Chase Sapphire / Freedom, Capital One Venture,
  // Amex Gold / Platinum, etc.
  if (
    /\b(sapphire|freedom|reserve|preferred|platinum|gold|venture|quicksilver|discover it|aspire|magnify|wells.*active|citi double|chase ink|cash plus|wells.*propel)\b/.test(
      n,
    )
  ) {
    return 'credit_card';
  }
  if (n.includes('savings')) return 'savings';
  if (n.includes('check')) return 'checking';
  if (n.includes('loan') || n.includes('mortgage')) return 'loan';
  if (n.includes('invest') || n.includes('brokerage')) return 'investment';
  // Last resort: a negative current balance on an otherwise-uncategorized
  // account almost always means revolving credit.
  if (balance != null && balance < 0) return 'credit_card';
  return 'depository';
}

/**
 * Pull last4 from a name like "Chase ...1234" if present, else null.
 */
function inferMask(name: string): string | null {
  const m = name.match(/\b(\d{4})\b/);
  return m ? m[1]! : null;
}

/**
 * Upsert SimpleFIN data into bank_accounts + transactions. Returns counts.
 * Runs in a single transaction so a partial failure doesn't leave us with
 * half-synced state.
 */
async function syncSimpleFinData(
  userId: string,
  connectionId: string,
  accounts: SimpleFinAccount[],
): Promise<{ accounts: number; transactions: number }> {
  let txnCount = 0;
  await withTransaction(async (client) => {
    for (const acct of accounts) {
      const institution = acct.org.name ?? acct.org.domain ?? null;
      const accountType = inferAccountType(acct.name, Number(acct.balance));
      const mask = inferMask(acct.name);
      const upsert = await client.query<{ id: string }>(
        `INSERT INTO bank_accounts
           (user_id, provider, provider_account_id, institution, name,
            account_type, mask, currency, current_balance, last_synced_at,
            connection_id)
         VALUES ($1, 'simplefin', $2, $3, $4, $5, $6, $7, $8, now(), $9)
         ON CONFLICT (user_id, provider, provider_account_id)
         DO UPDATE SET
           institution = EXCLUDED.institution,
           name = EXCLUDED.name,
           account_type = EXCLUDED.account_type,
           mask = EXCLUDED.mask,
           currency = EXCLUDED.currency,
           current_balance = EXCLUDED.current_balance,
           last_synced_at = EXCLUDED.last_synced_at,
           connection_id = EXCLUDED.connection_id
         RETURNING id`,
        [
          userId,
          acct.id,
          institution,
          acct.name,
          accountType,
          mask,
          acct.currency || 'USD',
          acct.balance,
          connectionId,
        ],
      );
      const accountRowId = upsert.rows[0]!.id;

      const txns = acct.transactions ?? [];
      for (const tx of txns) {
        await client.query(
          `INSERT INTO transactions
             (account_id, user_id, provider_txn_id, posted_at, amount,
              currency, description, merchant, pending)
           VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9)
           ON CONFLICT (account_id, provider_txn_id)
           DO UPDATE SET
             amount = EXCLUDED.amount,
             description = EXCLUDED.description,
             merchant = EXCLUDED.merchant,
             pending = EXCLUDED.pending`,
          [
            accountRowId,
            userId,
            tx.id,
            tx.posted,
            tx.amount,
            acct.currency || 'USD',
            tx.description,
            tx.payee ?? null,
            !!tx.pending,
          ],
        );
        txnCount += 1;
      }
    }
    await client.query(
      `UPDATE simplefin_connections
         SET last_synced_at = now(), status = 'active', last_error = NULL
         WHERE id = $1`,
      [connectionId],
    );
  });
  return { accounts: accounts.length, transactions: txnCount };
}

/**
 * POST /api/banking/connect — exchange a SimpleFIN Setup Token for an Access
 * URL, store it encrypted, then do an initial sync.
 */
const connectSchema = z.object({
  setup_token: z.string().min(10).max(4000),
});
bankingRouter.post('/connect', async (req, res) => {
  if (bankingDisabled(res)) return;
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;

  let accessUrl: string;
  try {
    accessUrl = await redeemSetupToken(parsed.data.setup_token);
  } catch (err) {
    res.status(400).json({
      error: 'Could not redeem Setup Token',
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const encrypted = encryptSecret(accessUrl);

  // Upsert the connection — one per user.
  const conn = await query<{ id: string }>(
    `INSERT INTO simplefin_connections (user_id, encrypted_access, status)
     VALUES ($1, $2, 'active')
     ON CONFLICT (user_id)
     DO UPDATE SET
       encrypted_access = EXCLUDED.encrypted_access,
       status = 'active',
       last_error = NULL
     RETURNING id`,
    [userId, encrypted],
  );
  const connectionId = conn.rows[0]!.id;

  // Initial sync — 90 days of transactions.
  const startDate = Math.floor(Date.now() / 1000) - TXN_SYNC_WINDOW_DAYS * 86400;
  let counts;
  try {
    const data = await fetchSimpleFinAccounts(accessUrl, { start_date: startDate });
    counts = await syncSimpleFinData(userId, connectionId, data.accounts ?? []);
  } catch (err) {
    await query(
      `UPDATE simplefin_connections SET status = 'error', last_error = $2 WHERE id = $1`,
      [connectionId, err instanceof Error ? err.message : String(err)],
    );
    res.status(502).json({
      error: 'Connected, but initial sync failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  res.json({ ok: true, connection_id: connectionId, ...counts });
});

/**
 * POST /api/banking/sync — refresh balances and pull new transactions for
 * the authenticated user's existing connection.
 */
bankingRouter.post('/sync', async (req, res) => {
  if (bankingDisabled(res)) return;
  const userId = req.user!.id;

  const conn = await query<ConnectionRow>(
    `SELECT id, encrypted_access, status, last_synced_at
     FROM simplefin_connections WHERE user_id = $1`,
    [userId],
  );
  if (conn.rows.length === 0) {
    res.status(404).json({ error: 'No bank connection. Connect via SimpleFIN first.' });
    return;
  }
  const row = conn.rows[0]!;

  let accessUrl: string;
  try {
    accessUrl = decryptSecret(row.encrypted_access);
  } catch {
    res.status(500).json({ error: 'Stored credentials could not be decrypted.' });
    return;
  }

  // Pull transactions since the last sync, with a 14-day overlap to catch
  // late-posted items. First-ever sync uses the 90-day window.
  const lastSyncedSec = row.last_synced_at
    ? Math.floor(row.last_synced_at.getTime() / 1000)
    : null;
  const startDate = lastSyncedSec
    ? Math.max(lastSyncedSec - 14 * 86400, Math.floor(Date.now() / 1000) - 730 * 86400)
    : Math.floor(Date.now() / 1000) - TXN_SYNC_WINDOW_DAYS * 86400;

  try {
    const data = await fetchSimpleFinAccounts(accessUrl, { start_date: startDate });
    const counts = await syncSimpleFinData(userId, row.id, data.accounts ?? []);
    res.json({ ok: true, ...counts, errors: data.errors ?? [] });
  } catch (err) {
    await query(
      `UPDATE simplefin_connections SET status = 'error', last_error = $2 WHERE id = $1`,
      [row.id, err instanceof Error ? err.message : String(err)],
    );
    res.status(502).json({
      error: 'Sync failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * GET /api/banking/accounts — list connection status + bank accounts with
 * current balances. Used by the Accounts tab.
 */
bankingRouter.get('/accounts', async (req, res) => {
  if (bankingDisabled(res)) return;
  const userId = req.user!.id;

  const conn = await query<{ status: string; last_synced_at: Date | null; last_error: string | null }>(
    `SELECT status, last_synced_at, last_error FROM simplefin_connections WHERE user_id = $1`,
    [userId],
  );
  const connection = conn.rows[0]
    ? {
        status: conn.rows[0].status,
        last_synced_at: conn.rows[0].last_synced_at,
        last_error: conn.rows[0].last_error,
      }
    : null;

  const accounts = await query<BankAccountRow>(
    `SELECT id, provider_account_id, institution, name, account_type, mask,
            currency, current_balance, last_synced_at
     FROM bank_accounts
     WHERE user_id = $1 AND provider = 'simplefin'
     ORDER BY institution ASC NULLS LAST, name ASC`,
    [userId],
  );

  res.json({
    connection,
    accounts: accounts.rows.map((r) => ({
      ...r,
      current_balance: r.current_balance == null ? null : Number(r.current_balance),
    })),
  });
});

/**
 * GET /api/banking/transactions — recent transactions across all of the
 * user's connected accounts. Supports ?limit, ?account_id, ?days.
 */
const txnQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  account_id: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(365).optional().default(60),
});
bankingRouter.get('/transactions', async (req, res) => {
  if (bankingDisabled(res)) return;
  const parsed = txnQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const { limit, account_id, days } = parsed.data;
  const params: unknown[] = [userId, new Date(Date.now() - days * 86400 * 1000)];
  let filter = '';
  if (account_id) {
    params.push(account_id);
    filter = ` AND account_id = $${params.length}`;
  }
  params.push(limit);
  const result = await query<TransactionRow>(
    `SELECT id, account_id, posted_at, amount, currency, description, merchant,
            category, pending
     FROM transactions
     WHERE user_id = $1 AND posted_at >= $2${filter}
     ORDER BY posted_at DESC
     LIMIT $${params.length}`,
    params,
  );
  // Tag each row with is_transfer so the client can visually mark
  // credit-card payments / internal transfers as "not real spend."
  res.json({
    transactions: result.rows.map((r) => ({
      ...r,
      amount: Number(r.amount),
      is_transfer: isTransferOrPayment(r.description, r.merchant),
    })),
  });
});

/**
 * GET /api/banking/recurring — heuristic detection of recurring bills.
 *
 * Groups recent spend transactions by normalized merchant name, computes
 * median amount and median interval between charges, scores confidence, and
 * returns the candidates that look like real recurring bills. Skips anything
 * whose name already matches an active bill so the user doesn't see dupes.
 */
const recurringQuerySchema = z.object({
  days: z.coerce.number().int().min(30).max(365).optional().default(180),
});
bankingRouter.get('/recurring', async (req, res) => {
  if (bankingDisabled(res)) return;
  const parsed = recurringQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
    return;
  }
  const userId = req.user!.id;
  const since = new Date(Date.now() - parsed.data.days * 86400 * 1000);

  const txns = await query<{
    posted_at: Date;
    amount: string;
    description: string;
    merchant: string | null;
    account_id: string;
  }>(
    `SELECT posted_at, amount, description, merchant, account_id
     FROM transactions
     WHERE user_id = $1 AND posted_at >= $2 AND amount < 0
     ORDER BY posted_at ASC`,
    [userId, since],
  );

  const existingBills = await query<{ name: string; merchant: string | null }>(
    `SELECT name, merchant FROM bills WHERE user_id = $1 AND active = true`,
    [userId],
  );
  const existingKeys = new Set<string>();
  for (const b of existingBills.rows) {
    existingKeys.add(normalizeMerchant(b.name));
    if (b.merchant) existingKeys.add(normalizeMerchant(b.merchant));
  }

  const candidates = detectRecurring(
    txns.rows
      .filter((r) => !isTransferOrPayment(r.description, r.merchant))
      .map((r) => ({
      posted_at: r.posted_at,
      amount: Math.abs(Number(r.amount)),
      raw: r.merchant ?? r.description,
      account_id: r.account_id,
    })),
    existingKeys,
  );
  res.json({ candidates });
});

/**
 * GET /api/banking/annual-fees — scans credit-card transactions for charges
 * whose description matches annual-fee patterns ("ANNUAL FEE", "MEMBERSHIP
 * FEE", etc.) and returns the most-recent hit per card. Used to pre-fill the
 * AddAnnualFeesModal so the user doesn't have to remember the amounts.
 */
bankingRouter.get('/annual-fees', async (req, res) => {
  if (bankingDisabled(res)) return;
  const userId = req.user!.id;

  // ILIKE matches case-insensitive. Patterns cover the most common phrasings
  // I've seen from Chase / Amex / Capital One / Citi / Discover statements.
  // Cast both description AND merchant to lowercase and search for any of the
  // common annual-fee phrasings. We search both columns because SimpleFIN puts
  // the actionable phrase in different fields depending on the institution.
  const patterns = [
    '%annual fee%',
    '%annual membership%',
    '%annual card%',
    '%membership fee%',
    '%card membership%',
    '%card fee%',
    '%annual%fee%',
    '%card mbr%',
  ];
  const placeholders = patterns
    .map((_, i) => `(t.description ILIKE $${i + 2} OR COALESCE(t.merchant, '') ILIKE $${i + 2})`)
    .join(' OR ');
  const rows = await query<{
    account_id: string;
    posted_at: Date;
    amount: string;
    description: string;
    merchant: string | null;
  }>(
    `SELECT account_id, posted_at, amount, description, merchant
     FROM transactions t
     WHERE user_id = $1
       AND amount < 0
       AND EXISTS (
         SELECT 1 FROM bank_accounts ba
         WHERE ba.id = t.account_id AND ba.account_type = 'credit_card'
       )
       AND (${placeholders})
     ORDER BY posted_at DESC`,
    [userId, ...patterns],
  );

  // Keep the most recent hit per account (first row wins because of ORDER BY).
  const seen = new Set<string>();
  const fees: Array<{
    account_id: string;
    last_charged: string;
    next_estimated: string;
    amount: number;
    description: string;
  }> = [];
  for (const r of rows.rows) {
    if (seen.has(r.account_id)) continue;
    seen.add(r.account_id);
    const last = r.posted_at;
    const next = new Date(last);
    next.setFullYear(next.getFullYear() + 1);
    fees.push({
      account_id: r.account_id,
      last_charged: last.toISOString().slice(0, 10),
      next_estimated: next.toISOString().slice(0, 10),
      amount: Math.abs(Number(r.amount)),
      description: r.description,
    });
  }
  res.json({ fees });
});

/**
 * GET /api/banking/credit-card-debug — returns the largest 30 credit-card
 * transactions in the last 90 days. Used to figure out what annual-fee
 * descriptions actually look like in the user's data so we can tune the
 * pattern matching.
 */
bankingRouter.get('/credit-card-debug', async (req, res) => {
  if (bankingDisabled(res)) return;
  const userId = req.user!.id;
  const since = new Date(Date.now() - 90 * 86400 * 1000);
  const rows = await query<{
    posted_at: Date;
    amount: string;
    description: string;
    merchant: string | null;
    account_name: string;
    institution: string | null;
  }>(
    `SELECT t.posted_at, t.amount, t.description, t.merchant,
            ba.name AS account_name, ba.institution
     FROM transactions t
     JOIN bank_accounts ba ON ba.id = t.account_id
     WHERE t.user_id = $1
       AND ba.account_type = 'credit_card'
       AND t.amount < 0
       AND t.posted_at >= $2
     ORDER BY ABS(t.amount) DESC
     LIMIT 30`,
    [userId, since],
  );
  res.json({
    transactions: rows.rows.map((r) => ({
      ...r,
      amount: Number(r.amount),
      posted_at: r.posted_at.toISOString().slice(0, 10),
    })),
  });
});

/**
 * DELETE /api/banking/connection — revoke the stored connection and all
 * cascaded bank_accounts + transactions.
 */
bankingRouter.delete('/connection', async (req, res) => {
  if (bankingDisabled(res)) return;
  const userId = req.user!.id;
  const result = await query(
    `DELETE FROM simplefin_connections WHERE user_id = $1`,
    [userId],
  );
  res.json({ ok: true, deleted: result.rowCount ?? 0 });
});

// ---- Recurring-bill detection helpers ---------------------------------

/**
 * Normalize a merchant/description string so two charges from the same vendor
 * group together regardless of trailing reference numbers, common boilerplate,
 * or weird whitespace. Conservative — we'd rather miss a group than merge
 * unrelated merchants together.
 */
function normalizeMerchant(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[#*]/g, ' ')
    .replace(/\s+/g, ' ')
    // Strip long numeric / alphanumeric ID tails ("ABC12345", "#12345").
    .replace(/\b[A-Z0-9]*\d{4,}[A-Z0-9]*\b/g, ' ')
    // Strip generic transaction boilerplate.
    .replace(
      /\b(BILL\s*PAYMENT|BILL\s*PAY|RECURRING|ONLINE|PAYMENT|PURCHASE|DEBIT|ACH|WEB|POS|CARD|TRANSACTION|REF|INV)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual' | 'custom';

function classifyCadence(medianDays: number): { cadence: Cadence; label: string } | null {
  if (medianDays >= 5 && medianDays <= 10) return { cadence: 'weekly', label: 'Weekly' };
  if (medianDays >= 12 && medianDays <= 17) return { cadence: 'biweekly', label: 'Bi-weekly' };
  if (medianDays >= 26 && medianDays <= 35) return { cadence: 'monthly', label: 'Monthly' };
  if (medianDays >= 85 && medianDays <= 95) return { cadence: 'quarterly', label: 'Quarterly' };
  if (medianDays >= 355 && medianDays <= 375) return { cadence: 'annual', label: 'Annual' };
  return null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface DetectInput {
  posted_at: Date;
  amount: number; // positive value (we already took abs of spend amount)
  raw: string;
  account_id: string;
}

interface RecurringCandidate {
  merchant: string;
  median_amount: number;
  cadence: Cadence;
  cadence_label: string;
  occurrences: number;
  last_seen: string;
  next_estimated: string;
  account_id: string;
  confidence: number;
  amount_variance_pct: number;
  recent_amounts: number[];
}

function detectRecurring(
  txns: DetectInput[],
  existingKeys: Set<string>,
): RecurringCandidate[] {
  // Bucket by normalized merchant + account so a Chase Netflix charge doesn't
  // merge with a BofA Netflix charge (they might be different subscriptions).
  const groups = new Map<string, DetectInput[]>();
  for (const t of txns) {
    const norm = normalizeMerchant(t.raw);
    if (!norm || norm.length < 3) continue;
    if (existingKeys.has(norm)) continue;
    const key = `${norm}::${t.account_id}`;
    const arr = groups.get(key);
    if (arr) arr.push(t);
    else groups.set(key, [t]);
  }

  const candidates: RecurringCandidate[] = [];
  for (const [key, items] of groups) {
    if (items.length < 2) continue;
    items.sort((a, b) => a.posted_at.getTime() - b.posted_at.getTime());

    const amounts = items.map((i) => i.amount);
    const medAmount = median(amounts);
    if (medAmount < 1) continue; // dust — likely fees, not subscriptions

    // Coefficient of variation on amounts. Subscriptions vary a bit (tax,
    // upgrades), but >25% drift usually means we grouped unrelated charges.
    const amountStdev = Math.sqrt(
      amounts.reduce((s, a) => s + (a - medAmount) ** 2, 0) / amounts.length,
    );
    const amountCv = medAmount === 0 ? 1 : amountStdev / medAmount;
    if (amountCv > 0.5) continue; // wildly inconsistent — skip

    const intervals: number[] = [];
    for (let i = 1; i < items.length; i++) {
      const days =
        (items[i]!.posted_at.getTime() - items[i - 1]!.posted_at.getTime()) /
        86_400_000;
      intervals.push(days);
    }
    const medInterval = median(intervals);
    const cadence = classifyCadence(medInterval);
    if (!cadence) continue;

    // Confidence: more occurrences + lower variance → higher score.
    let confidence = 40 + Math.min(items.length, 6) * 8; // 56..88
    confidence -= Math.round(amountCv * 60); // up to -30
    const intervalStdev =
      intervals.length > 0
        ? Math.sqrt(
            intervals.reduce((s, v) => s + (v - medInterval) ** 2, 0) / intervals.length,
          )
        : 0;
    const intervalCv = medInterval === 0 ? 1 : intervalStdev / medInterval;
    confidence -= Math.round(intervalCv * 30);
    confidence = Math.max(0, Math.min(100, confidence));
    if (confidence < 45) continue;

    const last = items[items.length - 1]!.posted_at;
    const nextEst = new Date(last.getTime() + medInterval * 86_400_000);

    candidates.push({
      merchant: key.split('::')[0]!,
      median_amount: Math.round(medAmount * 100) / 100,
      cadence: cadence.cadence,
      cadence_label: cadence.label,
      occurrences: items.length,
      last_seen: last.toISOString().slice(0, 10),
      next_estimated: nextEst.toISOString().slice(0, 10),
      account_id: items[0]!.account_id,
      confidence,
      amount_variance_pct: Math.round(amountCv * 1000) / 10,
      recent_amounts: amounts.slice(-3).map((v) => Math.round(v * 100) / 100),
    });
  }

  // Highest confidence first, then largest amount.
  candidates.sort((a, b) => b.confidence - a.confidence || b.median_amount - a.median_amount);
  return candidates;
}
