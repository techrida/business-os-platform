import 'server-only';

import type { LeadOwnerOption } from '@bos/contracts';

import { hasPermission } from '@/components/p2/customers/permissions';
import { userNames } from '@/lib/business-labels';
import type { Session } from '@/lib/session';

import { listLeadOwners } from './crm-api';

export interface People {
  /** People the caller may assign a lead or follow-up to (`GET /v1/leads/owners`). */
  owners: LeadOwnerOption[];
  /** Names by user id: the users directory (administrators) plus the owners list on top. */
  names: Map<string, string>;
}

/**
 * Whether the owners list is worth asking for. It needs `crm.lead.write`; without it the API
 * answers 403, so pages outside Leads skip the call rather than fail it.
 */
export function canAssignFollowUps(session: Session): boolean {
  return hasPermission(session.roles, 'crm.lead.write');
}

/**
 * Owners and names, merged the way the lead list does. Neither half failing breaks the page: a
 * failure only leaves names out, and no internal id ever stands in for a name.
 */
export async function loadPeople(
  session: Session,
  { owners: askOwners = true }: { owners?: boolean | undefined } = {},
): Promise<People> {
  const [ownerList, directory] = await Promise.allSettled([
    askOwners ? listLeadOwners(session) : Promise.resolve([]),
    userNames(session),
  ]);
  const names = new Map(directory.status === 'fulfilled' ? directory.value : []);
  const owners = ownerList.status === 'fulfilled' ? ownerList.value : [];
  for (const o of owners) names.set(o.userId, o.displayName || o.email);
  return { owners, names };
}
