// SimpleFIN Bridge integration.
//
// Auth model:
//   1. User creates a SimpleFIN account at bridge.simplefin.org and links banks
//      through the SimpleFIN bridge UI.
//   2. SimpleFIN gives them a one-time-use "Setup Token" (base64-encoded URL).
//   3. We exchange the Setup Token for a long-lived "Access URL" (HTTP Basic
//      credentials embedded in the URL).
//   4. We store the Access URL encrypted (see services/crypto.ts).
//   5. The Access URL grants READ-ONLY access to the user's linked accounts
//      and transactions. SimpleFIN cannot move money.
//
// Docs: https://www.simplefin.org/protocol.html

const SETUP_TOKEN_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 30_000;

export interface SimpleFinOrg {
  domain?: string;
  name?: string;
  'sfin-url'?: string;
  url?: string;
}

export interface SimpleFinTransaction {
  id: string;
  posted: number; // unix seconds; 0 for pending transactions
  transacted_at?: number; // unix seconds, when the purchase happened
  amount: string;
  description: string;
  payee?: string;
  memo?: string;
  pending?: boolean;
}

export interface SimpleFinAccount {
  id: string;
  org: SimpleFinOrg;
  name: string;
  currency: string;
  balance: string;
  'available-balance'?: string;
  'balance-date': number;
  transactions?: SimpleFinTransaction[];
}

export interface SimpleFinAccountsResponse {
  errors?: string[];
  accounts: SimpleFinAccount[];
}

/**
 * Exchange a Setup Token for an Access URL.
 *
 * The Setup Token is a base64 string. Decoded, it's a claim URL like
 *   https://bridge.simplefin.org/simplefin/claim/<token>
 * We POST to that URL with no body and SimpleFIN returns the Access URL as
 * plain text. The Access URL embeds HTTP Basic credentials, so it should be
 * treated as a secret and never logged.
 */
export async function redeemSetupToken(setupToken: string): Promise<string> {
  const trimmed = setupToken.trim();
  if (!trimmed) throw new Error('Setup Token is empty');

  let claimUrl: string;
  try {
    claimUrl = Buffer.from(trimmed, 'base64').toString('utf8').trim();
  } catch {
    throw new Error('Setup Token is not valid base64');
  }
  if (!/^https:\/\/.+/i.test(claimUrl)) {
    throw new Error('Setup Token did not decode to a https URL');
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), SETUP_TOKEN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(claimUrl, { method: 'POST', signal: controller.signal });
  } catch (err) {
    throw new Error(
      `Could not reach SimpleFIN to redeem Setup Token: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `SimpleFIN rejected Setup Token (HTTP ${res.status}). ${text.slice(0, 200)}`,
    );
  }
  const accessUrl = (await res.text()).trim();
  if (!/^https:\/\/[^:]+:[^@]+@.+/i.test(accessUrl)) {
    throw new Error('SimpleFIN returned an unexpected Access URL format');
  }
  return accessUrl;
}

interface AccessUrlParts {
  base: string;
  authHeader: string;
}

/**
 * SimpleFIN Access URLs embed HTTP Basic credentials inline
 * (https://user:pass@host/...). Node's fetch refuses to use those, so we
 * extract them into an Authorization header and rebuild the URL without them.
 */
function parseAccessUrl(accessUrl: string): AccessUrlParts {
  const parsed = new URL(accessUrl);
  const user = decodeURIComponent(parsed.username);
  const pass = decodeURIComponent(parsed.password);
  if (!user || !pass) throw new Error('Access URL is missing credentials');
  const authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  parsed.username = '';
  parsed.password = '';
  // Trim trailing slashes from base so we can append paths cleanly.
  const base = parsed.toString().replace(/\/$/, '');
  return { base, authHeader };
}

/**
 * Fetch the user's bank accounts (and optionally transactions since a date)
 * from SimpleFIN. start_date / end_date are unix seconds.
 */
export async function fetchSimpleFinAccounts(
  accessUrl: string,
  options: { start_date?: number; end_date?: number; pending?: boolean } = {},
): Promise<SimpleFinAccountsResponse> {
  const { base, authHeader } = parseAccessUrl(accessUrl);
  const qs = new URLSearchParams();
  if (options.start_date != null) qs.set('start-date', String(options.start_date));
  if (options.end_date != null) qs.set('end-date', String(options.end_date));
  if (options.pending) qs.set('pending', '1');

  const url = `${base}/accounts${qs.size ? `?${qs.toString()}` : ''}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: authHeader, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(
      `SimpleFIN /accounts request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(t);
  }
  if (res.status === 403) {
    throw new Error('SimpleFIN access denied — the Access URL may be revoked. Reconnect to refresh.');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SimpleFIN /accounts failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
  return (await res.json()) as SimpleFinAccountsResponse;
}
