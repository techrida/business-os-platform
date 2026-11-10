// Unit tests of the cost centres lookup's caller check: only an active staff user may read the list, and the
// database is never touched for anyone else. The rows, order and entity scope are in cost-centers.integration.test.ts.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/requests/cost-centers.service.test.ts
import 'reflect-metadata';

import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import { CostCentersService } from './cost-centers.service';

const scope = { tenantId: 'tenant-1', organizationId: 'org-1' };

const principalOf = (over: Partial<Principal>): Principal => ({
  userId: 'user-1',
  zitadelUserId: 'z-user-1',
  ...scope,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: 'idp-1',
  roles: [],
  departmentId: null,
  status: 'active',
  grants: new Map(),
  ...over,
});

/** A db whose select() records that it was used and returns the given rows. */
function setup(
  principal: Principal,
  rows: { id: string; code: string; name: string; active: boolean }[] = [],
) {
  const orderBy = vi.fn(() => Promise.resolve(rows));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const caller = {
    current: () => ({
      scope,
      actor: { kind: 'user' as const, id: principal.userId, correlationId: 'c' },
      principal,
    }),
  };
  const db = { select } as unknown as Db;
  const service = new CostCentersService(db, caller, new AuditService(db));
  return { service, select };
}

describe('CostCentersService.list caller check', () => {
  it('answers 403 for a portal user and never reads the table', async () => {
    const { service, select } = setup(principalOf({ orgKind: 'vendor', partyId: 'party-1' }));
    await expect(service.list()).rejects.toBeInstanceOf(ForbiddenException);
    expect(select).not.toHaveBeenCalled();
  });

  it('answers 403 for a customer portal user too', async () => {
    const { service, select } = setup(principalOf({ orgKind: 'customer', partyId: 'party-2' }));
    await expect(service.list()).rejects.toBeInstanceOf(ForbiddenException);
    expect(select).not.toHaveBeenCalled();
  });

  it.each(['invited', 'inactive'] as const)('answers 403 for a %s staff user', async (status) => {
    const { service, select } = setup(principalOf({ status }));
    const error = await service.list().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'forbidden',
      reason: 'inactive_user',
    });
    expect(select).not.toHaveBeenCalled();
  });

  it('returns the rows of an active staff user as { id, name }', async () => {
    const { service, select } = setup(principalOf({}), [
      { id: 'd1', code: 'FIN', name: 'Finance', active: true },
    ]);
    await expect(service.list()).resolves.toEqual([
      { id: 'd1', code: 'FIN', name: 'Finance', active: true },
    ]);
    expect(select).toHaveBeenCalledOnce();
  });
});
