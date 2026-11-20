'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { keyOf } from '@/components/p2/crm/idempotency';
import { isGuid } from '@/components/p2/customers/format';
import {
  commitRfq,
  convertSubmission,
  createRfq,
  extendRfqDeadline,
  recommendQuotation,
  recordQuotation,
  scoreQuotation,
} from '@/lib/api-rfqs';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';
import { getPermissionCheck } from '@/lib/live-permissions';

import { isDeadlineInPast, rfqFailure } from './_lib/failure';
import {
  DEADLINE_IN_PAST,
  DEADLINE_NOT_LATER,
  parseExtensionValues,
  parseQuoteValues,
  parseRecommendValues,
  parseRfqValues,
  parseScoreValues,
  quoteValuesFromForm,
  recommendValuesFromForm,
  rfqValuesFromForm,
  scoreValuesFromForm,
} from './_lib/forms';
import { rfqGrants } from './_lib/model';
import type { CommandState, RfqEditState, RfqFormState } from './_lib/state';

/**
 * Server actions for the RFQ screens. Each one asks `requireStaffSession` first, checks the
 * live permission it needs (deny by default: the API still decides every call), validates with
 * the contracts' schema, and words any refusal for a person through `rfqFailure`. The browser never
 * sees the API URL or a token.
 *
 * Idempotency: every write carries the key the form submitted. A definite answer (a 4xx other
 * than 408, 429 and the "still in progress" 409) rotates it, because the next try is a new
 * decision. A timeout, 408, 429, a 5xx or the in-progress 409 keeps it so the first request is
 * replayed instead of a second one being made. The RFQ bodies are strict and carry no `expectedVersion`. Money never passes through
 * here except as the text the person typed.
 */

const INCOMPLETE = 'This form is incomplete. Reload the page and try again.';
const NO_SOURCING =
  'Your roles do not include sourcing. Ask an administrator if you need to open RFQs or enter quotations.';

/**
 * The key the next try sends. `rfqFailure` says what is final: a 4xx other than 408, 429 and the
 * in-progress 409 rotates it; a timeout, 408, 429, a 5xx or the in-progress 409 keeps it so the
 * first request is replayed instead of a second one being made.
 */
function keyAfter(failure: { definite: boolean }, key: string): string {
  return failure.definite ? randomUUID() : key;
}

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

