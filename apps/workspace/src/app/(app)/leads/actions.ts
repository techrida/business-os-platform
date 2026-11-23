'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { ApiError } from '@/lib/api';
import { apiCodeOf } from '@/lib/api-code';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { currencyNotEnabledText } from '@/lib/kernel-ui';
import type { Session } from '@/lib/session';

import {
  assignmentRefusalText,
  echo,
  IDEMPOTENCY_KEY,
  runStageMove,
  UUID,
} from '@/components/p2/crm/action-helpers';
import {
  cancelActivity,
  completeActivity,
  convertLead,
  createActivity,
  createLead,
  rescheduleActivity,
  updateLead,
} from '@/components/p2/crm/crm-api';
import { duplicatesFrom } from '@/components/p2/crm/duplicates';
import {
  followUpPaths,
  isFollowUpSubjectKind,
  type FollowUpSubject,
} from '@/components/p2/crm/follow-up-subject';
import {
  parseCancelActivity,
  parseCompleteActivity,
  parseConvert,
  parseLead,
  parseLeadAddress,
  parseLeadUpdate,
  parseRescheduleActivity,
  parseScheduleFollowUp,
  type FieldErrors,
  type Parsed,
} from '@/components/p2/crm/forms';
import { keyOf, nextKey } from '@/components/p2/crm/idempotency';
import type { ConvertState, FormState, MoveState } from '@/components/p2/crm/types';

/**
 * Server actions for leads. Each asks `requireStaffSession` first, so an expired session goes to
 * sign-in and comes back; each validates on the server (the browser's checks are a courtesy).
 */

export async function moveLeadStageAction(_prev: MoveState, form: FormData): Promise<MoveState> {
  return runStageMove('lead', form, '/leads');
}

export async function createLeadAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireStaffSession('/leads/new');
  const values = echo(form);
  const key = keyOf(form);
  const parsed = parseLead(form);
  if (!parsed.ok) return { values, fieldErrors: parsed.fieldErrors, key };

  let id: string;
  try {
    id = (await createLead(session, parsed.data, key)).id;
  } catch (err) {
    // A currency switched off for the company (D44) gets its own words; the rest the kernel's.
    const error = currencyNotEnabledText(err) ?? failureOf(err).message;
    return { values, fieldErrors: {}, error, key: nextKey(err, key) };
  }
  revalidatePath('/leads');
  redirect(`/leads/${id}`);
}

export async function convertLeadAction(
  _prev: ConvertState,
  form: FormData,
): Promise<ConvertState> {
  const idValue = form.get('leadId');
  const leadId = typeof idValue === 'string' ? idValue : '';
  const values = echo(form);
  if (!UUID.test(leadId)) {
    return {
      values,
      fieldErrors: {},
      error: 'This form is incomplete. Reload the page.',
      reload: true,
    };
  }
  const session = await requireStaffSession(`/leads/${leadId}`);

  const parsed = parseConvert(form);
  if (!parsed.ok) return { values, fieldErrors: parsed.fieldErrors };

  const keyValue = form.get('idempotencyKey');
  const key =
    typeof keyValue === 'string' && IDEMPOTENCY_KEY.test(keyValue) ? keyValue : randomUUID();

  let opportunityId: string;
  try {
    opportunityId = (await convertLead(session, leadId, parsed.data, key)).opportunityId;
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const duplicates = duplicatesFrom(err.body);
      if (duplicates !== null) return { values, fieldErrors: {}, duplicates, definite: true };
    }
    if (
      err instanceof ApiError &&
      err.status === 422 &&
      apiCodeOf(err) === 'contact_email_required'
    ) {
      return {
        values,
        fieldErrors: {
          contactId:
            'This contact has no email, so quotations could not be sent to it. Choose another, or create one from the lead.',
        },
        definite: true,
      };
    }
    const f = failureOf(err);
    return { values, fieldErrors: {}, error: f.message, definite: f.definite, reload: f.reload };
  }
  revalidatePath('/leads');
  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/opportunities');
  redirect(`/opportunities/${opportunityId}`);
}

// ---------------------------------------------------------------------------------------------
// Follow-ups (D39): planned calls, meetings and emails on a lead
// ---------------------------------------------------------------------------------------------

const INCOMPLETE = 'This form is incomplete. Reload the page.';

/** What a follow-up change (complete, reschedule, cancel) hands back to its control. */
export interface FollowUpState {
  ok?: boolean;
  error?: string;
  fieldErrors?: FieldErrors;
  /** The follow-up changed underneath the page (stale version, already done): reloading fixes it. */
  reload?: boolean;
}

