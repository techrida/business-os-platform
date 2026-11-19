import 'server-only';

import type { LeadOwnerOption } from '@bos/contracts';

import { hasPermission } from '@/components/p2/customers/permissions';
import type { Session } from '@/lib/session';

import { listLeadOwners } from './crm-api';

export interface People {
  /** People the caller may assign a lead or follow-up to (`GET /v1/leads/owners`). */
  owners: LeadOwnerOption[];
}

/**
 * Whether the owners list is worth asking for. It needs `crm.lead.write`; without it the API
 * answers 403, so pages outside Leads skip the call rather than fail it.
 */
export function canAssignFollowUps(session: Session): boolean {
  return hasPermission(session.roles, 'crm.lead.write');
}

/**
 * The people the caller may assign to. Names on a record come from the record itself (D46), so this is only the
 * choice list; a failure leaves the choices empty and breaks nothing.
 */
export async function loadPeople(
  session: Session,
  { owners: askOwners = true }: { owners?: boolean | undefined } = {},
): Promise<People> {
  const [ownerList] = await Promise.allSettled([
    askOwners ? listLeadOwners(session) : Promise.resolve([]),
  ]);
  return { owners: ownerList.status === 'fulfilled' ? ownerList.value : [] };
}
