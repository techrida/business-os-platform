'use server';

import { randomUUID } from 'node:crypto';

import { VendorBillSubmissionBodySchema } from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { spaceAware } from '@/lib/amount-hint';
import { ApiError } from '@/lib/api';
import { submitVendorBill } from '@/lib/api.vendor-writes';
import { currencyNotEnabledText } from '@/lib/enabled-currencies';

import {
  codeOf,
  failed,
  type FormState,
  keyOf,
  normalizeAmount,
  NOT_A_VENDOR,
  text,
  UUID,
  vendorSession,
} from '../../_upload/action-kit';

/**
 * Submit a bill, for the vendor. The submission is a claim staff check: an inbox row, not a bill
 * in the ledger, so the total here is the vendor's own figure as typed and nothing is computed.
 * The form carries an Idempotency-Key the page generated once per render, and the key and the
 * uploaded document id stay in the form across a retry, so a double click, or a retry after a
 * timeout, records the bill once. The vendor comes from the signed-in user (the body has no
 * party or vendor id); server actions run no layout, so this checks for itself that the session
 * is a vendor's.
 */

export type BillField =
  'file' | 'vendorInvoiceNo' | 'invoiceDate' | 'currency' | 'claimedTotal' | 'purchaseOrderId';
export type BillFormState = FormState<BillField>;

const HERE = '/vendor/bills/new';

const FIELD_MESSAGE: Record<BillField, string> = {
  file: 'Add your bill as a PDF or a picture.',
  vendorInvoiceNo: 'Enter the invoice number printed on your bill (up to 64 characters).',
  invoiceDate: 'Enter the date on your invoice.',
  currency: 'Choose the currency on your invoice.',
  claimedTotal:
    'Enter the total on your invoice: zero or more, with up to 2 decimals (for example 20,18,180.00).',
  purchaseOrderId: 'Choose one of your purchase orders, or leave it empty.',
};

export async function submitBillAction(
  prev: BillFormState,
  form: FormData,
): Promise<BillFormState> {
  const session = await vendorSession(HERE);
  const key = keyOf(form, prev);
  if (!session) return { key, error: NOT_A_VENDOR };

  const documentId = text(form, 'documentId');
  const purchaseOrderId = text(form, 'purchaseOrderId');
  const candidate = {
    documentId: UUID.test(documentId) ? documentId : '',
    vendorInvoiceNo: text(form, 'vendorInvoiceNo'),
    invoiceDate: text(form, 'invoiceDate'),
    currency: text(form, 'currency'),
    claimedTotal: normalizeAmount(text(form, 'claimedTotal')),
    ...(purchaseOrderId === '' ? {} : { purchaseOrderId }),
  };

  const parsed = VendorBillSubmissionBodySchema.safeParse(candidate);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<BillField, string>> = {};
    for (const issue of parsed.error.issues) {
      const head = issue.path[0];
      const field: BillField | undefined = head === 'documentId' ? 'file' : (head as BillField);
      if (field !== undefined && field in FIELD_MESSAGE) fieldErrors[field] = FIELD_MESSAGE[field];
    }
    if (fieldErrors.claimedTotal !== undefined) {
      fieldErrors.claimedTotal = spaceAware(text(form, 'claimedTotal'), fieldErrors.claimedTotal);
    }
    // Nothing reached the API, so the same key is still unused.
    return { key, fieldErrors };
  }

  try {
    await submitVendorBill(session, parsed.data, key);
  } catch (err) {
    // A 404 is a purchase order that is not this vendor's, or a file the API does not have.
    if (err instanceof ApiError && err.status === 404) {
      return parsed.data.purchaseOrderId === undefined
        ? {
            key: randomUUID(),
            error: 'We could not find your uploaded file. Remove it, upload it again and submit.',
          }
        : {
            key: randomUUID(),
            fieldErrors: {
              purchaseOrderId:
                'We could not find that purchase order. Choose it again, or leave it empty.',
            },
          };
    }
    if (err instanceof ApiError && err.status === 422 && codeOf(err) === 'BILL_DATE_IN_FUTURE') {
      return {
        key: randomUUID(),
        fieldErrors: {
          invoiceDate: 'The invoice date is after today. Enter the date printed on your invoice.',
        },
      };
    }
    // A 422 CURRENCY_NOT_ENABLED is a currency the company switched off since the page loaded (D44).
    const switchedOff = currencyNotEnabledText(err);
    if (switchedOff !== undefined) {
      return { key: randomUUID(), fieldErrors: { currency: switchedOff } };
    }
    return failed<BillField>(err, key, HERE, {
      noun: 'bill',
      forbidden:
        'Your account cannot send bills right now. Please contact the person you work with at our company.',
    });
  }
  revalidatePath('/vendor/bills');
  // `redirect` throws, so it stays outside the try block.
  redirect(`${HERE}?sent=1`);
}