/**
 * Schedule a follow-up on a lead or an opportunity (U16-Q6). The dialog posts `subjectKind`
 * (`leadId` or `opportunityId`) and `subjectId`; any other subject is refused here. The key
 * handling matches `logActivityAction`: the same key after an unknown outcome, a new one after a
 * save or a refusal.
 */
export async function scheduleFollowUpAction(_prev: FormState, form: FormData): Promise<FormState> {
  const kind = form.get('subjectKind');
  const id = form.get('subjectId');
  const values = echo(form);
  const key = keyOf(form);
  if ((kind !== 'leadId' && kind !== 'opportunityId') || typeof id !== 'string' || !UUID.test(id)) {
    return { values, fieldErrors: {}, error: INCOMPLETE, key };
  }
  const paths = followUpPaths({ kind, id });
  const session = await requireStaffSession(paths[0] ?? '/activities');

  const parsed = parseScheduleFollowUp(form);
  if (!parsed.ok) {
    const { form: formError, ...fieldErrors } = parsed.fieldErrors;
    return { values, fieldErrors, ...(formError ? { error: formError } : {}), key };
  }
  try {
    await createActivity(session, parsed.data, key);
  } catch (err) {
    return { values, fieldErrors: {}, error: failureOf(err).message, key: nextKey(err, key) };
  }
  for (const path of paths) revalidatePath(path);
  return { values: {}, fieldErrors: {}, ok: true, key: randomUUID() };
}

/**
 * The record a follow-up change refreshes, from `subjectKind` + `subjectId` (or the older `leadId`
 * field). `null` when the form names none (only `/activities` is refreshed); `false` when it names
 * one that is not a known kind and an id, which means the form was tampered with or is stale.
 */
function changedSubject(form: FormData): FollowUpSubject | null | false {
  const kind = form.get('subjectKind');
  const id = form.get('subjectId');
  if ((kind !== null && kind !== '') || (id !== null && id !== '')) {
    return isFollowUpSubjectKind(kind) && typeof id === 'string' && UUID.test(id)
      ? { kind, id }
      : false;
  }
  const leadId = form.get('leadId');
  if (leadId === null || leadId === '') return null;
  return typeof leadId === 'string' && UUID.test(leadId) ? { kind: 'leadId', id: leadId } : false;
}

/**
 * The shared body of complete, reschedule and cancel: check the activity id, the subject and the
 * session, parse, call, revalidate. Any subject works (a lead, an opportunity, a migrated task on a
 * customer); the pages refreshed are built here from its kind and id, never from a client path. A
 * bad `expectedVersion` is not something the person can fix in a field, so it comes back as the
 * reload message instead of a field error.
 */
async function changeFollowUp<T>(
  form: FormData,
  parse: (form: FormData) => Parsed<T>,
  send: (session: Session, id: string, body: T) => Promise<unknown>,
): Promise<FollowUpState> {
  const activityValue = form.get('activityId');
  const activityId = typeof activityValue === 'string' ? activityValue : '';
  const subject = changedSubject(form);
  if (!UUID.test(activityId) || subject === false) return { error: INCOMPLETE, reload: true };
  const paths = followUpPaths(subject);
  const session = await requireStaffSession(paths[0] ?? '/activities');

  const parsed = parse(form);
  if (!parsed.ok) {
    const { expectedVersion, ...fieldErrors } = parsed.fieldErrors;
    if (expectedVersion) return { error: expectedVersion, reload: true };
    return { fieldErrors };
  }
  try {
    await send(session, activityId, parsed.data);
  } catch (err) {
    const f = failureOf(err);
    return { error: f.message, reload: f.reload };
  }
  for (const path of paths) revalidatePath(path);
  return { ok: true };
}

/** Mark a planned follow-up done. It leaves the Follow-ups card and shows in History. */
export async function completeFollowUpAction(
  _prev: FollowUpState,
  form: FormData,
): Promise<FollowUpState> {
  return changeFollowUp(form, parseCompleteActivity, completeActivity);
}

/** Move a planned follow-up to a new time, optionally to another person. */
export async function rescheduleFollowUpAction(
  _prev: FollowUpState,
  form: FormData,
): Promise<FollowUpState> {
  return changeFollowUp(form, parseRescheduleActivity, rescheduleActivity);
}

