// How the invoice document on the detail page writes numbers and dates. It follows the PDF
// (apps/api/src/modules/invoices/render/invoice-html.ts): the first print's frozen format when there
// is one, so the screen and every copy of the PDF agree, else the tenant's current display settings.
import type { DocumentSellerContact, InvoiceDetail } from '@bos/contracts';
import {
  amountInWords,
  formatCustomerDate,
  toBs,
  type CustomerDateFormat,
  type NumberSystems,
} from '@bos/locale';

export interface DocumentFormat {
  numberSystems: NumberSystems;
  dateFormat: CustomerDateFormat;
}

/** The first print's format wins; without one (never printed, or printed before it was stored), today's settings. */
export function documentFormat(
  frozen: InvoiceDetail['format'],
  current: DocumentFormat,
): DocumentFormat {
  if (frozen === null || frozen === undefined) return current;
  return { numberSystems: frozen.numberSystems, dateFormat: frozen.dateFormat };
}

/**
 * The seller's phones, email and signatory as the original PDF printed them (frozen at print 1, U16-Q4), so a profile
 * edit never makes the screen disagree with the PDF. Without a frozen one (never printed, or printed before contacts
 * were frozen), the company profile as it is now. Null stays null: print 1 could not read the profile, and printed none.
 */
export function documentContact(
  frozen: InvoiceDetail['format'],
  current: DocumentSellerContact | null,
): DocumentSellerContact | null {
  if (frozen?.sellerContact === undefined) return current;
  return frozen.sellerContact;
}

/** Noon in Kathmandu (UTC+05:45) on the calendar day, so no timezone shifts the day. Same as the PDF. */
const kathmanduNoon = (isoDate: string): Date => new Date(`${isoDate}T12:00:00+05:45`);

/**
 * A calendar date in the document's pattern, with its Bikram Sambat form as the PDF prints it: the issue date's BS
 * form is the one frozen at issue; any other date is converted. Outside the converter's range, no BS form.
 */
export function documentDate(
  isoDate: string,
  bsFrozen: string | null,
  pattern: CustomerDateFormat,
): { ad: string; bs: string | null } {
  const ad = formatCustomerDate(isoDate, pattern);
  if (bsFrozen !== null) return { ad, bs: `${bsFrozen} BS` };
  try {
    const bs = toBs(kathmanduNoon(isoDate));
    return { ad, bs: `${String(bs.day).padStart(2, '0')} ${bs.monthNameEn} ${bs.year} BS` };
  } catch (error) {
    if (error instanceof RangeError) return { ad, bs: null };
    throw error;
  }
}

/** Whole days from the issue date to the due date, or null when either is missing or the due date comes first. */
export function daysToPay(issueDate: string | null, dueDate: string | null): number | null {
  if (issueDate === null || dueDate === null) return null;
  const days = (Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${issueDate}T00:00:00Z`)) / 864e5;
  return Number.isFinite(days) && days >= 0 ? Math.round(days) : null;
}

/** The total in words, grouped in the currency's number system (lakh and crore, or million). Null on odd data. */
export function totalInWords(
  amount: string,
  currency: keyof NumberSystems,
  numberSystems: NumberSystems,
): string | null {
  try {
    return amountInWords(amount, currency, numberSystems[currency]);
  } catch {
    return null;
  }
}
