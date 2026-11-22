// Integration test of the KYB case of a VENDOR party (P4 K3) on a real Postgres (Testcontainers, needs Docker in
// WSL). Same real parts as verification.integration.test.ts (every migration as bos_owner, queries as bos_app,
// the controller, VerificationService, DocumentsService, AuditService, the real pure can()), plus what K3 adds:
// the party_kind column and its FK to parties, the vendor checklist, and the PartyOwnerPort registration point.
// The vendor adapter is a stand-in registered through `registerPartyOwner`; the real one arrives with P4 V1.
// Run: pnpm --filter @bos/api exec vitest run src/modules/verification/verification.vendor.integration.test.ts
import 'reflect-metadata';

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ROLE_PERMISSIONS,
  VENDOR_CHECKLIST_ITEM_KEYS,
  VerificationCaseDtoSchema,
  type Permission,
  type RoleKey,
  type Scope,
  type VerificationCaseDto,
} from '@bos/contracts';
import {
  createParty,
  createStaffUser,
  createTenantWithEntity,
  documentVersions,
  parties,
} from '@bos/db';
import { ForbiddenException, NotFoundException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import { can } from '../../platform/authz/can';
import type { AuthzService } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SignedLinks } from '../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../platform/documents/storage.adapter';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { type PartyOwnerPort } from './party-owner.port';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SECRET = 'an-integration-test-secret-of-32-plus-chars';
const VENDOR_REQUIRED = ['pan_certificate', 'tax_clearance', 'bank_proof'] as const;
const TAX_CLEARANCE_EXPIRY = '2027-07-15';
let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
let storageRoot: string;
let documents: DocumentsService;
let service: VerificationService;
let scope: { tenantId: string; organizationId: string };
let scope2: { tenantId: string; organizationId: string };
let otherTenantProcurement: string;
let staffIdpOrgId: string;

type UserKey = 'founder' | 'pmo' | 'procurement' | 'sales' | 'warehouse';
const U: Record<UserKey, string> = {
  founder: randomUUID(),
  pmo: randomUUID(),
  procurement: randomUUID(),
  sales: randomUUID(),
  warehouse: randomUUID(),
};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: {
  userId: string;
  grants: Map<Permission, Scope>;
  principalScope?: { tenantId: string; organizationId: string };
  callerScope?: { tenantId: string; organizationId: string };
} = {
  userId: U.founder,
  grants: grantsOf('founder'),
};
const as = (userId: string, role: RoleKey) => {
  current.userId = userId;
  current.grants = grantsOf(role);
  delete current.principalScope;
  delete current.callerScope;
};
const asWith = (
  userId: string,
  grants: Map<Permission, Scope>,
  opts: {
    principalScope?: { tenantId: string; organizationId: string };
    callerScope?: { tenantId: string; organizationId: string };
  } = {},
) => {
  current.userId = userId;
  current.grants = grants;
  if (opts.principalScope !== undefined) current.principalScope = opts.principalScope;
  else delete current.principalScope;
  if (opts.callerScope !== undefined) current.callerScope = opts.callerScope;
  else delete current.callerScope;
};

const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  ...(current.principalScope ?? scope),
  orgKind: 'staff',
  partyId: null,
  idpOrgId: staffIdpOrgId,
  roles: [],
  departmentId: null,
  status: 'active',
  grants: current.grants,
});
const caller = {
  current: () => ({
    scope: current.callerScope ?? scope,
    actor: { kind: 'user' as const, id: current.userId, correlationId: 'test-corr' },
    principal: principalNow(),
  }),
};
const authz = {
  assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
    const d = can(principalNow(), action, ref);
    if (!d.allowed) {
      throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: d.reason });
    }
  },
};
const documentsAudit = { record: vi.fn(() => Promise.resolve(undefined)) };

/** The owner user of a vendor party, as the vendors row would hold it. */
const vendorOwners = new Map<string, string>();

/**
 * What V1's vendor adapter does (VendorPartyOwner), on the party row alone: the write permission is vendor.write
 * and the owner comes from `vendorOwners` in place of the vendors row.
 */
