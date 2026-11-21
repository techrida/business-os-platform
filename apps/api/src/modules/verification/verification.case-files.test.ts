// Audit #19: pmo reviews every verification case but held documents.read only for its own records, so the files
// of a case on a party it does not own showed "File details unavailable". The verification owner policy now adds
// `verification.review` as a read permission for its own files. Unit level: the REAL VerificationService registers
// its REAL policy into the REAL DocumentsService, and the REAL AuthzService.assert decides on the default grants of
// each role; only the database is faked (the case is owned by a sales user, never the caller).
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type CreateDocumentBody,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import type { RoleCache } from '../../platform/authz/role-cache';
import type { Db, DbTransaction } from '../../platform/db/db.module';
import { DocumentsService } from '../../platform/documents/documents.service';
import type { SignedLinks } from '../../platform/documents/signed-link';
import type { StorageAdapter } from '../../platform/documents/storage.adapter';
import {
  bindIdentity,
  bindPrincipal,
  runWithRequestStore,
} from '../../platform/tenancy/request-context';
import { VendorPartyOwner } from '../vendors/vendor-party-owner';
import { CustomerPartyOwner } from './customer-party-owner';
import type { VerificationCaller } from './verification.caller';
import { VerificationService } from './verification.service';
import { VERIFICATION_OWNER_TYPE } from './verification.types';

const TENANT = randomUUID();
const ENTITY = randomUUID();
const CASE_ID = randomUUID();
const PARTY = randomUUID();
const SALES_OWNER = randomUUID();
const CALLER = randomUUID();
const SCOPE = { tenantId: TENANT, organizationId: ENTITY };

const as = (role: RoleKey, userId = CALLER): Principal => ({
  userId,
  zitadelUserId: `z-${userId}`,
  tenantId: TENANT,
  organizationId: ENTITY,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: randomUUID(),
  roles: [role],
  departmentId: null,
  status: 'active',
  grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>,
});

function asCaller<T>(p: Principal, fn: () => Promise<T>): Promise<T> {
  return runWithRequestStore('corr-12345678', () => {
    bindIdentity({
      tenantId: p.tenantId,
      organizationId: p.organizationId,
      orgKind: p.orgKind,
      partyId: p.partyId,
      idpOrgId: p.idpOrgId,
      userId: p.zitadelUserId,
      roles: [...p.roles],
      departmentId: p.departmentId,
      tokenExp: Math.floor(Date.now() / 1000) + 300,
    });
    bindPrincipal(p);
    return fn();
  });
}

/** The documents table answers one case file (the document row, then no versions). */
function documentsDb(): Db {
  const answers: unknown[][] = [
    [
      {
        id: randomUUID(),
        ownerType: VERIFICATION_OWNER_TYPE,
        ownerId: CASE_ID,
        currentVersionId: null,
        createdAt: new Date('2026-11-19T00:00:00Z'),
      },
    ],
    [],
  ];
  return {
    select: () => {
      const rows = answers.shift() ?? [];
      const q = {
        from: () => q,
        where: () => q,
        limit: () => Promise.resolve(rows),
        orderBy: () => Promise.resolve(rows),
      };
      return q;
    },
  } as unknown as Db;
}

/** GET of one case file as `p`, through the verification policy. */
async function readCaseFile(
  p: Principal,
  opts: { partyKind?: 'customer' | 'vendor'; ownerUserId?: string | null } = {},
): Promise<string> {
  const partyKind = opts.partyKind ?? 'customer';
  const ownerUserId = opts.ownerUserId === undefined ? SALES_OWNER : opts.ownerUserId;
  const authz = new AuthzService({} as Db, {} as RoleCache);
  const documents = new DocumentsService(
    documentsDb(),
    {} as StorageAdapter,
    {} as SignedLinks,
    { add: vi.fn() } as unknown as Queue,
    authz,
    { record: vi.fn().mockResolvedValue(undefined) },
  );
  const verification = new VerificationService(
    {} as Db,
    documents,
    authz,
    {} as AuditService,
    {} as VerificationCaller,
  );
  // The case row and its party's owner, as the policy's `resource` / `uploadGrants` load them.
  (verification as unknown as { load: unknown }).load = (_q: unknown, tenantId: string) =>
    tenantId === TENANT
      ? Promise.resolve({
          row: { tenantId: TENANT, id: CASE_ID, partyId: PARTY, partyKind, status: 'draft' },
          partyOwnerUserId: ownerUserId,
          port: partyKind === 'vendor' ? new VendorPartyOwner() : new CustomerPartyOwner(),
        })
      : Promise.resolve(undefined);
  verification.onModuleInit();
  try {
    const doc = await asCaller(p, () => documents.get(SCOPE, 'd'));
    return doc.ownerId === CASE_ID ? 'read' : 'other';
  } catch (e) {
    if (e instanceof ForbiddenException) return '403';
    throw e;
  }
}

