// Unit tests for the small-team rule helper (F1-Q11 a): who else could do a step, and whether the caller is the
// sole eligible person. The candidate source and the role table are fakes; the SQL source is not exercised here.
import type { AccessLevel, AccessScope, Permission, RoleKey } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import type { DbTransaction } from '../db/db.module';
import type { TxScope } from '../db/tx';
import {
  type EligibilityCandidate,
  type SoleEligibleDeps,
  isSoleEligible,
  otherEligibleUsers,
} from './sole-eligible';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ENTITY = '10000000-0000-4000-8000-00000000000a';
const ME = 'a0000000-0000-4000-8000-000000000001';
const TWO = 'a0000000-0000-4000-8000-000000000002';
const THREE = 'a0000000-0000-4000-8000-000000000003';
const SCOPE: TxScope = { tenantId: TENANT, organizationId: ENTITY };
const TX = {} as DbTransaction;
const PERMISSION: Permission = 'admin.roles.write';

function candidate(userId: string, over: Partial<EligibilityCandidate> = {}): EligibilityCandidate {
  return {
    userId,
    status: 'active',
    lockReason: null,
    roles: ['founder'],
    membership: { roleKeys: null },
    ...over,
  };
}

/** Founder grants the permission; sales grants a read only. Records each grantsFor call. */
function deps(
  candidates: EligibilityCandidate[],
): SoleEligibleDeps & { calls: { roles: RoleKey[]; level?: AccessLevel }[] } {
  const calls: { roles: RoleKey[]; level?: AccessLevel }[] = [];
  return {
    calls,
    candidates: { candidates: () => Promise.resolve(candidates) },
    grants: {
      grantsFor: (_tenant, _org, roles, level) => {
        calls.push(level === undefined ? { roles: [...roles] } : { roles: [...roles], level });
        const out = new Map<Permission, AccessScope>();
        if (roles.includes('founder')) out.set('admin.roles.write', 'all');
        if (roles.includes('sales')) out.set('admin.roles.read', 'all');
        return Promise.resolve(out);
      },
    },
  };
}

const others = (
  candidates: EligibilityCandidate[],
  opts: Partial<Parameters<typeof otherEligibleUsers>[4]> = {},
): Promise<string[]> =>
  otherEligibleUsers(TX, deps(candidates), SCOPE, PERMISSION, {
    excludeUserIds: [ME],
    entityScoped: true,
    ...opts,
  });

describe('otherEligibleUsers and isSoleEligible', () => {
  it('a Founder with nobody else in the tenant is the sole eligible person', async () => {
    const found = await others([candidate(ME)]);
    expect(found).toEqual([]);
    expect(isSoleEligible(['founder'], found)).toBe(true);
  });

  it('a second active user who holds the grant means the Founder is not sole', async () => {
    const found = await others([candidate(ME), candidate(TWO)]);
    expect(found).toEqual([TWO]);
    expect(isSoleEligible(['founder'], found)).toBe(false);
  });

  it('an admin-locked, deactivated or invited second user does not count', async () => {
    const found = await others([
      candidate(ME),
      candidate(TWO, { status: 'inactive', lockReason: 'admin' }),
      candidate(THREE, { status: 'invited' }),
    ]);
    expect(found).toEqual([]);
    expect(isSoleEligible(['founder'], found)).toBe(true);
    // A deactivated user: inactive with no lock.
    expect(await others([candidate(TWO, { status: 'inactive' })])).toEqual([]);
    // An admin lock read on a row whose status still says active also excludes it.
    expect(await others([candidate(TWO, { lockReason: 'admin' })])).toEqual([]);
  });

  it('a second user locked out only after failed sign-ins still counts, so the Founder is not sole', async () => {
    const found = await others([
      candidate(ME),
      candidate(TWO, { status: 'inactive', lockReason: 'failed_sign_ins' }),
    ]);
    expect(found).toEqual([TWO]);
    expect(isSoleEligible(['founder'], found)).toBe(false);
    // The same lock read on a row whose status still says active.
    expect(await others([candidate(TWO, { lockReason: 'failed_sign_ins' })])).toEqual([TWO]);
    // An invited user never finished signing up, so a lock does not make them present.
    expect(
      await others([candidate(TWO, { status: 'invited', lockReason: 'failed_sign_ins' })]),
    ).toEqual([]);
  });

  it('a second user whose roles do not grant the permission does not count', async () => {
    const found = await others([candidate(ME), candidate(TWO, { roles: ['sales'] })]);
    expect(found).toEqual([]);
    expect(isSoleEligible(['founder'], found)).toBe(true);
  });

  it('a second user whose membership narrows the granting role away does not count', async () => {
    const found = await others([
      candidate(TWO, { roles: ['founder', 'sales'], membership: { roleKeys: ['sales'] } }),
    ]);
    expect(found).toEqual([]);
  });

  it('a second user failing roleOk does not count', async () => {
    const found = await others([candidate(ME), candidate(TWO)], {
      roleOk: (roles) => !roles.includes('founder'),
    });
    expect(found).toEqual([]);
    expect(isSoleEligible(['founder'], found)).toBe(true);
  });

  it('ignores every excluded id, case-insensitively', async () => {
    const found = await others([candidate(ME), candidate(TWO), candidate(THREE)], {
      excludeUserIds: [ME, TWO.toUpperCase()],
    });
    expect(found).toEqual([THREE]);
  });

  it('a non-Founder never qualifies, even with nobody else', () => {
    expect(isSoleEligible(['sales'], [])).toBe(false);
    expect(isSoleEligible([], [])).toBe(false);
  });

  it('when entity-scoped, a user with no membership in the entity does not count', async () => {
    const found = await others([candidate(ME), candidate(TWO, { membership: null })]);
    expect(found).toEqual([]);
    expect(isSoleEligible(['founder'], found)).toBe(true);
  });

  it('when tenant-wide, membership is not required and roles are not narrowed', async () => {
    const found = await others(
      [
        candidate(TWO, { membership: null }),
        candidate(THREE, { roles: ['founder', 'sales'], membership: { roleKeys: ['sales'] } }),
      ],
      { entityScoped: false },
    );
    expect(found).toEqual([TWO, THREE]);
  });

  it('reads the role table once per distinct role set, at the base level', async () => {
    const d = deps([
      candidate(TWO),
      candidate(THREE),
      candidate('a0000000-0000-4000-8000-000000000004', { roles: ['sales'] }),
    ]);
    await otherEligibleUsers(TX, d, SCOPE, PERMISSION, { excludeUserIds: [], entityScoped: true });
    expect(d.calls).toEqual([
      { roles: ['founder'], level: 'staff' },
      { roles: ['sales'], level: 'staff' },
    ]);
  });
});
