// Unit tests of the tax-code and payment-term Settings routes (F1-Q49), with no database: who may call them
// (settings.finance.write or admin.settings.write, live grants not roles), and that a refusal or a bad request
// happens before any read or write. The rules for periods are in tax-code-periods.test.ts; the routes against
// Postgres in master-data.integration.test.ts.
import 'reflect-metadata';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../../platform/audit/audit.service';
import type { Principal } from '../../../platform/authz/principal';
import { findUnmarkedRoutes } from '../../../platform/authz/route-policy.check';
import type { Db } from '../../../platform/db/db.module';
import { MasterDataCaller } from './master-data.caller';
import { MasterDataController } from './master-data.controller';
import { MasterDataService } from './master-data.service';

const scope = { tenantId: 't-1', organizationId: 'o-1' };
const actor = { kind: 'user' as const, id: 'u-1', correlationId: 'c-1' };

vi.mock('../../../platform/db/tx', () => ({
  requestTx: () => ({ scope, actor }),
  withTx: vi.fn(),
}));

let currentPrincipal: Principal;
vi.mock('../../../platform/authz/principal', () => ({ principal: () => currentPrincipal }));

/** A staff principal whose live grants are exactly `grants` (its role's defaults are not added). */
function principal(
  roles: RoleKey[],
  grants: Partial<Record<Permission, Scope>>,
  orgKind: Principal['orgKind'] = 'staff',
): Principal {
  return {
    userId: 'a0000000-0000-4000-8000-000000000001',
    zitadelUserId: 'sub-1',
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    orgKind,
    partyId: null,
    idpOrgId: 'e0000000-0000-4000-8000-000000000001',
    roles,
    departmentId: null,
    status: 'active',
    grants: new Map(Object.entries(grants) as [Permission, Scope][]),
  };
}

/** A select chain that resolves to `rows` wherever it is awaited. */
function selectReturning(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const step of ['from', 'where', 'orderBy', 'for', 'limit']) chain[step] = () => chain;
  chain.then = (resolve: (value: unknown[]) => unknown) => resolve(rows);
  return chain;
}

const select = vi.fn();
const db = { select } as unknown as Db;
let controller: MasterDataController;

const VALID_CREATE = {
  code: 'VAT13',
  name: 'VAT 13%',
  kind: 'vat',
  rate: '13',
  creditable: true,
  effectiveFrom: '2099-01-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  select.mockImplementation(() => selectReturning([]));
  const service = new MasterDataService(db, {} as AuditService, new MasterDataCaller());
  controller = new MasterDataController(service);
});

describe('who may use the tax-code and payment-term routes', () => {
  it('lets a finance-settings grant in, whatever the role', async () => {
    currentPrincipal = principal(['sales'], { 'settings.finance.write': 'all' });
    await expect(controller.listTaxCodes()).resolves.toEqual([]);
    await expect(controller.listPaymentTerms()).resolves.toEqual([]);
  });

  it('lets the Founder in through admin.settings.write', async () => {
    currentPrincipal = principal(['founder'], { 'admin.settings.write': 'all' });
    await expect(controller.listTaxCodes()).resolves.toEqual([]);
  });

  it('refuses a Finance role whose live grants hold only exchange rates, before any read', async () => {
    currentPrincipal = principal(['finance'], { 'settings.fx_rate.write': 'all' });
    await expect(controller.listTaxCodes()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.listPaymentTerms()).rejects.toBeInstanceOf(ForbiddenException);
    expect(select).not.toHaveBeenCalled();
  });

  it('refuses Sales with its default grants on every route, before parsing the body', () => {
    currentPrincipal = principal(['sales'], DEFAULT_ROLE_PERMISSIONS.sales);
    const calls = [
      () => controller.createTaxCode({}),
      () => controller.changeTaxCode('VAT13', {}),
      () => controller.retireTaxCode('VAT13', {}),
      () => controller.createPaymentTerm({}),
      () => controller.updatePaymentTerm('00000000-0000-4000-8000-000000000001', {}),
    ];
    for (const call of calls) expect(call).toThrow(ForbiddenException);
    expect(select).not.toHaveBeenCalled();
  });

  it('refuses a customer user holding the grant', async () => {
    currentPrincipal = principal([], { 'settings.finance.write': 'all' }, 'customer');
    await expect(controller.listTaxCodes()).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('bad requests', () => {
  beforeEach(() => {
    currentPrincipal = principal(['accountant'], { 'settings.finance.write': 'all' });
  });

  it('answers 400 for a rate that does not suit the kind, and for extra fields', () => {
    expect(() => controller.createTaxCode({ ...VALID_CREATE, rate: '0' })).toThrow(
      BadRequestException,
    );
    expect(() => controller.createTaxCode({ ...VALID_CREATE, kind: 'exempt' })).toThrow(
      BadRequestException,
    );
    expect(() => controller.createTaxCode({ ...VALID_CREATE, rateBp: 1300 })).toThrow(
      BadRequestException,
    );
  });

  it('answers 400 when a change tries to set the kind or a payment term its days', () => {
    expect(() =>
      controller.changeTaxCode('VAT13', {
        name: 'VAT',
        rate: '0',
        kind: 'zero',
        creditable: false,
        effectiveFrom: '2099-01-01',
        expectedVersion: 1,
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      controller.updatePaymentTerm('00000000-0000-4000-8000-000000000001', {
        netDays: 45,
        expectedVersion: 1,
      }),
    ).toThrow(BadRequestException);
  });

  it('answers 404 for a code that cannot exist, before any read', () => {
    expect(() =>
      controller.retireTaxCode('vat 13', { effectiveTo: '2099-01-01', expectedVersion: 1 }),
    ).toThrow(NotFoundException);
    expect(select).not.toHaveBeenCalled();
  });
});

describe('route policy', () => {
  it('marks every route', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MasterDataController],
      providers: [{ provide: MasterDataService, useValue: {} }],
    }).compile();
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    await moduleRef.close();
  });
});
