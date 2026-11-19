'use server';

import { LEAD_LOST_REASON_LABEL_MAX } from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { movedOrder } from '@/components/settings/lost-reasons/lost-reasons-model';
import { ApiError } from '@/lib/api';
import {
  createLeadLostReason,
  listLeadLostReasons,
  reorderLeadLostReasons,
  resetLeadLostReasons,
  updateLeadLostReason,
} from '@/lib/api-lead-lost-reasons';

import { fail, ok, type ActionState } from '../action-state';
import { describeError } from '../admin-errors';
import { requireSection } from '../guard';

// Server Actions of the Lost reasons card (Settings > Sales, D49). Each is its own request, so the section permission
// is asked again here, apart from the page that rendered the list; the API still enforces admin.settings.write.

const PATH = '/settings/sales';
const Id = z.guid();
const Label = z.string().trim().min(1).max(LEAD_LOST_REASON_LABEL_MAX);
const Version = z.number().int().min(1);

const GONE = 'That reason was removed by someone else. The list is up to date now.';
const STALE = 'Someone else changed this reason. The list is up to date now; try again.';
const BAD_LABEL = `Enter a name for the reason, up to ${LEAD_LOST_REASON_LABEL_MAX} characters.`;

/**
 * A 404 or a 409 refreshes the list so the person sees what the server holds. A 409 for a label already on the list
 * keeps the API's own sentence (it names the clash); any other 409 is a stale version.
 */
function refused(error: unknown): ActionState {
  if (error instanceof ApiError && error.status === 404) {
    revalidatePath(PATH);
    return fail(GONE);
  }
  if (error instanceof ApiError && error.status === 409) {
    revalidatePath(PATH);
    const message = describeError(error, 'change lost reasons');
    return fail(/already on the list/.test(message) ? message : STALE);
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
  return ok(retired ? 'Reason retired. Leads that used it keep it.' : 'Reason restored.');
}

/** Moves one reason a place up or down. The new order is computed from the list as the server holds it now. */
export async function moveLostReasonAction(
  id: string,
  direction: 'up' | 'down',
): Promise<ActionState> {
  const session = await requireSection('sales');
  if (!Id.safeParse(id).success) return fail(GONE);
  try {
    const current = await listLeadLostReasons(session);
    if (!current.some((r) => r.id === id)) {
      revalidatePath(PATH);
      return fail(GONE);
    }
    await reorderLeadLostReasons(session, { ids: movedOrder(current, id, direction) });
  } catch (error) {
    return refused(error);
  }
  revalidatePath(PATH);
  return ok('Order saved.');
}

export async function resetLostReasonsAction(): Promise<ActionState> {
  const session = await requireSection('sales');
  try {
    await resetLeadLostReasons(session);
  } catch (error) {
    return refused(error);
  }
  revalidatePath(PATH);
  return ok('Lost reasons are back to the defaults.');
}