/** POST /v1/documents (`DocumentsService.create`) on a case as `p`, through the real verification policy. */
async function attachCaseFile(
  p: Principal,
  opts: {
    partyKind?: 'customer' | 'vendor';
    ownerUserId?: string | null;
    txScope?: { tenantId: string; organizationId: string };
  } = {},
): Promise<string> {
  const partyKind = opts.partyKind ?? 'vendor';
  const ownerUserId = opts.ownerUserId === undefined ? SALES_OWNER : opts.ownerUserId;
  const txScope = opts.txScope ?? SCOPE;
  const authz = new AuthzService({} as Db, {} as RoleCache);
  const documents = new DocumentsService(
    {} as Db,
    {} as StorageAdapter,
    {} as SignedLinks,
    { add: vi.fn() } as unknown as Queue,
    authz,
    { record: vi.fn().mockResolvedValue(undefined) },
  );
  const verification = new VerificationService(
    {} as Db,
    documents,
    authz,
    {} as AuditService,
    {} as VerificationCaller,
  );
  (verification as unknown as { load: unknown }).load = (_q: unknown, tenantId: string) =>
    tenantId === TENANT
      ? Promise.resolve({
          row: { tenantId: TENANT, id: CASE_ID, partyId: PARTY, partyKind, status: 'draft' },
          partyOwnerUserId: ownerUserId,
          port: partyKind === 'vendor' ? new VendorPartyOwner() : new CustomerPartyOwner(),
        })
      : Promise.resolve(undefined);
  verification.onModuleInit();

  const inserted: Record<string, unknown>[] = [];
  const tx = {
    execute: vi.fn().mockResolvedValue({
      rows: [
        {
          tenant_id: txScope.tenantId,
          organization_id: txScope.organizationId,
          actor_id: p.userId,
          actor_kind: 'user',
        },
      ],
    }),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return Promise.resolve();
      },
    })),
  } as unknown as DbTransaction;
  const body: CreateDocumentBody = {
    ownerType: VERIFICATION_OWNER_TYPE,
    ownerId: CASE_ID,
    filename: 'pan.pdf',
    declaredMime: 'application/pdf',
    sizeBytes: 1234,
  };
  try {
    await asCaller(p, () => documents.create(tx, body));
    return `created ${inserted.length}`;
  } catch (e) {
    if (e instanceof ForbiddenException) return `403 ${inserted.length}`;
    if (e instanceof NotFoundException) return `404 ${inserted.length}`;
    throw e;
  }
}

describe('verification case files and the review grant', () => {
  it('lets pmo open a case file on a party it does not own', async () => {
    expect(DEFAULT_ROLE_PERMISSIONS.pmo['documents.read']).toBe('own');
    expect(await readCaseFile(as('pmo'))).toBe('read');
  });

  it('still refuses a role that reads cases but does not review them (operations_head)', async () => {
    expect(DEFAULT_ROLE_PERMISSIONS.operations_head['verification.read']).toBe('all');
    expect(await readCaseFile(as('operations_head'))).toBe('403');
  });

  it("still refuses a sales colleague, and lets the party's own sales owner read as before", async () => {
    expect(await readCaseFile(as('sales'))).toBe('403');
    expect(await readCaseFile(as('sales', SALES_OWNER))).toBe('read');
  });
});

describe('vendor case file attachment (U18 Q9 b)', () => {
  it('lets procurement attach and read files on a vendor case it does not own (other owner or unowned)', async () => {
    expect(DEFAULT_ROLE_PERMISSIONS.procurement['documents.upload']).toBe('own');
    expect(DEFAULT_ROLE_PERMISSIONS.procurement['vendor.write']).toBe('all');
    expect(DEFAULT_ROLE_PERMISSIONS.procurement['verification.read']).toBe('all');
    expect(await attachCaseFile(as('procurement'), { ownerUserId: SALES_OWNER })).toBe('created 2');
    expect(await attachCaseFile(as('procurement'), { ownerUserId: null })).toBe('created 2');
    expect(
      await readCaseFile(as('procurement'), { partyKind: 'vendor', ownerUserId: SALES_OWNER }),
    ).toBe('read');
  });

  it('refuses vendor.write without verification.read on a vendor case the caller does not own', async () => {
    const base = as('procurement');
    const noRead: Principal = {
      ...base,
      grants: new Map([...base.grants].filter(([perm]) => perm !== 'verification.read')),
    };
    const ownRead: Principal = {
      ...base,
      grants: new Map([...base.grants, ['verification.read', 'own']]),
    };
    expect(await attachCaseFile(noRead, { ownerUserId: SALES_OWNER })).toBe('403 0');
    expect(await attachCaseFile(ownRead, { ownerUserId: SALES_OWNER })).toBe('403 0');
  });

  it('still refuses roles without vendor.write who are not the vendor owner', async () => {
    for (const role of [
      'pmo',
      'operations_head',
      'sales',
      'warehouse',
      'finance',
      'accountant',
      'management',
      'operations_officer',
    ] as const) {
      expect(await attachCaseFile(as(role), { ownerUserId: SALES_OWNER })).toBe('403 0');
    }
  });

  it('still refuses another tenant and another legal entity', async () => {
    const otherTenant = randomUUID();
    const otherEntity = randomUUID();
    const foreignTenantPrincipal = { ...as('procurement'), tenantId: otherTenant };
    const foreignEntityPrincipal = { ...as('procurement'), organizationId: otherEntity };

    expect(
      await attachCaseFile(foreignTenantPrincipal, {
        txScope: { tenantId: otherTenant, organizationId: otherEntity },
      }),
    ).toBe('404 0');
    expect(await attachCaseFile(foreignTenantPrincipal)).toBe('403 0');
    expect(await attachCaseFile(foreignEntityPrincipal)).toBe('403 0');
  });

  it('leaves customer cases unaffected', async () => {
    expect(
      await attachCaseFile(as('procurement'), { partyKind: 'customer', ownerUserId: SALES_OWNER }),
    ).toBe('403 0');
    expect(await readCaseFile(as('procurement'), { partyKind: 'customer' })).toBe('403');
    const salesReadAll: Principal = {
      ...as('sales'),
      grants: new Map([...as('sales').grants, ['verification.read', 'all']]),
    };
    expect(
      await attachCaseFile(salesReadAll, { partyKind: 'customer', ownerUserId: SALES_OWNER }),
    ).toBe('403 0');
  });
});
