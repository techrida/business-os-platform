// An owner policy may name the permission that authorises uploads to it (`uploadPermission`, P3 U13: payment
// proof is uploaded by whoever records payments, `payment.record`). Unit level, with the REAL AuthzService.assert
// and the principal bound in the real request store; only the database is faked. Without the field the check is
// `documents.upload`, exactly as before; with it, that permission replaces `documents.upload` on the same owner ref.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { CreateDocumentBody, Permission, Scope } from '@bos/contracts';
import { ForbiddenException } from '@nestjs/common';
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

async function tryCreate(service: DocumentsService, p: Principal): Promise<string> {
  const { tx, inserted } = fakeTx();
  try {
    await asCaller(p, () => service.create(tx, body));
    return `created ${inserted.length}`;
  } catch (e) {
    if (e instanceof ForbiddenException) return `403 ${inserted.length}`;
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
});
