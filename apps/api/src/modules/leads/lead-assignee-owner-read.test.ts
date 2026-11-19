import type { Permission } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import type { RoleCache } from '../../platform/authz/role-cache';
import { partyHolds, type AssignmentCandidate } from './lead-assignee';

const scope = { tenantId: 't', organizationId: 'o' };
const party = {
  userId: 'u',
  roleKeys: ['sales'],
  level: 'staff',
} as unknown as AssignmentCandidate;

const cacheWith = (scope: string | undefined) =>
  ({
    grantsFor: () =>
      Promise.resolve(
        new Map<Permission, string>(scope === undefined ? [] : [['crm.lead.read', scope]]),
      ),
  }) as unknown as RoleCache;

describe('partyHolds for an owner', () => {
  it('refuses a read that only reaches records with a follow-up on them, since the owned lead would vanish', async () => {
    const cache = cacheWith('assigned');
    expect(await partyHolds(cache, scope, party, 'crm.lead.read', true)).toBe(false);
    // An assignee needs no more than that read: the assignment itself hands them the record.
    expect(await partyHolds(cache, scope, party, 'crm.lead.read')).toBe(true);
  });

  it.each(['own', 'department', 'all'])('accepts %s for an owner', async (reach) => {
    expect(await partyHolds(cacheWith(reach), scope, party, 'crm.lead.read', true)).toBe(true);
  });

  it('refuses a role with no read at all', async () => {
    expect(await partyHolds(cacheWith(undefined), scope, party, 'crm.lead.read', true)).toBe(false);
  });
});
