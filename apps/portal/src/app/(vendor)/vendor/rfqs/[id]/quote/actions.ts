'use server';

import { randomUUID } from 'node:crypto';

import { VendorQuotationSubmissionBodySchema } from '@bos/contracts';
import { redirect } from 'next/navigation';

import { DEADLINE_PASSED_TEXT } from '@/components/vendor/rfq-deadline';
import { spaceAware } from '@/lib/amount-hint';
import { ApiError } from '@/lib/api';
import { submitVendorQuotation } from '@/lib/api.vendor-writes';
import { currencyNotEnabledText } from '@/lib/enabled-currencies';

import {
  failed,
  type FormState,
  keyOf,
  normalizeAmount,
  NOT_A_VENDOR,
  text,
  UUID,
  vendorSession,
} from '../../../_upload/action-kit';

/**
 * Submit a quotation, for the vendor. The total is the vendor's own figure as typed and is only
 * cleaned of lakh commas: nothing is added up from the request's lines. The form carries an
 * Idempotency-Key the page generated once per render, and the key and the uploaded document id
 * stay in the form across a retry, so a double click, or a retry after a timeout, records the
 * quotation once. The vendor comes from the signed-in user (the body has no party or vendor id);
 * server actions run no layout, so this checks for itself that the session is a vendor's.
 */

export type QuoteField =
  'file' | 'currency' | 'total' | 'vendorRef' | 'validUntil' | 'deliveryDays';
export type QuoteFormState = FormState<QuoteField>;

const LIST = '/vendor/rfqs';

/**
 * F1-Q47: the API's 409 for a quotation sent after the request's deadline, read by its code or,
 * while the error filter does not pass that code yet, by its exact sentence (keep it equal to
 * RFQ_DEADLINE_PASSED_MESSAGE in the API's sourcing.rules.ts). Any other 409 still means "in progress".
 */
const DEADLINE_PASSED_CODE = 'rfq_deadline_passed';
const DEADLINE_PASSED_API_TEXT =
  'The quotation deadline of this RFQ has passed. Procurement can extend it to take more quotations.';

function isDeadlinePassed(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const e = (err.body as { error?: { code?: unknown; message?: unknown } } | null | undefined)
    ?.error;
  return e?.code === DEADLINE_PASSED_CODE || e?.message === DEADLINE_PASSED_API_TEXT;
}

const FIELD_MESSAGE: Record<QuoteField, string> = {
  file: 'Add your quotation as a PDF or a picture.',
  currency: 'Choose the currency of your quotation.',
  total:
    'Enter the total of your quotation: zero or more, with up to 2 decimals (for example 20,18,180.00).',
  vendorRef: 'Your reference can be up to 64 characters.',
  validUntil: 'Enter the last date your prices hold, or leave it empty.',
  deliveryDays: 'Enter the delivery time as a whole number of days (0 to 1000), or leave it empty.',
};

export async function submitQuoteAction(
  prev: QuoteFormState,
  form: FormData,
): Promise<QuoteFormState> {
  const rfqId = text(form, 'rfqId');
  const here = UUID.test(rfqId) ? `${LIST}/${rfqId}/quote` : LIST;
  const session = await vendorSession(here);
  const key = keyOf(form, prev);
  if (!session) return { key, error: NOT_A_VENDOR };
  // A request id the page did not write: nothing is sent, and the key is still unused.
  if (!UUID.test(rfqId)) {
    return {
      key,
      error: 'We could not tell which request this is for. Reload the page and try again.',
    };
  }

  const documentId = text(form, 'documentId');
  const vendorRef = text(form, 'vendorRef').trim();
  const validUntil = text(form, 'validUntil');
  const days = text(form, 'deliveryDays').trim();
  const fieldErrors: Partial<Record<QuoteField, string>> = {};

  // A whole number of days only: a digit string is accepted, empty is left out, all else refused.
  let deliveryDays: number | undefined;
  if (days !== '') {
    if (/^\d{1,4}$/.test(days)) deliveryDays = Number(days);
    else fieldErrors.deliveryDays = FIELD_MESSAGE.deliveryDays;
  }

  const candidate = {
    rfqId,
    documentId: UUID.test(documentId) ? documentId : '',
    currency: text(form, 'currency'),
    total: normalizeAmount(text(form, 'total')),
    ...(vendorRef === '' ? {} : { vendorRef }),
    ...(validUntil === '' ? {} : { validUntil }),
    ...(deliveryDays === undefined ? {} : { deliveryDays }),
  };

  const parsed = VendorQuotationSubmissionBodySchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const head = issue.path[0];
      const field: QuoteField | undefined = head === 'documentId' ? 'file' : (head as QuoteField);
      if (field !== undefined && field in FIELD_MESSAGE) fieldErrors[field] = FIELD_MESSAGE[field];
    }
  }
  if (fieldErrors.total !== undefined) {
    fieldErrors.total = spaceAware(text(form, 'total'), fieldErrors.total);
  }
  if (fieldErrors.deliveryDays !== undefined) {
    fieldErrors.deliveryDays = spaceAware(days, fieldErrors.deliveryDays);
  }
  if (!parsed.success || Object.keys(fieldErrors).length > 0) {
    // Nothing reached the API, so the same key is still unused.
    return { key, fieldErrors };
  }

  try {
    await submitVendorQuotation(session, parsed.data, key);
  } catch (err) {
    // A 404 is a request that is closed or not this vendor's, or a file the API does not have.
    if (err instanceof ApiError && err.status === 404) {
      return {
        key: randomUUID(),
        error:
          'This request or your uploaded file is no longer available. Go back to your requests to check that it is still open.',
      };
    }
    // The deadline passed while the form was open: a definite refusal, so the key rotates.
    if (isDeadlinePassed(err)) {
      return {
        key: randomUUID(),
        error: `The deadline for this request has passed. ${DEADLINE_PASSED_TEXT}`,
      };
    }
    // A 422 CURRENCY_NOT_ENABLED: the company switched the chosen currency off after the page loaded
    // (D44). Shown on the currency field, like the form's other blocking errors. A definite refusal
    // (the API replays it for the same key), so the key rotates.
    const notEnabled = currencyNotEnabledText(err);
    if (notEnabled !== undefined) {
      return { key: randomUUID(), fieldErrors: { currency: notEnabled } };
    }
    return failed<QuoteField>(err, key, here, {
      noun: 'quotation',
      forbidden:
        'Your account cannot send quotations right now. Please contact the person you work with at our company.',
    });
  }
  // `redirect` throws, so it stays outside the try block.
  redirect(`${here}?sent=1`);
}