/** Drop a planned follow-up. It shows nowhere afterwards (neither planned nor History). */
export async function cancelFollowUpAction(
  _prev: FollowUpState,
  form: FormData,
): Promise<FollowUpState> {
  return changeFollowUp(form, parseCancelActivity, cancelActivity);
}

// ---------------------------------------------------------------------------------------------
// Lead owner (D38)
// ---------------------------------------------------------------------------------------------

/** What the owner control gets back. `reload` means the lead changed underneath the page. */
export type LeadOwnerState = FollowUpState;

/**
 * Hand the lead to another person (`PATCH /v1/leads/:id` with only `ownerUserId` and the version
 * the page showed). The API applies the create-time rule, so a refusal (403) comes back as words
 * for the form; a stale version (409) comes back as the reload message.
 */
export async function updateLeadOwnerAction(
  _prev: LeadOwnerState,
  form: FormData,
): Promise<LeadOwnerState> {
  const leadValue = form.get('leadId');
  const leadId = typeof leadValue === 'string' ? leadValue : '';
  if (!UUID.test(leadId)) return { error: INCOMPLETE, reload: true };
  const session = await requireStaffSession(`/leads/${leadId}`);

  const parsed = parseLeadUpdate(form);
  if (!parsed.ok) {
    // A bad version is not something the person can fix in the field: it asks for a reload.
    const { ownerUserId, expectedVersion } = parsed.fieldErrors;
    if (expectedVersion) return { error: expectedVersion, reload: true };
    return { fieldErrors: { ownerUserId: ownerUserId ?? 'Choose who owns this lead.' } };
  }
  try {
    await updateLead(session, leadId, parsed.data);
  } catch (err) {
    const refused = assignmentRefusalText(err);
    if (refused) return { fieldErrors: { ownerUserId: refused } };
    const f = failureOf(err);
    return { error: f.message, reload: f.reload };
  }
  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/leads');
  return { ok: true };
}

/**
 * Change the lead's optional address (`PATCH /v1/leads/:id` with `address`, `null` to clear it, and the version the
 * page showed). Half an address comes back under the field it lacks; a stale version (409) as the reload message.
 */
export async function updateLeadAddressAction(
  _prev: LeadContactState,
  form: FormData,
): Promise<LeadContactState> {
  const leadValue = form.get('leadId');
  const leadId = typeof leadValue === 'string' ? leadValue : '';
  if (!UUID.test(leadId)) return { error: INCOMPLETE, reload: true };
  const session = await requireStaffSession(`/leads/${leadId}`);
  const parsed = parseLeadAddress(form);
  if (!parsed.ok) {
    const { expectedVersion, ...fieldErrors } = parsed.fieldErrors;
    if (expectedVersion) return { error: expectedVersion, reload: true };
    return { fieldErrors };
  }
  try {
    await updateLead(session, leadId, parsed.data);
  } catch (err) {
    const f = failureOf(err);
    return { error: f.message, reload: f.reload };
  }
  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/leads');
  return { ok: true };
}

/** What the country and phones editor gets back. `reload` means the lead changed underneath the page. */
export type LeadContactState = FollowUpState;

/**
 * Change the lead person's country and numbers (`PATCH /v1/leads/:id` with `country` and/or the
 * whole `phones` list, whichever the editor posted, and the version the page showed). A number the
 * contract refuses comes back under its row; the server's own refusal (a lead left with neither an
 * email nor a phone is a 400) comes back in its words; a stale version (409) as the reload message.
 */
export async function updateLeadContactAction(
  _prev: LeadContactState,
  form: FormData,
): Promise<LeadContactState> {
  const leadValue = form.get('leadId');
  const leadId = typeof leadValue === 'string' ? leadValue : '';
  if (!UUID.test(leadId)) return { error: INCOMPLETE, reload: true };
  const session = await requireStaffSession(`/leads/${leadId}`);

  // The owner has its own editor and action; this one never hands the lead over.
  form.delete('ownerUserId');
  const parsed = parseLeadUpdate(form);
  if (!parsed.ok) {
    const { expectedVersion, ownerUserId: nothingPosted, ...fieldErrors } = parsed.fieldErrors;
    if (expectedVersion) return { error: expectedVersion, reload: true };
    if (nothingPosted) return { error: 'Change the country or a phone number first.' };
    return { fieldErrors };
  }
  try {
    await updateLead(session, leadId, parsed.data);
  } catch (err) {
    const f = failureOf(err);
    return { error: f.message, reload: f.reload };
  }
  revalidatePath(`/leads/${leadId}`);
  revalidatePath('/leads');
  return { ok: true };
}