const vendorPort: PartyOwnerPort = {
  kind: 'vendor',
  label: 'Vendor',
  writePermission: 'vendor.write',
  findLive: async (q, tenantId, partyId) => {
    const [row] = await q
      .select({ id: parties.id })
      .from(parties)
      .where(
        and(eq(parties.tenantId, tenantId), eq(parties.id, partyId), eq(parties.kind, 'vendor')),
      );
    return row === undefined
      ? undefined
      : { id: row.id, ownerUserId: vendorOwners.get(row.id) ?? null };
  },
  ownersOf: async (q, tenantId, partyIds) => {
    if (partyIds.length === 0) return new Map();
    const rows = await q
      .select({ id: parties.id })
      .from(parties)
      .where(
        and(
          eq(parties.tenantId, tenantId),
          eq(parties.kind, 'vendor'),
          inArray(parties.id, [...partyIds]),
        ),
      );
    return new Map(rows.map((r) => [r.id, vendorOwners.get(r.id) ?? null]));
  },
  labelsOf: async (q, tenantId, partyIds) => {
    if (partyIds.length === 0) return new Map();
    const rows = await q
      .select({ id: parties.id, name: parties.name })
      .from(parties)
      .where(and(eq(parties.tenantId, tenantId), inArray(parties.id, [...partyIds])));
    return new Map(rows.map((r) => [r.id, { name: r.name, number: null }]));
  },
  ownedBy: (q, tenantId, userId) =>
    q
      .select({ id: parties.id })
      .from(parties)
      .where(
        and(
          eq(parties.tenantId, tenantId),
          eq(parties.kind, 'vendor'),
          inArray(
            parties.id,
            [...vendorOwners].filter(([, owner]) => owner === userId).map(([id]) => id),
          ),
        ),
      ),
  counterparty: (partyId) => ({ vendorPartyId: partyId }),
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 6 });
  db = drizzle({ client: appPool });

  const tenant = await createTenantWithEntity(appPool);
  staffIdpOrgId = tenant.idpOrgId;
  scope = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  for (const key of Object.keys(U) as UserKey[]) {
    U[key] = (await createStaffUser(appPool, { ...scope, idpOrgId: tenant.idpOrgId })).userId;
  }
  const tenant2 = await createTenantWithEntity(appPool);
  scope2 = { tenantId: tenant2.tenantId, organizationId: tenant2.organizationId };
  otherTenantProcurement = (
    await createStaffUser(appPool, { ...scope2, idpOrgId: tenant2.idpOrgId })
  ).userId;

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-kyb-vendor-it-'));
  documents = new DocumentsService(
    db,
    new DiskStorageAdapter(storageRoot),
    new SignedLinks(SECRET, { claim: () => Promise.resolve(true) }),
    { add: vi.fn().mockResolvedValue({}) } as unknown as Queue,
    authz,
    documentsAudit,
  );
  service = new VerificationService(
    db,
    documents,
    authz as unknown as AuthzService,
    new AuditService(db),
    caller,
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [VerificationController],
    providers: [{ provide: VerificationService, useValue: service }],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  configureApp(app);
  app.useGlobalFilters(new ErrorBodyFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  as(U.founder, 'founder');
});

// ---------------------------------------------------------------------------------------------- helpers

const api = () => request(baseUrl);
const newVendor = async (ownerUserId?: string) => {
  const { partyId } = await createParty(appPool, { tenantId: scope.tenantId, kind: 'vendor' });
  if (ownerUserId !== undefined) vendorOwners.set(partyId, ownerUserId);
  return partyId;
};
const newCustomerParty = async () =>
  (await createParty(appPool, { tenantId: scope.tenantId, kind: 'customer' })).partyId;
