/**
 * Shared classification helpers for bank transactions.
 *
 * The main one: `isTransferOrPayment` — filters out entries that aren't
 * actual spending but instead move money between accounts (paying off a
 * credit card, transferring to savings, etc). Counting these as spend
 * double-counts, since the ORIGINAL charges on the card were already spend.
 *
 * Applied consistently in: Spending totals (Budget page), Spending tab,
 * Recurring bill detection.
 */

const CC_PAYMENT_PATTERNS = [
  // Chase
  /\bpayment to chase card\b/i,
  /\bchase\s+(credit\s+)?card\s+(payment|pmt|autopay)\b/i,
  /\bchase\s+epay\b/i,
  // Amex
  /\bamerican express\s+(ach\s+)?p(a|m)?y?(mt|ment)\b/i,
  /\bamex\s+epay(ment)?\b/i,
  /\bamex\s+ach\s+pmt\b/i,
  // Capital One
  /\bcapital one\s+(crcard|cardmemberserv|mobile)\s*(pmt|payment)?\b/i,
  /\bcapital one\s+online\s+pmt\b/i,
  // Discover
  /\bdiscover\s+(e|de)-?payment\b/i,
  /\bdiscover\s+card\s+pmt\b/i,
  // Bank of America / other
  /\bbank of america\s+credit\s+card\s+(bill\s+)?p(mt|ayment)\b/i,
  /\bapplecard gsbank payment\b/i,
  /\bcitibank\s+payment\b/i,
  // Generic
  /\bcredit card payment\b/i,
  /\bautopay to.*(card|credit)\b/i,
];

const TRANSFER_PATTERNS = [
  /\bxfer\b/i,
  /\btransfer to (savings|checking|account)\b/i,
  /\bonline transfer to\b/i,
  /\binternal transfer\b/i,
  /\bwithdrawal to savings\b/i,
];

/**
 * True when this outflow is a transfer or credit-card-payoff, not real spend.
 * We check both `description` and `merchant` since bank formatting varies.
 */
export function isTransferOrPayment(
  description: string | null | undefined,
  merchant: string | null | undefined,
): boolean {
  const haystack = `${description ?? ''} ${merchant ?? ''}`;
  if (!haystack.trim()) return false;
  for (const pattern of CC_PAYMENT_PATTERNS) {
    if (pattern.test(haystack)) return true;
  }
  for (const pattern of TRANSFER_PATTERNS) {
    if (pattern.test(haystack)) return true;
  }
  return false;
}

/**
 * SQL clause + params for excluding transfers/payments at the DB layer.
 * Returns a fragment like `AND NOT (description ILIKE ANY($3) OR merchant ILIKE ANY($3))`
 * plus the pattern array. The caller appends this to their WHERE and passes
 * the array as the next parameter.
 */
export function getTransferExclusionClause(paramIndex: number): {
  clause: string;
  patterns: string[];
} {
  const patterns = [
    // Chase
    '%payment to chase card%',
    '%chase credit card payment%',
    '%chase credit card pmt%',
    '%chase card payment%',
    '%chase card pmt%',
    '%chase epay%',
    // Amex
    '%american express ach pmt%',
    '%american express payment%',
    '%amex epayment%',
    '%amex epay%',
    '%amex ach pmt%',
    // Capital One
    '%capital one crcard%',
    '%capital one cardmemberserv%',
    '%capital one mobile pmt%',
    '%capital one online pmt%',
    '%capital one payment%',
    // Discover
    '%discover e-payment%',
    '%discover epayment%',
    '%discover card pmt%',
    '%discover card payment%',
    // Apple Card / others
    '%applecard gsbank payment%',
    '%bank of america credit card%',
    '%citibank payment%',
    // Generic
    '%credit card payment%',
    // Transfers
    '%online transfer to%',
    '%internal transfer%',
    '%transfer to savings%',
    '%transfer to checking%',
    '%withdrawal to savings%',
  ];
  const clause = `AND NOT (COALESCE(description,'') ILIKE ANY($${paramIndex}) OR COALESCE(merchant,'') ILIKE ANY($${paramIndex}))`;
  return { clause, patterns };
}
