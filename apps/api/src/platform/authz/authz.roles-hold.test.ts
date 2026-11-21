// AuthzService.rolesHold: the optional exact scope and the member's level (R5 FU6). The cache is a stub: this is
// about how the answer is read from it, not about how it loads rows (role-cache.test.ts).
import 'reflect-metadata';

import type { AccessLevel, AccessScope, Permission, RoleKey } from '@bos/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/db.module';
import { AuthzService } from './authz.service';
import type { RoleCache } from './role-cache';

function serviceWith(grants: Partial<Record<AccessLevel, [Permission, AccessScope][]>>) {
  const grantsFor = vi.fn((_t: string, _o: string, _r: readonly RoleKey[], level: AccessLevel) =>
    Promise.resolve(new Map<Permission, AccessScope>(grants[level] ?? [])),
  );
  return { grantsFor, authz: new AuthzService({} as Db, { grantsFor } as unknown as RoleCache) };
}

describe('AuthzService.rolesHold', () => {
  const roles: RoleKey[] = ['pmo'];

  it('holds a permission at any scope by default, as before', async () => {
    const { authz } = serviceWith({ staff: [['verification.read', 'own']] });
    expect(await authz.rolesHold('t', 'o', roles, 'verification.read')).toBe(true);
    expect(await authz.rolesHold('t', 'o', roles, 'verification.review')).toBe(false);
  });

  it('asks for the exact scope when one is given', async () => {
    const { authz } = serviceWith({ staff: [['verification.read', 'own']] });
    expect(await authz.rolesHold('t', 'o', roles, 'verification.read', { scope: 'all' })).toBe(
      false,
    );
    expect(await authz.rolesHold('t', 'o', roles, 'verification.read', { scope: 'own' })).toBe(
      true,
    );
  });

  it('reads the grants at the member level, so a level that widens a grant counts', async () => {
    const { authz, grantsFor } = serviceWith({
      staff: [['verification.read', 'own']],
      manager: [['verification.read', 'all']],
    });
    expect(
      await authz.rolesHold('t', 'o', roles, 'verification.read', {
        scope: 'all',
        level: 'manager',
      }),
    ).toBe(true);
    expect(grantsFor).toHaveBeenLastCalledWith('t', 'o', roles, 'manager');
    expect(
      await authz.rolesHold('t', 'o', roles, 'verification.read', { scope: 'all', level: 'staff' }),
    ).toBe(false);
  });
});
