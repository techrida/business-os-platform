'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { keyOf, nextKey } from '@/components/p2/crm/idempotency';
import { isGuid } from '@/components/p2/customers/format';
import { convertSubmission, createRfq, recordQuotation } from '@/lib/api-rfqs';
import { requireStaffSession } from '@/lib/bff';

import { rfqFailure } from './_lib/failure';
import {
  parseQuoteValues,
  parseRfqValues,
  quoteValuesFromForm,
  rfqValuesFromForm,
} from './_lib/forms';
import { rfqGrants } from './_lib/model';
import type { RfqFormState } from './_lib/state';

/**
 * Server actions for the RFQ screens. Each one asks `requireStaffSession` first, checks the
 * permission it needs (deny by default: the API still decides every call), validates with the
 * contracts' schema, and words any refusal for a person through `rfqFailure`. The browser never
 * sees the API URL or a token.
 *
 * Idempotency: every write carries the key the form submitted. A definite answer (a 4xx other
 * than the "still in progress" 409) rotates it, because the next try is a new decision. A timeout,
 * a 5xx or the in-progress 409 keeps it, so the first request is replayed instead of a second one
 * being made. The RFQ bodies are strict and carry no `expectedVersion`. Money never passes through
 * here except as the text the person typed.
 */

const INCOMPLETE = 'This form is incomplete. Reload the page and try again.';
const NO_SOURCING =
  'Your roles do not include sourcing. Ask an administrator if you need to open RFQs or enter quotations.';

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

export async function createRfqAction(
  _prev: RfqFormState,
  form: FormData,
): Promise<RfqFormState> {
  const session = await requireStaffSession('/procurement/rfqs/new');
  const key = keyOf(form);
  if (!rfqGrants(session.roles).sourcing) return { key, errors: {}, error: NO_SOURCING };
  const parsed = parseRfqValues(rfqValuesFromForm(form));
  if (!parsed.ok) return { key, errors: parsed.errors };

  let id: string;
  try {
    id = (await createRfq(session, parsed.data, key)).id;
  } catch (err) {
    const f = rfqFailure(err, 'create');
    return {
      key: nextKey(err, key),
      errors: {},
      error: f.message,
      ...(f.reload ? { reload: true } : {}),
    };
  }
  revalidatePath('/procurement/rfqs');
  revalidatePath('/procurement/requests');
  // Opening an RFQ moves the purchase request to sourcing, so its page is stale too.
  revalidatePath(`/procurement/requests/${parsed.data.purchaseRequestId}`);
  // `redirect` throws, so it stays outside the try block.
  redirect(`/procurement/rfqs/${encodeURIComponent(id)}?created=1`);
}

/**
 * Staff enter a quotation (`mode=record`: vendor and uploaded document typed in) or convert a
 * clean vendor submission (`mode=convert`: both come from the submission row). The mode is the
 * form's; the body each one sends is the contract's, so a convert never carries a vendor.
 */
export async function recordQuotationAction(
  _prev: RfqFormState,
  form: FormData,
): Promise<RfqFormState> {
  const rfqId = text(form, 'rfqId');
  const key = keyOf(form);
  if (!isGuid(rfqId)) return { key, errors: {}, error: INCOMPLETE, reload: true };
  const session = await requireStaffSession(`/procurement/rfqs/${rfqId}`);
  if (!rfqGrants(session.roles).sourcing) return { key, errors: {}, error: NO_SOURCING };
  const parsed = parseQuoteValues(quoteValuesFromForm(form));
  if (!parsed.ok) return { key, errors: parsed.errors };

  try {
    if (parsed.mode === 'convert') await convertSubmission(session, rfqId, parsed.data, key);
    else await recordQuotation(session, rfqId, parsed.data, key);
  } catch (err) {
    const f = rfqFailure(err, parsed.mode);
    return {
      key: nextKey(err, key),
      errors: {},
      error: f.message,
      ...(f.reload ? { reload: true } : {}),
    };
  }
  revalidatePath('/procurement/rfqs');
  revalidatePath(`/procurement/rfqs/${rfqId}`);
  redirect(`/procurement/rfqs/${encodeURIComponent(rfqId)}?quoted=1`);
}
