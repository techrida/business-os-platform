'use server';

import type { Permission } from '@bos/contracts';
import { revalidatePath } from 'next/cache';

import { ApiError } from '@/lib/api';
import { apiDetailOf, apiReasonOf } from '@/lib/api-code';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getGrants, hasGrant } from '@/lib/grants';

import { updateCustomer, updateCustomerTerms } from './api';
import { isGuid } from './format';
import {
  CUSTOMER_GONE,
  ENTITY_CHANGED,
  INCOMPLETE,
  NO_PERMISSION,
  NOTHING_CHANGED,
  OWNER_REFUSED,
  OWNER_REQUIRED,
  parseCreditLimit,
  sameLimit,
  staleMessage,
  type TermsEditState,
  type TermsField,
} from './terms-form';

/**
 * Server actions of the customer page's Commercial terms card: one field per save. Each one asks
 * `requireStaffSession`, checks the one grant its route needs (not customer.write: Finance sets limits and Management
 * changes owners without it), validates before anything is sent, and words every refusal for a person. The API
 * still decides each call and audits each change.
 *
 * The version sent is the one the page rendered. A 409 reloads the page data (revalidatePath), so the dialog then
 * carries the latest value and version and says why: saving again is the person's informed choice.
 *
 * The terms saves also send the legal entity the page was rendered for (`organizationId`): the API acts for the
 * session's entity at submit time, so a person who switched entity in another tab is refused (409 `entity_changed`)
 * instead of overwriting the other entity's terms with this form.
 */

type Session = Awaited<ReturnType<typeof requireStaffSession>>;

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

