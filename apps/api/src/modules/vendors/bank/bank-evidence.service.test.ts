// Who may attach a bank account's call-back evidence (U18 #18): the routes are @AnyAuthenticated because the grant is
// either `vendor.bank.propose` (procurement) or `vendor.bank.verify` (finance), so the service is the route check.
// Unit level, with the REAL VendorBankEvidenceService, evidence owner policy, DocumentsService and AuthzService and
// each role's real default grants; only the database is faked (every read answers one proposed account of a vendor
// owned by someone else). The verify that follows the upload, and the proposer-never-verifies rule, are in
// bank.integration.test.ts (needs Postgres).
// Run: pnpm --filter @bos/api exec vitest run src/modules/vendors/bank/bank-evidence.service.test.ts
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

import { AuthzService } from '../../../platform/authz/authz.service';
import type { Principal } from '../../../platform/authz/can';
import type { RoleCache } from '../../../platform/authz/role-cache';
import type { Db } from '../../../platform/db/db.module';
import { DocumentsService } from '../../../platform/documents/documents.service';
import type { SignedLinks } from '../../../platform/documents/signed-link';
import type { StorageAdapter } from '../../../platform/documents/storage.adapter';
import {
  bindIdentity,
  bindPrincipal,
  runWithRequestStore,
} from '../../../platform/tenancy/request-context';
import type { VendorsCaller } from '../vendors.caller';
import { VendorBankEvidenceController } from './bank-evidence.controller';
import { bankEvidenceOwnerPolicy } from './bank-evidence.policy';
import { VendorBankEvidenceService } from './bank-evidence.service';

const TENANT = randomUUID();
const ORG = randomUUID();
const VENDOR = randomUUID();
const ACCOUNT = randomUUID();
const VENDOR_OWNER = randomUUID();
const FILE = { filename: 'callback.pdf', declaredMime: 'application/pdf', sizeBytes: 1234 };

const as = (role: RoleKey, edit: (g: Map<Permission, Scope>) => void = () => {}): Principal => {
  const grants = new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
  edit(grants);
  return {
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
    grants,
  };
};

/** A select chain that answers `rows` however it is finished (limit, for, or awaited as is). */
function answer(rows: unknown[]) {
  const q = {
    from: () => q,
    innerJoin: () => q,
    where: () => q,
    limit: () => Promise.resolve(rows),
    for: () => Promise.resolve(rows),
    then: (ok: (v: unknown[]) => unknown, no?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(ok, no),
  };
  return q;
}

function world(p: Principal) {
  const account = { id: ACCOUNT, status: 'proposed', vendorId: VENDOR, ownerUserId: VENDOR_OWNER };
  const inserted: Record<string, unknown>[] = [];
  const select = vi.fn(() => answer([account]));
  const tx = {
    execute: vi.fn().mockResolvedValue({
      rows: [{ tenant_id: TENANT, organization_id: ORG, actor_id: p.userId, actor_kind: 'user' }],
    }),
    select,
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return Promise.resolve();
      },
    })),
  };
  const db = {
    select,
    transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Db;
  const documents = new DocumentsService(
    db,
    {} as StorageAdapter,
    {} as SignedLinks,
    { add: vi.fn() } as unknown as Queue,
    new AuthzService({} as Db, {} as RoleCache),
    { record: vi.fn().mockResolvedValue(undefined) },
  );
  documents.registerOwner(bankEvidenceOwnerPolicy(db));
  const caller = {
    current: () => ({
      scope: { tenantId: TENANT, organizationId: ORG },
      actor: { kind: 'user' as const, id: p.userId, correlationId: 'corr-1' },
      principal: p,
    }),
  } as unknown as VendorsCaller;
  const service = new VendorBankEvidenceService(db, caller, documents);
  return { service, inserted, select };
}

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

async function tryCreate(
  p: Principal,
): Promise<{ answer: string; inserted: number; reads: number }> {
  const w = world(p);
  try {
    const created = await asCaller(p, () => w.service.create(VENDOR, ACCOUNT, FILE));
    expect(created.uploadPath).toBe(
      `/v1/vendors/${VENDOR}/bank-accounts/${ACCOUNT}/evidence/${created.documentId}/versions/${created.versionId}/content`,
    );
    return { answer: '201', inserted: w.inserted.length, reads: w.select.mock.calls.length };
  } catch (e) {
    if (e instanceof ForbiddenException) {
      return { answer: '403', inserted: w.inserted.length, reads: w.select.mock.calls.length };
    }
    throw e;
  }
}

describe('VendorBankEvidenceService.create: who may attach call-back evidence', () => {
  it('finance (vendor.bank.verify, no vendor.bank.propose or documents.upload) attaches it on a vendor it does not own', async () => {
    const finance = as('finance');
    expect(finance.grants.has('vendor.bank.propose')).toBe(false);
    expect(finance.grants.has('documents.upload')).toBe(false);
    expect(finance.grants.get('vendor.bank.verify')).toBe('all');
    expect(await tryCreate(finance)).toMatchObject({ answer: '201', inserted: 2 });
  });

  it('procurement (vendor.bank.propose) still attaches it', async () => {
    expect(await tryCreate(as('procurement'))).toMatchObject({ answer: '201', inserted: 2 });
  });

  it('refuses roles with neither grant, even with documents.upload, before reading anything', async () => {
    for (const p of [
      as('accountant', (g) => g.set('documents.upload', 'all')),
      as('sales'),
      as('pmo'),
    ]) {
      expect(await tryCreate(p)).toEqual({ answer: '403', inserted: 0, reads: 0 });
    }
  });

  it('checks the grant on the vendor: an own-scope verify grant on a vendor someone else owns writes nothing', async () => {
    const ownOnly = as('finance', (g) => g.set('vendor.bank.verify', 'own'));
    expect(await tryCreate(ownOnly)).toMatchObject({ answer: '403', inserted: 0 });
  });

  it('refuses a portal caller even if it somehow held the grant', async () => {
    const vendorUser = { ...as('finance'), orgKind: 'vendor' as const, partyId: VENDOR };
    expect(await tryCreate(vendorUser)).toEqual({ answer: '403', inserted: 0, reads: 0 });
  });
});

describe('VendorBankEvidenceController.upload', () => {
  it('answers 403 to a caller without either grant before it reads the request', () => {
    const w = world(as('sales'));
    const controller = new VendorBankEvidenceController(w.service);
    // No content-length and an ended stream: a granted caller would get 411/415, this one gets 403 first.
    const req = { headers: {}, readableEnded: true } as never;
    expect(() => controller.upload(VENDOR, ACCOUNT, randomUUID(), randomUUID(), req)).toThrow(
      ForbiddenException,
    );
    expect(w.select).not.toHaveBeenCalled();
  });
});
