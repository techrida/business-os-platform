// An owner policy may name the permission that authorises uploads to it (`uploadPermission`, P3 U13: payment
// proof is uploaded by whoever records payments, `payment.record`). Unit level, with the REAL AuthzService.assert
// and the principal bound in the real request store; only the database is faked. Without the field the check is
// `documents.upload`, exactly as before; with it, that permission replaces `documents.upload` on the same owner ref,
// and a list means any one of them. A staff read passes with `documents.read` or the policy's `readPermission`.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { CreateDocumentBody, Permission, Scope } from '@bos/contracts';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { AuthzService } from '../authz/authz.service';
import type { Principal } from '../authz/can';
import type { RoleCache } from '../authz/role-cache';
import type { Db, DbTransaction } from '../db/tx';
import { bindIdentity, bindPrincipal, runWithRequestStore } from '../tenancy/request-context';
import type { DocumentOwnerPolicy } from './documents.ports';
import { DocumentsService } from './documents.service';
import type { SignedLinks } from './signed-link';
import type { StorageAdapter } from './storage.adapter';

const TENANT = randomUUID();
const ORG = randomUUID();
const USER = randomUUID();
const OWNER_ID = randomUUID();
const OWNER_TYPE = 'intake';

const body: CreateDocumentBody = {
  ownerType: OWNER_TYPE,
  ownerId: OWNER_ID,
  filename: 'slip.pdf',
  declaredMime: 'application/pdf',
  sizeBytes: 1234,
};

/** An active staff member of the acting entity holding exactly `grants`. */
const staff = (grants: [Permission, Scope][]): Principal => ({
  userId: USER,
  zitadelUserId: 'zitadel-sub',
  tenantId: TENANT,
  organizationId: ORG,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: randomUUID(),
  roles: ['accountant'],
  departmentId: null,
  status: 'active',
  grants: new Map(grants),
});

function asCaller<T>(p: Principal, fn: () => Promise<T>): Promise<T> {
  return runWithRequestStore('corr-1', () => {
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

/** A transaction that answers readTxContext with the user actor and records inserts. */
function fakeTx() {
  const inserted: Record<string, unknown>[] = [];
  const tx = {
    execute: vi.fn().mockResolvedValue({
      rows: [{ tenant_id: TENANT, organization_id: ORG, actor_id: USER, actor_kind: 'user' }],
    }),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return Promise.resolve();
      },
    })),
  };
  return { tx: tx as unknown as DbTransaction, inserted };
}

function serviceWith(policy: Partial<DocumentOwnerPolicy>): DocumentsService {
  const service = new DocumentsService(
    {} as Db,
    {} as StorageAdapter,
    {} as SignedLinks,
    { add: vi.fn() } as unknown as Queue,
    new AuthzService({} as Db, {} as RoleCache),
    { record: vi.fn().mockResolvedValue(undefined) },
  );
  service.registerOwner({
    ownerType: OWNER_TYPE,
    // A record of the acting entity with no owning user, like a customer-scoped intake.
    resource: (scope) => Promise.resolve({ ...scope, customerPartyId: OWNER_ID, sodUserIds: [] }),
    ...policy,
  });
  return service;
}

async function tryCreate(
  service: DocumentsService,
  p: Principal,
  action?: Permission,
): Promise<string> {
  const { tx, inserted } = fakeTx();
  try {
    await asCaller(p, () => service.create(tx, body, { action }));
    return `created ${inserted.length}`;
  } catch (e) {
    if (e instanceof ForbiddenException) return `403 ${inserted.length}`;
    if (e instanceof NotFoundException) return `404 ${inserted.length}`;
    throw e;
  }
}

describe('DocumentsService.create and the owner policy uploadPermission', () => {
  describe('a policy without uploadPermission (unchanged behaviour)', () => {
    const service = serviceWith({});

    it('authorises with documents.upload', async () => {
      expect(await tryCreate(service, staff([['documents.upload', 'all']]))).toBe('created 2');
    });

    it('refuses a caller holding only another permission', async () => {
      expect(await tryCreate(service, staff([['vendor.bank.propose', 'all']]))).toBe('403 0');
    });
  });

  describe("a policy with uploadPermission: 'vendor.bank.propose'", () => {
    const service = serviceWith({ uploadPermission: 'vendor.bank.propose' });

    it('authorises with that permission', async () => {
      expect(await tryCreate(service, staff([['vendor.bank.propose', 'all']]))).toBe('created 2');
    });

    it('no longer accepts documents.upload in its place', async () => {
      expect(await tryCreate(service, staff([['documents.upload', 'all']]))).toBe('403 0');
    });
  });

  describe('a policy with a list of upload permissions (any one of them)', () => {
    const service = serviceWith({
      uploadPermission: ['vendor.bank.propose', 'vendor.bank.verify'],
    });

    it('authorises with the first or the second', async () => {
      expect(await tryCreate(service, staff([['vendor.bank.propose', 'all']]))).toBe('created 2');
      expect(await tryCreate(service, staff([['vendor.bank.verify', 'all']]))).toBe('created 2');
    });

    it('refuses a caller holding neither, even with documents.upload, and writes nothing', async () => {
      expect(await tryCreate(service, staff([['documents.upload', 'all']]))).toBe('403 0');
      expect(await tryCreate(service, staff([]))).toBe('403 0');
    });

    it('checks each on the owner ref: an own-scope grant on a record owned by someone else is refused', async () => {
      const owned = serviceWith({
        uploadPermission: ['vendor.bank.propose', 'vendor.bank.verify'],
        resource: (scope) => Promise.resolve({ ...scope, ownerUserId: randomUUID() }),
      });
      expect(await tryCreate(owned, staff([['vendor.bank.verify', 'own']]))).toBe('403 0');
      expect(await tryCreate(owned, staff([['vendor.bank.verify', 'all']]))).toBe('created 2');
    });
  });
});