export async function createRfqAction(_prev: RfqFormState, form: FormData): Promise<RfqFormState> {
  const session = await requireStaffSession('/procurement/rfqs/new');
  const key = keyOf(form);
  if (!rfqGrants(await getPermissionCheck(session)).sourcing) {
    return { key, errors: {}, error: NO_SOURCING };
  }
  const parsed = parseRfqValues(rfqValuesFromForm(form));
  if (!parsed.ok) return { key, errors: parsed.errors };

  let id: string;
  try {
    id = (await createRfq(session, parsed.data, key)).id;
  } catch (err) {
    const f = rfqFailure(err, 'create');
    // The deadline passed between the check above and the API's: say so next to the field.
    if (isDeadlineInPast(err)) {
      return { key: keyAfter(f, key), errors: { deadline: DEADLINE_IN_PAST } };
    }
    return {
      key: keyAfter(f, key),
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
  if (!rfqGrants(await getPermissionCheck(session)).sourcing) {
    return { key, errors: {}, error: NO_SOURCING };
  }
  const parsed = parseQuoteValues(quoteValuesFromForm(form));
  if (!parsed.ok) return { key, errors: parsed.errors };

  try {
    if (parsed.mode === 'convert') await convertSubmission(session, rfqId, parsed.data, key);
    else await recordQuotation(session, rfqId, parsed.data, key);
  } catch (err) {
    const f = rfqFailure(err, parsed.mode);
    return {
      key: keyAfter(f, key),
      errors: {},
      error: f.message,
      ...(f.reload ? { reload: true } : {}),
    };
  }
  revalidatePath('/procurement/rfqs');
  revalidatePath(`/procurement/rfqs/${rfqId}`);
  redirect(`/procurement/rfqs/${encodeURIComponent(rfqId)}?quoted=1`);
}

// ---------------------------------------------------------------------------------------------
// Scores, recommendation and commitment (the detail page's forms)
// ---------------------------------------------------------------------------------------------

/** One quotation's scores, one row per criterion. A repeat for the same criterion replaces it. */
export async function scoreQuotationAction(
  prev: RfqEditState,
  form: FormData,
): Promise<RfqEditState> {
  const rfqId = text(form, 'rfqId');
  const quotationId = text(form, 'quotationId');
  const key = keyOf(form);
  if (!isGuid(rfqId) || !isGuid(quotationId)) {
    return { key, errors: {}, count: prev.count, error: INCOMPLETE, reload: true };
  }
  const session = await requireStaffSession(`/procurement/rfqs/${rfqId}`);
  if (!rfqGrants(await getPermissionCheck(session)).sourcing) {
    return { key, errors: {}, count: prev.count, error: NO_SOURCING };
  }
  const parsed = parseScoreValues(scoreValuesFromForm(form));
  if (!parsed.ok) return { key, errors: parsed.errors, count: prev.count };

  let comparison: Awaited<ReturnType<typeof scoreQuotation>>;
  try {
    comparison = await scoreQuotation(session, rfqId, quotationId, parsed.data, key);
  } catch (err) {
    const f = rfqFailure(err, 'score');
    return {
      key: keyAfter(f, key),
      errors: {},
      count: prev.count,
      error: f.message,
      ...(f.reload ? { reload: true } : {}),
    };
  }
  revalidatePath(`/procurement/rfqs/${rfqId}`);
  // The average is the platform's, shown as it came.
  const average = comparison.find((q) => q.id === quotationId)?.averageScore ?? null;
  return {
    // The next save is a new decision about the same quotation, so it gets a new key.
    key: randomUUID(),
    errors: {},
    count: prev.count + 1,
    saved:
      average !== null
        ? `Scores saved. The average for this quotation is now ${average}.`
        : 'Scores saved.',
  };
}

/**
 * Recommends one quotation. With fewer quotations than the company's minimum the platform refuses
 * unless a reason came with it, and says so in `rfqFailure`'s words. On success the RFQ is
 * recommended and this form is gone, so the confirmation is a banner on the reloaded page.
 */
export async function recommendQuotationAction(
  _prev: RfqFormState,
  form: FormData,
): Promise<RfqFormState> {
  const rfqId = text(form, 'rfqId');
  const key = keyOf(form);
  if (!isGuid(rfqId)) return { key, errors: {}, error: INCOMPLETE, reload: true };
  const session = await requireStaffSession(`/procurement/rfqs/${rfqId}`);
  if (!rfqGrants(await getPermissionCheck(session)).sourcing) {
    return { key, errors: {}, error: NO_SOURCING };
  }
  const parsed = parseRecommendValues(recommendValuesFromForm(form));
  if (!parsed.ok) return { key, errors: parsed.errors };

  try {
    await recommendQuotation(session, rfqId, parsed.data, key);
  } catch (err) {
    const f = rfqFailure(err, 'recommend');
    return {
      key: keyAfter(f, key),
      errors: {},
      error: f.message,
      ...(f.reload ? { reload: true } : {}),
    };
  }
  revalidatePath('/procurement/rfqs');
  revalidatePath(`/procurement/rfqs/${rfqId}`);
  // `redirect` throws, so it stays outside the try block.
  redirect(`/procurement/rfqs/${encodeURIComponent(rfqId)}?recommended=1`);
}

/**
 * Submits the recommended quotation for the commitment approvals. The platform revalidates the
 * RFQ and its purchase request, which moves to `commitment_pending`; a step with nobody able to
 * decide it is a 422 and nothing is submitted.
 */
export async function commitRfqAction(prev: CommandState, form: FormData): Promise<CommandState> {
  const rfqId = text(form, 'rfqId');
  const key = keyOf(form);
  if (!isGuid(rfqId)) return { key, count: prev.count, error: INCOMPLETE, reload: true };
  const session = await requireStaffSession(`/procurement/rfqs/${rfqId}`);
  if (!rfqGrants(await getPermissionCheck(session)).sourcing) {
    return { key, count: prev.count, error: NO_SOURCING };
  }

  let purchaseRequestId: string;
  try {
    purchaseRequestId = (await commitRfq(session, rfqId, key)).purchaseRequestId;
  } catch (err) {
    const f = rfqFailure(err, 'commit');
    return {
      key: keyAfter(f, key),
      count: prev.count,
      error: f.message,
      ...(f.reload ? { reload: true } : {}),
    };
  }
  revalidatePath('/procurement/rfqs');
  revalidatePath(`/procurement/rfqs/${rfqId}`);
  revalidatePath('/procurement/requests');
  revalidatePath(`/procurement/requests/${purchaseRequestId}`);
  return {
    key: randomUUID(),
    count: prev.count + 1,
    saved: 'Submitted for commitment approval. The purchase request now waits on the approvers.',
  };
}

/**
 * F1-Q47: moves an open RFQ's quotation deadline later, so invited vendors can quote until then,
 * also after the old deadline passed. The new deadline is typed in Kathmandu time and must be after
 * now and after the current deadline (the form sends the current one so the check can say so next
 * to the field; the API checks both again against its own row).
 */
export async function extendDeadlineAction(
  prev: RfqEditState,
  form: FormData,
): Promise<RfqEditState> {
  const rfqId = text(form, 'rfqId');
  const current = text(form, 'currentDeadline');
  const key = keyOf(form);
  if (!isGuid(rfqId) || Number.isNaN(new Date(current).getTime())) {
    return { key, errors: {}, count: prev.count, error: INCOMPLETE, reload: true };
  }
  const session = await requireStaffSession(`/procurement/rfqs/${rfqId}`);
  if (!rfqGrants(await getPermissionCheck(session)).sourcing) {
    return { key, errors: {}, count: prev.count, error: NO_SOURCING };
  }
  const parsed = parseExtensionValues(text(form, 'deadline'), current);
  if (!parsed.ok) return { key, errors: parsed.errors, count: prev.count };

  let deadline: string;
  try {
    deadline = (await extendRfqDeadline(session, rfqId, parsed.data, key)).deadline;
  } catch (err) {
    const f = rfqFailure(err, 'extend');
    // Said next to the field: the time passed meanwhile, or someone else extended it further.
    if (isDeadlineInPast(err)) {
      return { key: keyAfter(f, key), errors: { deadline: DEADLINE_IN_PAST }, count: prev.count };
    }
    if (f.status === 400) {
      return {
        key: keyAfter(f, key),
        errors: { deadline: DEADLINE_NOT_LATER },
        count: prev.count,
      };
    }
    return {
      key: keyAfter(f, key),
      errors: {},
      count: prev.count,
      error: f.message,
      ...(f.reload ? { reload: true } : {}),
    };
  }
  revalidatePath('/procurement/rfqs');
  revalidatePath(`/procurement/rfqs/${rfqId}`);
  return {
    key: randomUUID(),
    errors: {},
    count: prev.count + 1,
    saved: `Deadline extended to ${when(deadline)}. Invited vendors can send quotations until then.`,
  };
}
