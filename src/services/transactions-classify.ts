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

/**
 * Card-side description of a payment arriving on a credit card account
 * ("AUTOMATIC PAYMENT - THANK YOU", "Payment Received", ...). Only meaningful
 * for positive amounts on credit_card accounts — the other side of a card
 * payoff, which must never count as income.
 */
const CARD_INFLOW_PATTERNS = [
  /\bpayment\b.*\bthank you\b/i,
  /\bthank you\b.*\bpayment\b/i,
  /\bpayment received\b/i,
  /\bautopay(ment)?\b/i,
  /\bautomatic payment\b/i,
  /\bonline payment\b/i,
  /\bmobile payment\b/i,
  /\bepayment\b/i,
  /\bpayment\s*-?\s*(web|ach|online|mobile)\b/i,
  /^\s*(payment|pymt|pmt)\b/i,
  /\b(pymt|pmt)\b/i,
];

export function isCardPaymentInflow(description: string | null | undefined, merchant: string | null | undefined): boolean {
  const haystack = `${description ?? ''} ${merchant ?? ''}`;
  return CARD_INFLOW_PATTERNS.some((p) => p.test(haystack));
}

/**
 * "Money moving between my own accounts" wording, used only to confirm a
 * candidate transfer PAIR (same amount, opposite sign, two of your own
 * accounts, within a few days). Deliberately excludes payment apps
 * (Zelle/Venmo) and the word "payment": a $50 Zelle to a friend next to an
 * unrelated $50 deposit must not pair up. Card payoffs don't need this — the
 * credit-card side of the pair already proves it.
 */
const TRANSFERISH = /\b(transfer|xfer|trnsfr|to sav|from sav|to chk|from chk|to checking|from checking|to savings|from savings|deposit from|withdrawal to|internal)\b/i;

export function looksLikeTransfer(description: string | null | undefined, merchant: string | null | undefined): boolean {
  return TRANSFERISH.test(`${description ?? ''} ${merchant ?? ''}`);
}

/**
 * Normalize a merchant/description so charges from the same vendor group
 * together regardless of store numbers, reference IDs and boilerplate.
 */
export function normalizeMerchant(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[#*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b[A-Z0-9]*\d{4,}[A-Z0-9]*\b/g, ' ')
    .replace(
      /\b(BILL\s*PAYMENT|BILL\s*PAY|RECURRING|ONLINE|PAYMENT|PURCHASE|DEBIT|ACH|WEB|POS|CARD|TRANSACTION|REF|INV)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}