describe('DocumentsService.create and the upload action the owning module names (U20a2-Q3)', () => {
  // The record belongs to someone else, so an `own` grant on the owner ref never reaches it.
  const someoneElses = (scope: { tenantId: string; organizationId: string }) =>
    Promise.resolve({ ...scope, ownerUserId: randomUUID() });
  const listed = serviceWith({
    uploadPermission: 'payables.bill.enter',
    uploadActions: ['payables.bill.enter'],
    resource: someoneElses,
  });

  it('a listed action with an own grant authorises the caller to upload their own new file', async () => {
    const own = staff([['payables.bill.enter', 'own']]);
    expect(await tryCreate(listed, own)).toBe('403 0');
    expect(await tryCreate(listed, own, 'payables.bill.enter')).toBe('created 2');
  });

  it('an action the policy does not list keeps the usual check (deny by default)', async () => {
    const unlisted = serviceWith({
      uploadPermission: 'payables.bill.enter',
      resource: someoneElses,
    });
    const own = staff([['payables.bill.enter', 'own']]);
    expect(await tryCreate(unlisted, own, 'payables.bill.enter')).toBe('403 0');
    // Naming a stronger action the caller holds changes nothing either: it is not listed.
    expect(
      await tryCreate(
        listed,
        staff([
          ['payables.bill.enter', 'own'],
          ['vendor.bank.verify', 'all'],
        ]),
        'vendor.bank.verify',
      ),
    ).toBe('403 0');
  });

  it('a caller without the action is refused, even with documents.upload', async () => {
    expect(
      await tryCreate(listed, staff([['documents.upload', 'all']]), 'payables.bill.enter'),
    ).toBe('403 0');
    expect(await tryCreate(listed, staff([]), 'payables.bill.enter')).toBe('403 0');
  });

  it('the owner must exist in the scope: 404 before any write', async () => {
    const missing = serviceWith({
      uploadPermission: 'payables.bill.enter',
      uploadActions: ['payables.bill.enter'],
      resource: () => Promise.resolve(null),
    });
    expect(
      await tryCreate(missing, staff([['payables.bill.enter', 'all']]), 'payables.bill.enter'),
    ).toBe('404 0');
  });
});

/** A database that answers `get`: the document row, then its (here: no) versions. */
function readDb(): Db {
  const answers: unknown[][] = [
    [
      {
        id: randomUUID(),
        ownerType: OWNER_TYPE,
        ownerId: OWNER_ID,
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

async function tryGet(policy: Partial<DocumentOwnerPolicy>, p: Principal): Promise<string> {
  const service = new DocumentsService(
    readDb(),
    {} as StorageAdapter,
    {} as SignedLinks,
    { add: vi.fn() } as unknown as Queue,
    new AuthzService({} as Db, {} as RoleCache),
    { record: vi.fn().mockResolvedValue(undefined) },
  );
  service.registerOwner({
    ownerType: OWNER_TYPE,
    // A record owned by someone other than the caller, so `own` scopes do not reach it.
    resource: (scope) => Promise.resolve({ ...scope, ownerUserId: randomUUID() }),
    ...policy,
  });
  try {
    const doc = await asCaller(p, () =>
      service.get({ tenantId: TENANT, organizationId: ORG }, 'd'),
    );
    return `read ${doc.ownerId === OWNER_ID ? 'owner' : '?'}`;
  } catch (e) {
    if (e instanceof ForbiddenException) return '403';
    throw e;
  }
}

describe('DocumentsService reads and the owner policy readPermission', () => {
  it('without readPermission, reads need documents.read at a scope that reaches the record (unchanged)', async () => {
    expect(await tryGet({}, staff([['documents.read', 'all']]))).toBe('read owner');
    expect(await tryGet({}, staff([['documents.read', 'own']]))).toBe('403');
    expect(await tryGet({}, staff([['vendor.read', 'all']]))).toBe('403');
  });

  it("with readPermission: 'vendor.read', the owning module's read opens a record someone else owns", async () => {
    const policy = { readPermission: 'vendor.read' as const };
    // Procurement: documents.read own plus vendor.read all.
    expect(
      await tryGet(
        policy,
        staff([
          ['documents.read', 'own'],
          ['vendor.read', 'all'],
        ]),
      ),
    ).toBe('read owner');
  });

  it('readPermission is in addition to documents.read: documents.read all still reads', async () => {
    expect(
      await tryGet({ readPermission: 'vendor.read' }, staff([['documents.read', 'all']])),
    ).toBe('read owner');
  });

  it('a caller with neither (or only own scopes) is still refused', async () => {
    const policy = { readPermission: 'vendor.read' as const };
    expect(await tryGet(policy, staff([['documents.read', 'own']]))).toBe('403');
    expect(await tryGet(policy, staff([['vendor.read', 'own']]))).toBe('403');
    expect(await tryGet(policy, staff([['vendor.bank.propose', 'all']]))).toBe('403');
    expect(await tryGet(policy, staff([]))).toBe('403');
  });
});
