'use server';

import { OpportunityOwnerChangeBodySchema } from '@bos/contracts';
import { revalidatePath } from 'next/cache';

import { ApiError } from '@/lib/api';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';

import { assignmentRefusalText, runStageMove, UUID } from '@/components/p2/crm/action-helpers';
import { changeOpportunityOwner, getOpportunity } from '@/components/p2/crm/crm-api';
import type { OwnerChangeState } from '@/components/p2/crm/owner-field';
import type { MoveState } from '@/components/p2/crm/types';

/** Server action for opportunities. Won and Quotation Sent are refused here: the system sets them. */
export async function moveOpportunityStageAction(
  _prev: MoveState,
  form: FormData,
): Promise<MoveState> {
  return runStageMove('opportunity', form, '/opportunities');
}

const INCOMPLETE = 'This form is incomplete. Reload the page.';

/**
 * Hand a deal to another person (F1-Q51, `PATCH /v1/opportunities/:id/owner`) with the version the
 * page showed. The API applies the lead's assignment rule; its refusal code comes back as words for
 * the field. The owner's open follow-ups move with the deal. When the caller may no longer open the
 * deal afterwards (an own-scope hand-over), the answer says so, and the page goes back to the list.
 */
export async function updateOpportunityOwnerAction(
  _prev: OwnerChangeState,
  form: FormData,
): Promise<OwnerChangeState> {
  const idValue = form.get('opportunityId');
  const id = typeof idValue === 'string' ? idValue : '';
  if (!UUID.test(id)) return { error: INCOMPLETE, reload: true };
  const session = await requireStaffSession(`/opportunities/${id}`);

  const owner = form.get('ownerUserId');
  if (typeof owner !== 'string' || !UUID.test(owner)) {
    return { fieldErrors: { ownerUserId: 'Choose who owns this opportunity.' } };
  }
  const parsed = OpportunityOwnerChangeBodySchema.safeParse({
    ownerUserId: owner,
    expectedVersion: Number(form.get('expectedVersion')),
  });
  if (!parsed.success) return { error: INCOMPLETE, reload: true };

  try {
    await changeOpportunityOwner(session, id, parsed.data);
  } catch (err) {
    const refused = assignmentRefusalText(err);
    if (refused) return { fieldErrors: { ownerUserId: refused } };
    const f = failureOf(err);
    return { error: f.message, reload: f.reload };
  }

  revalidatePath('/opportunities');
  revalidatePath('/activities');
  try {
    await getOpportunity(session, id);
  } catch (err) {
    // Saved, but the deal is now outside what the caller may read.
    if (err instanceof ApiError && err.status === 404) return { ok: true, handedAway: true };
  }
  revalidatePath(`/opportunities/${id}`);
  return { ok: true };
}
