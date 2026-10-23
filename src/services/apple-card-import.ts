// Apple Card can't be linked through SimpleFIN (Goldman Sachs doesn't expose
// it to aggregators), but Wallet / card.apple.com export transactions as CSV:
//
//   Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By
//   10/05/2026,10/06/2026,"JEWEL OSCO ...","Jewel-Osco","Grocery","Purchase","42.10","Mark Hamilton"
//
// Apple's sign convention is the card's view: purchases are positive,
// payments/credits negative. Ledger stores money out as negative, so amounts
// are flipped. Each row gets a deterministic ID, so importing overlapping
// exports never creates duplicates.
import { createHash } from 'node:crypto';

export interface AppleCardRow {
  id: string;
  posted: Date;
  amount: number; // ledger sign: negative = spending
  description: string;
  merchant: string | null;
  appleCategory: string | null;
  type: string;
  pending: boolean;
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

function parseUsDate(s: string): Date | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(Date.UTC(year, Number(m[1]) - 1, Number(m[2])));
  }
  const iso = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  return null;
}

export function parseAppleCardCsv(text: string): { rows: AppleCardRow[]; skipped: number } {
  const table = parseCsv(text);
  if (table.length < 2) throw new Error('The file has no transactions.');
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const col = (...names: string[]): number => header.findIndex((h) => names.some((n) => h.startsWith(n)));
  const iDate = col('transaction date');
  const iClear = col('clearing date');
  const iDesc = col('description');
  const iMerchant = col('merchant');
  const iCat = col('category');
  const iType = col('type');
  const iAmount = col('amount');
  if (iDate < 0 || iDesc < 0 || iAmount < 0) {
    throw new Error(
      'This doesn\'t look like an Apple Card export. Export as CSV from Wallet → Apple Card → Card Balance → Export Transactions, or from card.apple.com.',
    );
  }

  const seen = new Map<string, number>();
  const rows: AppleCardRow[] = [];
  let skipped = 0;
  for (const r of table.slice(1)) {
    const date = parseUsDate(r[iDate] ?? '');
    const raw = (r[iAmount] ?? '').replace(/[$,\s]/g, '');
    const appleAmount = Number(raw);
    if (!date || raw === '' || !Number.isFinite(appleAmount)) {
      skipped++;
      continue;
    }
    const description = (r[iDesc] ?? '').trim();
    const clearing = iClear >= 0 ? (r[iClear] ?? '').trim() : '';
    const type = iType >= 0 ? (r[iType] ?? '').trim() : '';
    // Same date + description + amount can legitimately repeat (two coffees),
    // so the occurrence number is part of the ID.
    const base = `${date.toISOString().slice(0, 10)}|${description}|${appleAmount.toFixed(2)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    rows.push({
      id: 'applecard-' + createHash('sha1').update(`${base}|${n}`).digest('hex').slice(0, 20),
      posted: date,
      amount: -Math.round(appleAmount * 100) / 100,
      description,
      merchant: iMerchant >= 0 ? (r[iMerchant] ?? '').trim() || null : null,
      appleCategory: iCat >= 0 ? (r[iCat] ?? '').trim() || null : null,
      type,
      pending: clearing === '',
    });
  }
  return { rows, skipped };
}
