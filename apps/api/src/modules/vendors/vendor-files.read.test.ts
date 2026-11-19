// Who may open a vendor's files (U18 #24): bank account call-back evidence (`vendor_bank_account`) and files the vendor
// sent from the portal (`vendor_portal_intake`) are read with `vendor.read` on the vendor, or `documents.read`, so
// procurement (documents.read own) opens them on a vendor it does not own without a wider documents.read.
// Unit level, with the REAL owner policies, DocumentsService (get and download link) and AuthzService and each role's
// real default grants; only the database is faked, and the vendor is owned by someone else.
// Run: pnpm --filter @bos/api exec vitest run src/modules/vendors/vendor-files.read.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { ForbiddenException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { AuthzService } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/can';
import type { RoleCache } from '../../platform/authz/role-cache';
import type { Db } from '../../platform/db/db.module';
import type { DocumentOwnerPolicy } from '../../platform/documents/documents.ports';
import { DocumentsService } from '../../platform/documents/documents.service';
import type { SignedLinks } from '../../platform/documents/signed-link';
import type { StorageAdapter } from '../../platform/documents/storage.adapter';
import {
  bindIdentity,
  bindPrincipal,
  runWithRequestStore,
} from '../../platform/tenancy/request-context';
import { vendorIntakeOwnerPolicy } from '../portal-vendor/inbox/vendor-intake.policy';
import { bankEvidenceOwnerPolicy } from './bank/bank-evidence.policy';

const TENANT = randomUUID();
const ORG = randomUUID();
const VENDOR = randomUUID();
const OWNER_ID = randomUUID();
const VENDOR_OWNER = randomUUID();

const as = (role: RoleKey): Principal => ({
  userId: randomUUID(),
  zitadelUserId: `z-${role}`,
  tenantId: TENANT,
  organizationId: ORG,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: randomUUID(),
  roles: [role],
  departmentId: null,
  status: 'active',
  grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>,
});

/** A select chain that answers `rows` however it is finished (limit, orderBy, or awaited as is). */
function answer(rows: unknown[]) {
  const q = {
    from: () => q,
    innerJoin: () => q,
    where: () => q,
    limit: () => Promise.resolve(rows),
    orderBy: () => Promise.resolve(rows),
    then: (ok: (v: unknown[]) => unknown, no?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(ok, no),
  };
  return q;
}

/** Every read answers the row its caller looks for: one document, one clean version, the vendor's owner. */
function readDb(ownerType: string): Db {
  const row = {
    // documents (get)
    id: randomUUID(),
    ownerType,
    ownerId: OWNER_ID,
    currentVersionId: null,
    createdAt: new Date('2026-11-19T00:00:00Z'),
    // loadVersion (issueLink)
    version: { status: 'clean' },
    // the owner policy's vendor lookup
    status: 'proposed',
    vendorId: VENDOR,
    ownerUserId: VENDOR_OWNER,
  };
  let reads = 0;
  return {
    select: () => {
      reads += 1;
      // The versions of the document (the third read of `get`) are none: this test is about who may read.
      return answer(reads === 3 ? [] : [row]);
    },
  } as unknown as Db;
}

const POLICIES: [string, (db: Db) => DocumentOwnerPolicy][] = [
  ['bank account call-back evidence', bankEvidenceOwnerPolicy],
  ['files the vendor sent from the portal', vendorIntakeOwnerPolicy],
];

async function tryRead(
  makePolicy: (db: Db) => DocumentOwnerPolicy,
  p: Principal,
  how: 'get' | 'link',
): Promise<string> {
  const policy = makePolicy({} as Db);
  const db = readDb(policy.ownerType);
  const service = new DocumentsService(
    db,
    {} as StorageAdapter,
    { issue: () => ({ token: 'tok', expiresAt: new Date() }) } as unknown as SignedLinks,
    { add: vi.fn() } as unknown as Queue,
    new AuthzService({} as Db, {} as RoleCache),
    { record: vi.fn().mockResolvedValue(undefined) },
  );
  service.registerOwner(makePolicy(db));
  const scope = { tenantId: TENANT, organizationId: ORG };
  try {
    await runWithRequestStore('corr-1', () => {
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
      return how === 'get'
        ? service.get(scope, randomUUID())
        : service.issueLink(scope, randomUUID());
    });
    return 'read';
  } catch (e) {
    if (e instanceof ForbiddenException) return '403';
    throw e;
  }
}

describe.each(POLICIES)('reading %s', (_name, makePolicy) => {
  it('is authorised with vendor.read as well as documents.read', () => {
    expect(makePolicy({} as Db).readPermission).toBe('vendor.read');
  });

  it.each(['get', 'link'] as const)(
    'procurement (documents.read own, vendor.read all) opens it on a vendor it does not own (%s)',
    async (how) => {
      const procurement = as('procurement');
      expect(procurement.grants.get('documents.read')).toBe('own');
      expect(procurement.grants.get('vendor.read')).toBe('all');
      expect(await tryRead(makePolicy, procurement, how)).toBe('read');
    },
  );

  it.each(['get', 'link'] as const)(
    'a role without vendor.read or documents.read all is still refused (%s)',
    async (how) => {
      for (const role of ['sales', 'warehouse', 'operations_officer', 'pmo'] as const) {
        expect(as(role).grants.has('vendor.read')).toBe(false);
        expect(await tryRead(makePolicy, as(role), how)).toBe('403');
      }
    },
  );

  it('management (documents.read all, no vendor.read) keeps reading: the grant is added, nothing narrows', async () => {
    const management = as('management');
    expect(management.grants.has('vendor.read')).toBe(false);
    expect(await tryRead(makePolicy, management, 'get')).toBe('read');
  });
});