/** A row version from the page: a positive integer, or undefined when the field is empty (no terms row yet). */
function versionOf(form: FormData, name: string): number | undefined | 'bad' {
  const raw = text(form, name);
  if (raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 'bad';
}

/** `error.fieldErrors[field]` of a 422 (the error filter passes it through; ErrorBodySchema does not declare it). */
function fieldErrorOf(err: unknown, field: string): string | undefined {
  if (!(err instanceof ApiError) || typeof err.body !== 'object' || err.body === null)
    return undefined;
  const error = (err.body as { error?: { fieldErrors?: Record<string, unknown> } }).error;
  const value = error?.fieldErrors?.[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The refusal of a card save, in plain words. Refusals that mean the page is out of date reload its data. */
function refused(
  err: unknown,
  field: TermsField,
  customerId: string,
  same: { savedCount: number },
): TermsEditState {
  const failure = failureOf(err);
  const reload = () => revalidatePath(`/customers/${customerId}`);
  // No reload: it would re-point the open dialog at the entity the person switched to.
  if (failure.status === 409 && apiReasonOf(err) === 'entity_changed') {
    return { errors: {}, error: ENTITY_CHANGED, entityChanged: true, ...same };
  }
  if (failure.status === 409) {
    reload();
    return { errors: {}, error: staleMessage(field), stale: true, ...same };
  }
  // No reload on a 403: it could take the dialog away (the card stops offering the edit) before the refusal is read.
  if (failure.status === 403) return { errors: {}, error: NO_PERMISSION[field], ...same };
  if (failure.status === 404) return { errors: {}, error: CUSTOMER_GONE, ...same };
  if (field === 'paymentTerms' && failure.status === 422) {
    const why = fieldErrorOf(err, 'paymentTermId');
    if (why !== undefined) {
      reload();
      return { errors: { value: `${why}.` }, ...same };
    }
  }
  if (field === 'owner' && apiDetailOf(err, 'assignmentReason') === 'not_active_staff') {
    reload();
    return { errors: { value: OWNER_REFUSED }, ...same };
  }
  if (failure.status === 422) {
    return {
      errors: {},
      error: 'The platform did not accept this change. Check what you entered and try again.',
      ...same,
    };
  }
  return { errors: {}, error: failure.message, ...same };
}

/** The session and the customer id, or the state to hand back when either is missing or refused. */
async function start(
  form: FormData,
  field: TermsField,
  permission: Permission,
  same: { savedCount: number },
): Promise<{ session: Session; customerId: string } | { state: TermsEditState }> {
  const customerId = text(form, 'customerId');
  if (!isGuid(customerId)) return { state: { errors: {}, error: INCOMPLETE, ...same } };
  const session = await requireStaffSession(`/customers/${customerId}`);
  if (!hasGrant(await getGrants(session), permission)) {
    return { state: { errors: {}, error: NO_PERMISSION[field], ...same } };
  }
  return { session, customerId };
}

function done(customerId: string, saved: string, prev: TermsEditState): TermsEditState {
  revalidatePath(`/customers/${customerId}`);
  revalidatePath('/customers');
  return { errors: {}, saved, savedCount: prev.savedCount + 1 };
}

/** Change the account owner: PATCH /v1/customers/:id with the owner and the version only (all Management may send). */
export async function changeOwnerAction(
  prev: TermsEditState,
  form: FormData,
): Promise<TermsEditState> {
  const same = { savedCount: prev.savedCount };
  const begun = await start(form, 'owner', 'customers.owner.write', same);
  if ('state' in begun) return begun.state;
  const { session, customerId } = begun;

  const expectedVersion = versionOf(form, 'expectedVersion');
  if (expectedVersion === undefined || expectedVersion === 'bad') {
    return { errors: {}, error: INCOMPLETE, ...same };
  }
  const ownerUserId = text(form, 'ownerUserId');
  if (!isGuid(ownerUserId)) return { errors: { value: OWNER_REQUIRED }, ...same };
  if (ownerUserId === text(form, 'currentOwnerUserId')) {
    return { errors: {}, notice: NOTHING_CHANGED, ...same };
  }

  try {
    await updateCustomer(session, customerId, { ownerUserId, expectedVersion });
  } catch (err) {
    return refused(err, 'owner', customerId, same);
  }
  return done(customerId, 'The account owner was changed.', prev);
}

/** Set or clear the payment term with the acting entity (customer.write on the record). */
export async function setPaymentTermAction(
  prev: TermsEditState,
  form: FormData,
): Promise<TermsEditState> {
  const same = { savedCount: prev.savedCount };
  const begun = await start(form, 'paymentTerms', 'customer.write', same);
  if ('state' in begun) return begun.state;
  const { session, customerId } = begun;

  const expectedVersion = versionOf(form, 'expectedVersion');
  if (expectedVersion === 'bad') return { errors: {}, error: INCOMPLETE, ...same };
  const organizationId = text(form, 'organizationId');
  if (!isGuid(organizationId)) return { errors: {}, error: INCOMPLETE, ...same };
  const chosen = text(form, 'paymentTermId');
  if (chosen !== '' && !isGuid(chosen)) return { errors: {}, error: INCOMPLETE, ...same };
  if (chosen === text(form, 'currentPaymentTermId')) {
    return { errors: {}, notice: NOTHING_CHANGED, ...same };
  }

  try {
    await updateCustomerTerms(session, customerId, {
      organizationId,
      paymentTermId: chosen === '' ? null : chosen,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
  } catch (err) {
    return refused(err, 'paymentTerms', customerId, same);
  }
  return done(customerId, chosen === '' ? 'Payment terms cleared.' : 'Payment terms saved.', prev);
}

/** Set the credit limit with the acting entity, or remove it (`customers.credit_limit.write`). */
export async function setCreditLimitAction(
  prev: TermsEditState,
  form: FormData,
): Promise<TermsEditState> {
  const same = { savedCount: prev.savedCount };
  const begun = await start(form, 'creditLimit', 'customers.credit_limit.write', same);
  if ('state' in begun) return begun.state;
  const { session, customerId } = begun;

  const expectedVersion = versionOf(form, 'expectedVersion');
  if (expectedVersion === 'bad') return { errors: {}, error: INCOMPLETE, ...same };
  const organizationId = text(form, 'organizationId');
  if (!isGuid(organizationId)) return { errors: {}, error: INCOMPLETE, ...same };
  const parsed = parseCreditLimit(text(form, 'limitMode'), text(form, 'creditLimit'));
  if (!parsed.ok) return { errors: { value: parsed.error }, ...same };
  const current = text(form, 'currentCreditLimit');
  if (sameLimit(parsed.value, current === '' ? null : current)) {
    return { errors: {}, notice: NOTHING_CHANGED, ...same };
  }

  try {
    await updateCustomerTerms(session, customerId, {
      organizationId,
      creditLimit: parsed.value,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
  } catch (err) {
    return refused(err, 'creditLimit', customerId, same);
  }
  return done(
    customerId,
    parsed.value === null
      ? 'Credit limit removed. Orders are no longer held for credit.'
      : 'Credit limit saved.',
    prev,
  );
}
