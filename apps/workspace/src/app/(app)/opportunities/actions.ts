'use server';

import { runStageMove } from '@/components/p2/crm/action-helpers';
import type { MoveState } from '@/components/p2/crm/types';

/** Server action for opportunities. Won and Quotation Sent are refused here: the system sets them. */
export async function moveOpportunityStageAction(
  _prev: MoveState,
  form: FormData,
): Promise<MoveState> {
  return runStageMove('opportunity', form, '/opportunities');
}
