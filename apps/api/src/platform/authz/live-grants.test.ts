// Unit tests for the live-grant check (U20b-Q3): roles come from the user mirror, not the token,
// are narrowed by the acting entity's membership, and only an active user holding the permission
// passes. The real SQL store and role cache are covered by access-settings.integration.test.ts.
import type { AccessLevel, AccessScope, Permission, RoleKey } from '@bos/contracts';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { DbTransaction } from '../db/db.module';
import type { Actor, TxScope } from '../db/tx';
import type { MembershipRow, UserRow } from '../users/users.store';
import { type LiveGrantDeps, assertLiveGrant, liveGrantsOf } from './live-grants';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ENTITY = '10000000-0000-4000-8000-00000000000a';
const OTHER_ENTITY = '10000000-0000-4000-8000-000000000002';
const DEPT = '40000000-0000-4000-8000-000000000001';
const ME = 'a0000000-0000-4000-8000-000000000001';
const SCOPE: TxScope = { tenantId: TENANT, organizationId: ENTITY };
const TX = {} as DbTransaction;

const userActor: Actor = { kind: 'user', id: ME, correlationId: 'test' };

interface World {
  status?: UserRow['status'] | null;
  roles?: RoleKey[];
  memberships?: MembershipRow[];
}

function membership(over: Partial<MembershipRow> = {}): MembershipRow {
  return {
    organizationId: ENTITY,
    isDefault: true,
    roleKeys: null,
    departmentId: null,
    level: 'staff',
    ...over,
  };
}

/** Founder grants admin.roles.write; sales grants a read only. Records each grantsFor call. */
function deps(
  world: World,
): LiveGrantDeps & { calls: { roles: RoleKey[]; level?: AccessLevel }[] } {
  const calls: { roles: RoleKey[]; level?: AccessLevel }[] = [];
  const status = world.status === undefined ? 'active' : world.status;
  return {
    calls,
    users: {
      findById: (_q, scope, userId) =>
        Promise.resolve(
          status === null || scope.tenantId !== TENANT || userId !== ME
            ? null
            : {
                id: ME,
                tenantId: TENANT,
                idpOrgId: 'idp',
                zitadelUserId: 'z',
                email: null,
                displayName: null,
                status,
              },
        ),
      rolesOf: () => Promise.resolve(world.roles ?? ['founder']),
      membershipsOf: () => Promise.resolve(world.memberships ?? [membership()]),
    },
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

async function denial(p: Promise<unknown>): Promise<Record<string, unknown>> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ForbiddenException);
  return (caught as ForbiddenException).getResponse() as Record<string, unknown>;
}

describe('assertLiveGrant', () => {
  it('passes an active Founder whose mirror roles still hold the permission', async () => {
    const live = await assertLiveGrant(TX, deps({}), SCOPE, userActor, 'admin.roles.write');
    expect(live.roles).toEqual(['founder']);
    expect(live.grants.get('admin.roles.write')).toBe('all');
  });

  it('refuses a former Founder: the mirror no longer lists the role, whatever the token said', async () => {
    const body = await denial(
      assertLiveGrant(TX, deps({ roles: ['sales'] }), SCOPE, userActor, 'admin.roles.write'),
    );
    expect(body).toMatchObject({ code: 'forbidden', reason: 'no_permission' });
  });

  it('refuses when the membership narrows the Founder role away in this entity', async () => {
    const d = deps({
      roles: ['founder', 'sales'],
      memberships: [membership({ roleKeys: ['sales'] })],
    });
    await denial(assertLiveGrant(TX, d, SCOPE, userActor, 'admin.roles.write'));
    expect(d.calls).toEqual([{ roles: ['sales'], level: 'staff' }]);
  });

  it('refuses a Founder with no membership in the acting entity, without reading grants', async () => {
    const d = deps({ memberships: [membership({ organizationId: OTHER_ENTITY })] });
    await denial(assertLiveGrant(TX, d, SCOPE, userActor, 'admin.roles.write'));
    expect(d.calls).toEqual([]);
  });

  it('matches the entity id case-insensitively, like the tenancy interceptor', async () => {
    const d = deps({ memberships: [membership({ organizationId: ENTITY.toUpperCase() })] });
    await expect(
      assertLiveGrant(TX, d, SCOPE, userActor, 'admin.roles.write'),
    ).resolves.toMatchObject({ roles: ['founder'] });
  });

  it('refuses an inactive user who still holds the role', async () => {
    const body = await denial(
      assertLiveGrant(TX, deps({ status: 'inactive' }), SCOPE, userActor, 'admin.roles.write'),
    );
    expect(body).toMatchObject({ reason: 'inactive_user' });
  });

  it('refuses a user missing from this tenant (another tenant, or deleted)', async () => {
    const body = await denial(
      assertLiveGrant(
        TX,
        deps({}),
        { tenantId: '00000000-0000-4000-8000-000000000002', organizationId: ENTITY },
        userActor,
        'admin.roles.write',
      ),
    );
    expect(body).toMatchObject({ reason: 'no_permission' });
  });

  it('refuses a non-user actor', async () => {
    await denial(
      assertLiveGrant(
        TX,
        deps({}),
        SCOPE,
        { kind: 'system', id: 'job', correlationId: 'c' },
        'admin.roles.write',
      ),
    );
  });
});

describe('liveGrantsOf', () => {
  it('asks for the membership level only when the member has a department', async () => {
    const withDept = deps({ memberships: [membership({ departmentId: DEPT, level: 'head' })] });
    const a = await liveGrantsOf(TX, withDept, SCOPE, ME);
    expect(a).toMatchObject({ departmentId: DEPT, level: 'head' });
    expect(withDept.calls).toEqual([{ roles: ['founder'], level: 'head' }]);

    const noDept = deps({ memberships: [membership({ departmentId: null, level: 'head' })] });
    await liveGrantsOf(TX, noDept, SCOPE, ME);
    expect(noDept.calls).toEqual([{ roles: ['founder'], level: 'staff' }]);
  });
});
