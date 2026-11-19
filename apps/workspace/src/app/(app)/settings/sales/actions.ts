'use server';

import {
  LEAD_LOST_REASON_LABEL_MAX,
  LOST_REASONS_STALE_MESSAGE,
  ReorderLeadLostReasonsBodySchema,
  ResetLeadLostReasonsBodySchema,
} from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ApiError } from '@/lib/api';
import {
  createLeadLostReason,
  reorderLeadLostReasons,
  resetLeadLostReasons,
  updateLeadLostReason,
} from '@/lib/api-lead-lost-reasons';

import { fail, ok, type ActionState } from '../action-state';
import { describeError } from '../admin-errors';
import { requireSection } from '../guard';

// Server Actions of the Lost reasons card (Settings > Sales, D49, D54-3, D54-4). Each is its own
// request, so the section permission is asked again here, apart from the page that rendered the
// list; the API still enforces admin.settings.write.

const PATH = '/settings/sales';
const Id = z.guid();
const Label = z.string().trim().min(1).max(LEAD_LOST_REASON_LABEL_MAX);
const Version = z.number().int().min(1);

const GONE = 'That reason was removed by someone else. The list is up to date now.';
const STALE = 'Someone else changed this reason. The list is up to date now; try again.';
const BAD_LABEL = `Enter a name for the reason, up to ${LEAD_LOST_REASON_LABEL_MAX} characters.`;

/**
 * A 404 or a 409 refreshes the list so the person sees what the server holds. A 409 for a stale
 * list (`LOST_REASONS_STALE_MESSAGE`) or a label already on the list keeps the API's own sentence;
 * any other 409 is a stale version on one reason.
 */
function refused(error: unknown): ActionState {
  if (error instanceof ApiError && error.status === 404) {
    revalidatePath(PATH);
    return fail(GONE);
  }
  if (error instanceof ApiError && error.status === 409) {
    revalidatePath(PATH);
    const message = describeError(error, 'change lost reasons');
    if (message === LOST_REASONS_STALE_MESSAGE || /already on the list/.test(message)) {
      return fail(message);
    }
    return fail(STALE);
  }
  return fail(describeError(error, 'change lost reasons'));
}

export async function addLostReasonAction(label: string): Promise<ActionState> {
  const session = await requireSection('sales');
  const parsed = Label.safeParse(label);
  if (!parsed.success) return fail(BAD_LABEL);
  try {
    await createLeadLostReason(session, { label: parsed.data });
  } catch (error) {
    return refused(error);
  }
  revalidatePath(PATH);
  return ok('Reason added.');
}

export async function renameLostReasonAction(
  id: string,
  label: string,
  expectedVersion: number,
): Promise<ActionState> {
  const session = await requireSection('sales');
  if (!Id.safeParse(id).success || !Version.safeParse(expectedVersion).success) return fail(GONE);
  const parsed = Label.safeParse(label);
  if (!parsed.success) return fail(BAD_LABEL);
  try {
    await updateLeadLostReason(session, id, { label: parsed.data, expectedVersion });
  } catch (error) {
    return refused(error);
  }
  revalidatePath(PATH);
  return ok('Reason renamed.');
}

export async function setLostReasonRetiredAction(
  id: string,
  retired: boolean,
  expectedVersion: number,
): Promise<ActionState> {
  const session = await requireSection('sales');
  if (!Id.safeParse(id).success || !Version.safeParse(expectedVersion).success) return fail(GONE);
  try {
    await updateLeadLostReason(session, id, { retired, expectedVersion });
  } catch (error) {
    return refused(error);
  }
  revalidatePath(PATH);
  return ok(
    retired ? 'Reason retired. Leads and opportunities that used it keep it.' : 'Reason restored.',
  );
}

/** Saves the displayed list in a new order, only while it still matches `expectedOrder` (D54-4). */
export async function reorderLostReasonsAction(
  ids: string[],
  expectedOrder: string,
): Promise<ActionState> {
  const session = await requireSection('sales');
  const parsed = ReorderLeadLostReasonsBodySchema.safeParse({ ids, expectedOrder });
  if (!parsed.success) return fail(LOST_REASONS_STALE_MESSAGE);
  try {
    await reorderLeadLostReasons(session, parsed.data);
  } catch (error) {
    return refused(error);
  }
  revalidatePath(PATH);
  return ok('Order saved.');
}

/** Resets the list to the defaults, only while it still matches `expectedOrder` (D54-4). */
export async function resetLostReasonsAction(expectedOrder: string): Promise<ActionState> {
  const session = await requireSection('sales');
  const parsed = ResetLeadLostReasonsBodySchema.safeParse({ expectedOrder });
  if (!parsed.success) return fail(LOST_REASONS_STALE_MESSAGE);
  try {
    await resetLeadLostReasons(session, parsed.data);
  } catch (error) {
    return refused(error);
  }
  revalidatePath(PATH);
  return ok('Lost reasons are back to the defaults.');
}
