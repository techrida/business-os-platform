// Unit tests of who may read GET /v1/tax-codes. The list serves three forms: the quotation form (quotation.read),
// RFQ quotation entry (procurement.sourcing) and payables bill entry (payables.bill.enter). Real: ReferenceService
// and AuthzService with the real can() decision. Faked: the database read (the tax-code query is its own unit).
// The principal is bound in a request store the way the tenancy interceptor does.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/reference/reference.service.test.ts
import 'reflect-metadata';

import type { Permission } from '@bos/contracts';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AuthzService } from '../../../platform/authz/authz.service';
import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import {
  bindIdentity,
  bindPrincipal,
  runWithRequestStore,
} from '../../../platform/tenancy/request-context';
import type { ReferenceCaller } from './reference.caller';
import { ReferenceService } from './reference.service';

const listTaxCodesEffectiveOn = vi.hoisted(() => vi.fn());
vi.mock('../pricing/tax-codes.resolver', () => ({ listTaxCodesEffectiveOn }));

const TENANT = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
const ENTITY = '9a1b2c3d-0d52-4d1e-9d8a-3f1d2c3b4a5f';
const ROW = {
  id: '1b2c3d4e-0d52-4d1e-9d8a-3f1d2c3b4a5f',
  code: 'VAT13',
  name: 'VAT 13%',
  kind: 'vat' as const,
  rateBp: 1300,
  creditable: true,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
};

function principalWith(
  permissions: readonly Permission[],
  status: Principal['status'] = 'active',
): Principal {
  return {
    userId: '5c6d7e8f-0d52-4d1e-9d8a-3f1d2c3b4a5f',
    zitadelUserId: 'zitadel-user',
    tenantId: TENANT,
    organizationId: ENTITY,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: '6d7e8f90-0d52-4d1e-9d8a-3f1d2c3b4a5f',
    roles: [],
    departmentId: null,
    status,
    grants: new Map(permissions.map((p) => [p, 'all'])),
  };
}

/** Runs `fn` with `p` bound as the request principal, the way the tenancy interceptor would. */
function asCaller<T>(p: Principal, fn: () => Promise<T>): Promise<T> {
  return runWithRequestStore('test-correlation-id', () => {
    bindIdentity({
      tenantId: p.tenantId,
      organizationId: p.organizationId,
      orgKind: p.orgKind,
      partyId: p.partyId,
      idpOrgId: p.idpOrgId,
      userId: p.zitadelUserId,
      roles: p.roles,
      departmentId: p.departmentId,
      tokenExp: Math.floor(Date.now() / 1000) + 300,
    });
    bindPrincipal(p);
    return fn();
  });
}

function service(): ReferenceService {
  listTaxCodesEffectiveOn.mockReset().mockResolvedValue([ROW]);
  const caller: ReferenceCaller = { tenantId: () => TENANT };
  // AuthzService.assert reads only the bound principal, so the db and role cache are never touched.
  const authz = new AuthzService({} as never, {} as never);
  return new ReferenceService({} as Db, caller, authz);
}

describe('ReferenceService.listTaxCodes grant', () => {
  it.each([
    'quotation.read',
    'procurement.sourcing',
    'payables.bill.enter',
    'settings.finance.write',
  ] as const)('returns the list to a caller holding only %s', async (permission) => {
    const list = await asCaller(principalWith([permission]), () => service().listTaxCodes());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: ROW.id, code: 'VAT13', rateBp: 1300 });
  });

  it('refuses a caller holding none of them with 403 forbidden, before any read', async () => {
    const s = service();
    // Holds unrelated and near-miss permissions, not one of the three.
    const p = principalWith(['procurement.receipt.confirm', 'payables.bill.read']);
    const error: unknown = await asCaller(p, () => s.listTaxCodes()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getStatus()).toBe(403);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'forbidden',
      reason: 'no_permission',
    });
    expect(listTaxCodesEffectiveOn).not.toHaveBeenCalled();
  });

  it('refuses an inactive caller even when the grant is present', async () => {
    const s = service();
    const p = principalWith(['procurement.sourcing'], 'inactive');
    const error: unknown = await asCaller(p, () => s.listTaxCodes()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'forbidden',
      reason: 'inactive_user',
    });
    expect(listTaxCodesEffectiveOn).not.toHaveBeenCalled();
  });
});
