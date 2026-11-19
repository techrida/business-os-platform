// Words for the bill inbox's duplicate-invoice warning (I-33) and the vendor's claimed amount. A warning, not a
// block: staff decide whether a repeated invoice number is a resend or a new bill. Server Components only (money
// formatting pulls in @bos/locale).
import type { InvoiceDuplicate } from '@/lib/api-payables';
import { money, when } from '@/lib/kernel-format';

const CURRENCIES = ['NPR', 'INR', 'USD'] as const;
type Currency = (typeof CURRENCIES)[number];
const asCurrency = (c: string | null): Currency =>
  (CURRENCIES as readonly string[]).includes(c ?? '') ? (c as Currency) : 'NPR';

/** `NPR 1,12,999.00`, or null when the amount is unknown. */
export function amountText(amount: string | null, currency: string | null): string | null {
  return amount === null ? null : money(amount, asCurrency(currency));
}

/** One earlier bill or submission, e.g. `Bill BILL-2083/84-00005 (NPR 1,13,000.00)`. */
export function duplicateText(d: InvoiceDuplicate): string {
  const what =
    d.kind === 'bill'
      ? d.number !== null
        ? `Bill ${d.number}`
        : `Draft bill entered ${when(d.at, 'date')}`
      : `Submission received ${when(d.at, 'date')}`;
  const amount = amountText(d.amount, d.currency);
  return `${what}, invoice ${d.vendorInvoiceNo}${amount !== null ? ` (${amount})` : ''}`;
}
