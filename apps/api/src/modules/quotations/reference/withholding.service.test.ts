import 'reflect-metadata';

import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthzService } from '../../../platform/authz/authz.service';
import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import { ReferenceService } from './reference.service';

const state = vi.hoisted(() => ({ principal: {} as Principal }));
vi.mock('../../../platform/authz/principal', () => ({ principal: () => state.principal }));

const rows = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    code: 'TDS0',
    name: 'Pending accountant signoff',
    rateBp: 0,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  },
];
const orderBy = vi.fn().mockResolvedValue(rows);
const where = vi.fn(() => ({ orderBy }));
const from = vi.fn(() => ({ where }));
const select = vi.fn(() => ({ from }));
const service = () =>
  new ReferenceService(
    { select } as unknown as Db,
    { tenantId: () => 'tenant-a' },
    new AuthzService({} as never, {} as never),
  );

beforeEach(() => {
  vi.clearAllMocks();
  state.principal = {
    userId: 'user-a',
    zitadelUserId: 'zitadel-user-a',
    idpOrgId: 'staff-idp-org-a',
    partyId: null,
    departmentId: null,
    roles: [],
    tenantId: 'tenant-a',
    organizationId: 'entity-a',
    orgKind: 'staff',
    status: 'active',
    grants: new Map([['payables.bill.enter', 'all']]),
  };
});

describe('withholding registry access', () => {
  it('returns the tenant payable codes with effective dates for bill entry', async () => {
    await expect(service().listWithholdingCodes()).resolves.toEqual(rows);
    expect(select).toHaveBeenCalledOnce();
  });
  it.each(['customer', 'vendor'] as const)(
    'refuses %s even if it holds the staff grant, before reading',
    async (orgKind) => {
      state.principal = { ...state.principal, orgKind };
      await expect(service().listWithholdingCodes()).rejects.toBeInstanceOf(ForbiddenException);
      expect(select).not.toHaveBeenCalled();
    },
  );
  it.each(['inactive', 'invited'] as const)('refuses %s staff before reading', async (status) => {
    state.principal = { ...state.principal, status };
    await expect(service().listWithholdingCodes()).rejects.toBeInstanceOf(ForbiddenException);
    expect(select).not.toHaveBeenCalled();
  });
  it('returns the codes to staff holding only settings.finance.write (the Tax settings page, F1-Q48)', async () => {
    state.principal = { ...state.principal, grants: new Map([['settings.finance.write', 'all']]) };
    await expect(service().listWithholdingCodes()).resolves.toEqual(rows);
  });
  it('refuses staff without the bill-entry or finance-settings grant', async () => {
    state.principal = { ...state.principal, grants: new Map([['payables.bill.read', 'all']]) };
    await expect(service().listWithholdingCodes()).rejects.toBeInstanceOf(ForbiddenException);
    expect(select).not.toHaveBeenCalled();
  });
});