/** A customer party with its customers row (what the customer adapter reads), owned by `ownerUserId`. */
const newCustomer = async (ownerUserId: string | null) => {
  const partyId = await newCustomerParty();
  await withTx(db, scope, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.customers
              (id, tenant_id, number, legal_name, name_norm, owner_user_id, country, address_line, address_city)
          VALUES (${partyId}, ${scope.tenantId}, ${`CUS-${partyId.slice(0, 8)}`}, 'Acme Pvt. Ltd.', 'acme',
                  ${ownerUserId}, 'NP', 'Durbar Marg 1', 'Kathmandu')`,
    ),
  );
  return partyId;
};

async function openCase(partyId: string): Promise<VerificationCaseDto> {
  const res = await api().post('/v1/verification-cases').send({ partyId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return VerificationCaseDtoSchema.parse(res.body);
}

/** A clean, scanned document of the case, made through the real DocumentsService. */
async function cleanDocument(caseId: string, txScope = scope) {
  return withTx(
    db,
    txScope,
    { kind: 'user', id: current.userId, correlationId: 'test-corr' },
    async (tx) => {
      const created = await documents.create(tx, {
        ownerType: 'verification_case',
        ownerId: caseId,
        filename: 'certificate.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: 10,
      });
      await tx
        .update(documentVersions)
        .set({ status: 'quarantined', updatedAt: new Date() })
        .where(eq(documentVersions.id, created.versionId));
      await tx
        .update(documentVersions)
        .set({
          status: 'clean',
          sha256: createHash('sha256').update(created.versionId).digest(),
          detectedMime: 'application/pdf',
          updatedAt: new Date(),
        })
        .where(eq(documentVersions.id, created.versionId));
      return created;
    },
  );
}

const putDocument = (
  caseId: string,
  key: string,
  documentId: string,
  expectedVersion: number,
  expiresOn?: string,
) =>
  api()
    .patch(`/v1/verification-cases/${caseId}/checklist`)
    .send({ key, documentId, expectedVersion, ...(expiresOn ? { expiresOn } : {}) });

/** Every required vendor item gets a clean document; the tax clearance gets its expiry. */
async function fillRequired(c: VerificationCaseDto): Promise<VerificationCaseDto> {
  let dto = c;
  for (const key of VENDOR_REQUIRED) {
    const doc = await cleanDocument(dto.id);
    const res = await putDocument(
      dto.id,
      key,
      doc.documentId,
      dto.version,
      key === 'tax_clearance' ? TAX_CLEARANCE_EXPIRY : undefined,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    dto = VerificationCaseDtoSchema.parse(res.body);
  }
  return dto;
}

const rawCase = async (id: string) => {
  const { rows } = await ownerPool.query<{ party_kind: string; status: string }>(
    'SELECT party_kind, status FROM app.verification_cases WHERE id = $1',
    [id],
  );
  return rows[0]!;
};

// -------------------------------------------------------------------------------------------------- tests

describe('a vendor party before an adapter is registered', () => {
  it('is 404 on POST /v1/verification-cases (deny by default), and no case is written', async () => {
    const partyId = await newVendor();
    const res = await api().post('/v1/verification-cases').send({ partyId });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    const { rows } = await ownerPool.query(
      'SELECT 1 FROM app.verification_cases WHERE party_id = $1',
      [partyId],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('the party_kind column and its foreign key (0031)', () => {
  const insert = (partyId: string, kind: string) =>
    ownerPool.query(
      `INSERT INTO app.verification_cases (tenant_id, party_id, party_kind) VALUES ($1, $2, $3)`,
      [scope.tenantId, partyId, kind],
    );

  it('refuses a case that names a vendor party as a customer, and a customer party as a vendor', async () => {
    await expect(insert(await newVendor(), 'customer')).rejects.toMatchObject({
      code: '23503',
      constraint: 'verification_cases_party_fk',
    });
    await expect(insert(await newCustomerParty(), 'vendor')).rejects.toMatchObject({
      code: '23503',
      constraint: 'verification_cases_party_fk',
    });
    await expect(insert(await newVendor(), 'supplier')).rejects.toMatchObject({
      code: '23514',
      constraint: 'verification_cases_party_kind_check',
    });
  });

  it('accepts a vendor case for a vendor party, and defaults to customer', async () => {
    const vendor = await newVendor();
    const customer = await newCustomerParty();
    // Writes go through withTx so the audit trigger has its actor.
    await withTx(db, scope, systemActor('test'), async (tx) => {
      await tx.execute(
        sql`INSERT INTO app.verification_cases (tenant_id, party_id, party_kind)
            VALUES (${scope.tenantId}, ${vendor}, 'vendor')`,
      );
      await tx.execute(
        sql`INSERT INTO app.verification_cases (tenant_id, party_id)
            VALUES (${scope.tenantId}, ${customer})`,
      );
    });
    const { rows } = await ownerPool.query<{ party_id: string; party_kind: string }>(
      'SELECT party_id, party_kind FROM app.verification_cases WHERE party_id = ANY($1)',
      [[vendor, customer]],
    );
    expect(new Map(rows.map((r) => [r.party_id, r.party_kind]))).toEqual(
      new Map([
        [vendor, 'vendor'],
        [customer, 'customer'],
      ]),
    );
  });
});

describe('a vendor case, once the vendor adapter is registered', () => {
  beforeAll(() => {
    service.registerPartyOwner(vendorPort);
  });

  it('refuses a second adapter for the same kind', () => {
    expect(() => service.registerPartyOwner(vendorPort)).toThrow(/already registered/);
  });

  it('opens with the vendor checklist, stored as a vendor case, and lists with it', async () => {
    const partyId = await newVendor();
    const dto = await openCase(partyId);
    expect(dto).toMatchObject({ partyId, status: 'draft', version: 1 });
    expect(dto.checklist.map((i) => i.key).sort()).toEqual([...VENDOR_CHECKLIST_ITEM_KEYS].sort());
    expect(
      dto.checklist
        .filter((i) => i.required)
        .map((i) => i.key)
        .sort(),
    ).toEqual([...VENDOR_REQUIRED].sort());
    expect(await rawCase(dto.id)).toMatchObject({ party_kind: 'vendor', status: 'draft' });

    const list = await api().get('/v1/verification-cases').query({ partyId });
    expect(list.status).toBe(200);
    expect((list.body as VerificationCaseDto[]).map((c) => c.id)).toEqual([dto.id]);
  });

  it('names the vendor in the case list for pmo, who holds no vendor.read, and sends only the label (audit #8)', async () => {
    const partyId = await newVendor();
    const dto = await openCase(partyId);
    const { rows } = await appPool.query<{ name: string }>(
      'SELECT name FROM app.parties WHERE id = $1',
      [partyId],
    );

    as(U.pmo, 'pmo');
    const list = await api().get('/v1/verification-cases').query({ partyId });
    expect(list.status).toBe(200);
    const [item] = list.body as Record<string, unknown>[];
    expect(item).toMatchObject({
      id: dto.id,
      partyKind: 'vendor',
      partyName: rows[0]?.name,
      partyNumber: null,
    });
    // The label only: the DTO's own keys plus the two label fields, nothing of the vendor record itself.
    expect(Object.keys(item ?? {}).sort()).toEqual(
      [...Object.keys(dto), 'partyName', 'partyNumber'].sort(),
    );
  });

  it('is still 404 for an unknown party', async () => {
    expect(
      (await api().post('/v1/verification-cases').send({ partyId: randomUUID() })).status,
    ).toBe(404);
  });

  it('refuses a customer key on a vendor case, and a tax clearance without its expiry (422)', async () => {
    const dto = await openCase(await newVendor());
    const doc = await cleanDocument(dto.id);
    const customerKey = await putDocument(
      dto.id,
      'registration_certificate',
      doc.documentId,
      dto.version,
    );
    expect(customerKey.status, JSON.stringify(customerKey.body)).toBe(422);
    const noExpiry = await putDocument(dto.id, 'tax_clearance', doc.documentId, dto.version);
    expect(noExpiry.status, JSON.stringify(noExpiry.body)).toBe(422);
    const withExpiry = await putDocument(
      dto.id,
      'tax_clearance',
      doc.documentId,
      dto.version,
      TAX_CLEARANCE_EXPIRY,
    );
    expect(withExpiry.status, JSON.stringify(withExpiry.body)).toBe(200);
  });

  it('cannot be submitted while a required vendor document is missing (409)', async () => {
    const dto = await openCase(await newVendor());
    const res = await api().post(`/v1/verification-cases/${dto.id}/submit`);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('pan_certificate');
  });

  it('reaches submitted with the vendor checklist, and only another user can decide it', async () => {
    const filled = await fillRequired(await openCase(await newVendor()));
    const submitted = await api().post(`/v1/verification-cases/${filled.id}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const dto = VerificationCaseDtoSchema.parse(submitted.body);
    expect(dto.status).toBe('submitted');
    expect(
      dto.checklist
        .filter((i) => i.status === 'provided')
        .map((i) => i.key)
        .sort(),
    ).toEqual([...VENDOR_REQUIRED].sort());
    expect(await rawCase(dto.id)).toMatchObject({ party_kind: 'vendor', status: 'submitted' });

    // Reviewer is not the submitter.
    const own = await api()
      .post(`/v1/verification-cases/${dto.id}/decision`)
      .send({ decision: 'approve', comment: 'ok', expectedVersion: dto.version });
    expect(own.status).toBe(403);

    // Clean documents are checked before a decision: a different reviewer approves them.
    as(U.pmo, 'pmo');
    expect(dto.reviewPolicy).toBe('case_review_v0');
    const itemDecision = await api()
      .post(`/v1/verification-cases/${dto.id}/checklist/pan_certificate/decision`)
      .set('Idempotency-Key', randomUUID())
      .send({ decision: 'approve', expectedVersion: dto.version });
    expect(itemDecision.status).toBe(409);
    const approved = await api()
      .post(`/v1/verification-cases/${dto.id}/decision`)
      .send({ decision: 'approve', comment: 'ok', expectedVersion: dto.version });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(
      (
        await ownerPool.query<{ count: string }>(
          'SELECT count(*) FROM app.verification_review_events WHERE case_id=$1',
          [dto.id],
        )
      ).rows[0]?.count,
    ).toBe('0');
    expect(VerificationCaseDtoSchema.parse(approved.body)).toMatchObject({
      status: 'approved',
      reviewedBy: U.pmo,
    });
  });

  it('tells the Founder who submitted it that they cannot review it, and offers pmo the review', async () => {
    const filled = await fillRequired(await openCase(await newVendor()));
    const submitted = await api().post(`/v1/verification-cases/${filled.id}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    const mine = await api().get(`/v1/verification-cases/${filled.id}`);
    expect(mine.status).toBe(200);
    const asSubmitter = VerificationCaseDtoSchema.parse(mine.body);
    expect(asSubmitter.can?.review).toBe(false);
    expect(asSubmitter.reviewBlockedReason).toBe('The submitter cannot review this case.');
    // The vendor case gains only the blocked reason: none of the customer review fields ride along.
    for (const key of ['reviewerNames', 'looseEvidence', 'approvalBlockedReason']) {
      expect(mine.body).not.toHaveProperty(key);
    }

    as(U.pmo, 'pmo');
    const theirs = VerificationCaseDtoSchema.parse(
      (await api().get(`/v1/verification-cases/${filled.id}`)).body,
    );
    expect(theirs.can?.review).toBe(true);
    expect(theirs.reviewBlockedReason).toBeNull();
  });
  // K3b: the write routes carry no single route-level permission; the service asks for the write permission of
  // the case's party kind (customer.write or vendor.write), and refuses a caller with neither before any read.
  describe('who may write a KYB case', () => {
    const write = {
      create: (partyId: string) => api().post('/v1/verification-cases').send({ partyId }),
      checklist: (caseId: string) => putDocument(caseId, 'pan_certificate', randomUUID(), 1),
      remove: (caseId: string, expectedVersion: number, key = 'pan_certificate') =>
        api()
          .post(`/v1/verification-cases/${caseId}/checklist/remove`)
          .send({ key, expectedVersion }),
      submit: (caseId: string) => api().post(`/v1/verification-cases/${caseId}/submit`),
    };

    it('lets procurement (vendor.write) open, fill and submit a vendor case, and read it', async () => {
      as(U.procurement, 'procurement');
      const partyId = await newVendor(U.procurement);
      const filled = await fillRequired(await openCase(partyId));
      const submitted = await write.submit(filled.id);
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      expect(VerificationCaseDtoSchema.parse(submitted.body).status).toBe('submitted');

      const one = await api().get(`/v1/verification-cases/${filled.id}`);
      expect(one.status, JSON.stringify(one.body)).toBe(200);
      const list = await api().get('/v1/verification-cases').query({ partyId });
      expect((list.body as VerificationCaseDto[]).map((c) => c.id)).toEqual([filled.id]);
    });

    it('permits removing an active vendor checklist file only with the vendor write permission', async () => {
      as(U.procurement, 'procurement');
      const c = await fillRequired(await openCase(await newVendor(U.procurement)));
      const item = c.checklist.find((entry) => entry.required && entry.documentId !== null)!;
      as(U.sales, 'sales');
      expect((await write.remove(c.id, c.version, item.key)).status).toBe(404);
      as(U.procurement, 'procurement');
      const removed = await write.remove(c.id, c.version, item.key);
      expect(removed.status).toBe(200);
      expect(VerificationCaseDtoSchema.parse(removed.body).checklist).toContainEqual(
        expect.objectContaining({ key: item.key, status: 'missing', documentId: null }),
      );
    });

    it('refuses procurement on a customer case with 403, and writes nothing', async () => {
      const partyId = await newCustomer(U.sales);
      const c = await openCase(partyId);
      as(U.procurement, 'procurement');
      for (const res of [
        await write.create(partyId),
        await write.checklist(c.id),
        await write.remove(c.id, c.version),
        await write.submit(c.id),
      ]) {
        expect(res.status, JSON.stringify(res.body)).toBe(403);
      }
      expect(await rawCase(c.id)).toMatchObject({ party_kind: 'customer', status: 'draft' });
    });

    it('lets sales (customer.write) work a customer case, and refuses sales on a vendor case', async () => {
      as(U.sales, 'sales');
      const mine = await openCase(await newCustomer(U.sales));
      // Past the permission check: an unknown document is a 422, a missing required document a 409.
      expect((await write.checklist(mine.id)).status).toBe(422);
      expect(
        (
          await api()
            .post(`/v1/verification-cases/${mine.id}/submit`)
            .set('Idempotency-Key', randomUUID())
            .send({ expectedVersion: mine.version })
        ).status,
      ).toBe(409);

      as(U.founder, 'founder');
      const vendorParty = await newVendor(U.sales);
      const vendorCase = await openCase(vendorParty);
      as(U.sales, 'sales');
      for (const res of [
        await write.create(vendorParty),
        await write.checklist(vendorCase.id),
        await write.remove(vendorCase.id, vendorCase.version),
        await write.submit(vendorCase.id),
      ]) {
        expect(res.status, JSON.stringify(res.body)).toBe(403);
      }
      expect(await rawCase(vendorCase.id)).toMatchObject({ party_kind: 'vendor', status: 'draft' });
    });

    it('gives a user with neither write permission the same 403 for a real and an unknown id', async () => {
      const vendorParty = await newVendor();
      const customerParty = await newCustomer(null);
      const vendorCase = await openCase(vendorParty);
      const customerCase = await openCase(customerParty);
      as(U.warehouse, 'warehouse');
      const answers = [
        await write.create(vendorParty),
        await write.create(customerParty),
        await write.create(randomUUID()),
        await write.checklist(vendorCase.id),
        await write.checklist(customerCase.id),
        await write.checklist(randomUUID()),
        await write.submit(vendorCase.id),
        await write.submit(customerCase.id),
        await write.submit(randomUUID()),
      ];
      for (const res of answers) {
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        const body = (res.body as { error?: { code?: unknown; reason?: unknown } }).error;
        expect({ code: body?.code, reason: body?.reason }).toEqual({
          code: 'forbidden',
          reason: 'no_permission',
        });
        for (const id of [vendorParty, customerParty, vendorCase.id, customerCase.id]) {
          expect(JSON.stringify(res.body)).not.toContain(id);
        }
      }
      expect(await rawCase(vendorCase.id)).toMatchObject({ status: 'draft' });
    });
  });

  describe('vendor case file attachment (U18 Q9 b)', () => {
    it('lets procurement attach and read files on a vendor case it does not own (other owner and unowned)', async () => {
      const otherOwned = await openCase(await newVendor(U.founder));
      const unowned = await openCase(await newVendor());

      as(U.procurement, 'procurement');
      for (const c of [otherOwned, unowned]) {
        const loaded = VerificationCaseDtoSchema.parse(
          (await api().get(`/v1/verification-cases/${c.id}`)).body,
        );
        expect(loaded.can?.attach).toBe(true);

        const doc = await cleanDocument(c.id);
        const read = await documents.get(scope, doc.documentId);
        expect(read.ownerId).toBe(c.id);

        const attached = await putDocument(c.id, 'pan_certificate', doc.documentId, loaded.version);
        expect(attached.status, JSON.stringify(attached.body)).toBe(200);
        expect(VerificationCaseDtoSchema.parse(attached.body).checklist).toContainEqual(
          expect.objectContaining({ key: 'pan_certificate', documentId: doc.documentId }),
        );
      }
    });

    it('refuses vendor.write without read on the vendor case', async () => {
      const c = await openCase(await newVendor(U.founder));
      const doc = await cleanDocument(c.id);

      const ownRead = grantsOf('procurement');
      ownRead.set('verification.read', 'own');
      asWith(U.procurement, ownRead);

      await expect(cleanDocument(c.id)).rejects.toBeInstanceOf(ForbiddenException);
      const patched = await putDocument(c.id, 'pan_certificate', doc.documentId, c.version);
      expect(patched.status, JSON.stringify(patched.body)).toBe(404);
    });

    it('refuses users without vendor.write who are not the vendor owner', async () => {
      const c = await openCase(await newVendor(U.founder));
      const doc = await cleanDocument(c.id);

      for (const [userId, role] of [
        [U.pmo, 'pmo'],
        [U.sales, 'sales'],
        [U.warehouse, 'warehouse'],
      ] as const) {
        as(userId, role);
        await expect(cleanDocument(c.id)).rejects.toBeInstanceOf(ForbiddenException);
        const patched = await putDocument(c.id, 'pan_certificate', doc.documentId, c.version);
        expect(patched.status, JSON.stringify(patched.body)).toBe(403);
      }
    });

    it('still refuses another tenant and another legal entity', async () => {
      const c = await openCase(await newVendor(U.founder));
      const doc = await cleanDocument(c.id);

      // Another tenant: case is invisible under its own scope (404) and forbidden against tenant 1's scope (403).
      asWith(otherTenantProcurement, grantsOf('procurement'), {
        principalScope: scope2,
        callerScope: scope2,
      });
      await expect(cleanDocument(c.id, scope2)).rejects.toBeInstanceOf(NotFoundException);
      await expect(cleanDocument(c.id, scope)).rejects.toBeInstanceOf(ForbiddenException);
      expect((await putDocument(c.id, 'pan_certificate', doc.documentId, c.version)).status).toBe(
        404,
      );

      // Another legal entity of the same tenant: principal's entity differs from target scope.
      asWith(U.procurement, grantsOf('procurement'), {
        principalScope: { tenantId: scope.tenantId, organizationId: randomUUID() },
        callerScope: scope,
      });
      await expect(cleanDocument(c.id, scope)).rejects.toBeInstanceOf(ForbiddenException);
      expect((await putDocument(c.id, 'pan_certificate', doc.documentId, c.version)).status).toBe(
        404,
      );
    });

    it('leaves customer cases unaffected', async () => {
      const c = await openCase(await newCustomer(U.sales));

      as(U.procurement, 'procurement');
      await expect(cleanDocument(c.id)).rejects.toBeInstanceOf(ForbiddenException);

      // Non-owner holding customer.write + verification.read (all) + documents.upload (own) is still refused.
      const salesReadAll = grantsOf('sales');
      salesReadAll.set('verification.read', 'all');
      asWith(U.founder, salesReadAll);
      await expect(cleanDocument(c.id)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
