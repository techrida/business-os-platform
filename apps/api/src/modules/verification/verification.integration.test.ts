// Integration tests of the KYB verification cases on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: every migration as bos_owner (including 0015_crm), queries as bos_app, the controller behind the
// production body parser and error filter, VerificationService, the real DocumentsService (owner policy,
// allClean) and the real AuditService (domain events). Faked: notify-free request context, the queue, and
// authz.assert, which still runs the real pure can() on a fake principal, so the ResourceRef the service builds
// decides 403 or 404. Route-level @Can is the tenancy interceptor's job and is not booted here; the route
// policy sweep (route-policy.check.test.ts) covers it once AppModule imports VerificationModule.
// Run: pnpm --filter @bos/api exec vitest run src/modules/verification/verification.integration.test.ts
import 'reflect-metadata';

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHECKLIST_ITEM_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  VerificationCaseDtoSchema,
  VerificationReviewHistorySchema,
  type Permission,
  type RoleKey,
  type Scope,
  type VerificationCaseDto,
} from '@bos/contracts';
import { createParty, createStaffUser, createTenantWithEntity, documentVersions } from '@bos/db';
import { ConflictException, ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomersService } from '../customers/customers.service';
import { NumberingService } from '../../platform/settings/numbering.service';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import { can } from '../../platform/authz/can';
import { AuthzService } from '../../platform/authz/authz.service';
import { RoleCache } from '../../platform/authz/role-cache';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SignedLinks } from '../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../platform/documents/storage.adapter';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SECRET = 'an-integration-test-secret-of-32-plus-chars';
const REQUIRED_KEYS = [
  'registration_certificate',
  'pan_vat_certificate',
  'authorised_signatory_id',
] as const;

/** A clock the tests move; the service reads it through `now()`. */
let clock = new Date('2026-11-08T04:00:00Z');
class TestVerificationService extends VerificationService {
  protected override now(): Date {
    return clock;
  }
}

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
let storageRoot: string;
let documents: DocumentsService;
let verificationService: VerificationService;
let scope: { tenantId: string; organizationId: string };
let staffIdpOrgId: string;
/** A second tenant: its cases must be invisible to the first. */
let scope2: { tenantId: string; organizationId: string };

const U: Record<'founder' | 'pmo' | 'pmo2' | 'salesA' | 'salesB', string> = {
  founder: randomUUID(),
  pmo: randomUUID(),
  pmo2: randomUUID(),
  salesA: randomUUID(),
  salesB: randomUUID(),
};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: { userId: string; grants: Map<Permission, Scope> } = {
  userId: U.founder,
  grants: grantsOf('founder'),
};
const as = (userId: string, role: RoleKey) => {
  current.userId = userId;
  current.grants = grantsOf(role);
};

const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  ...scope,
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
    scope,
    actor: { kind: 'user' as const, id: current.userId, correlationId: 'test-corr' },
    principal: principalNow(),
  }),
};
// The reviewer picker reads grants through the real role cache, as a request does.
let liveAuthz: AuthzService;
const authz = {
  rolesHold: (...args: Parameters<AuthzService['rolesHold']>) => liveAuthz.rolesHold(...args),
  assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
    const d = can(principalNow(), action, ref);
    if (!d.allowed) {
      throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: d.reason });
    }
  },
};
const documentsAudit = { record: vi.fn(() => Promise.resolve(undefined)) };

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 6 });
  db = drizzle({ client: appPool });
  liveAuthz = new AuthzService(db, new RoleCache(db));

  const tenant = await createTenantWithEntity(appPool);
  staffIdpOrgId = tenant.idpOrgId;
  scope = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  const tenant2 = await createTenantWithEntity(appPool);
  scope2 = { tenantId: tenant2.tenantId, organizationId: tenant2.organizationId };
  for (const key of ['founder', 'pmo', 'pmo2', 'salesA', 'salesB'] as const) {
    U[key] = (await createStaffUser(appPool, { ...scope, idpOrgId: tenant.idpOrgId })).userId;
  }

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-kyb-it-'));
  documents = new DocumentsService(
    db,
    new DiskStorageAdapter(storageRoot),
    new SignedLinks(SECRET, { claim: () => Promise.resolve(true) }),
    { add: vi.fn().mockResolvedValue({}) } as unknown as Queue,
    authz,
    documentsAudit,
  );
  const service = new TestVerificationService(
    db,
    documents,
    authz as unknown as AuthzService,
    new AuditService(db),
    caller,
  );
  verificationService = service;
  // onModuleInit (the owner policy of the case's documents) runs when the Nest app below starts.
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
  clock = new Date('2026-11-08T04:00:00Z');
  as(U.founder, 'founder');
});

// ---------------------------------------------------------------------------------------------- helpers

/** A customer party and its customer row in `s`'s tenant, owned by `ownerUserId` when given. */
async function newCustomer(
  s: { tenantId: string; organizationId: string } = scope,
  ownerUserId: string | null = null,
): Promise<string> {
  const { partyId } = await createParty(appPool, { tenantId: s.tenantId, kind: 'customer' });
  await withTx(db, s, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.customers
              (id, tenant_id, number, legal_name, name_norm, owner_user_id, country, address_line, address_city)
          VALUES (${partyId}, ${s.tenantId}, ${`CUS-${partyId.slice(0, 8)}`}, 'Acme Pvt. Ltd.', 'acme',
                  ${ownerUserId}, 'NP', 'Durbar Marg 1', 'Kathmandu')`,
    ),
  );
  return partyId;
}

const api = () => request(baseUrl);

async function openCase(partyId?: string): Promise<VerificationCaseDto> {
  const res = await api()
    .post('/v1/verification-cases')
    .send({ partyId: partyId ?? (await newCustomer()) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return VerificationCaseDtoSchema.parse(res.body);
}

/** A document of the case in the given scan status, made through the real DocumentsService. */
async function attach(caseId: string, status: 'quarantined' | 'clean' | 'infected') {
  return withTx(
    db,
    scope,
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
      if (status !== 'quarantined') {
        await tx
          .update(documentVersions)
          .set({
            status,
            sha256: createHash('sha256').update(created.versionId).digest(),
            detectedMime: 'application/pdf',
            scannedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(documentVersions.id, created.versionId));
      }
      return created;
    },
  );
}

/**
 * The scan finishing after the file was put on the checklist: the only way an infected file is on a case, since
 * the checklist refuses one the scan already found infected (TR-Q12e).
 */
async function scanFinds(versionId: string, status: 'infected' | 'clean') {
  await withTx(db, scope, systemActor('test-scan'), (tx) =>
    tx
      .update(documentVersions)
      .set({ status, scannedAt: new Date(), updatedAt: new Date() })
      .where(eq(documentVersions.id, versionId)),
  );
}

const putDocument = (
  caseId: string,
  key: (typeof CHECKLIST_ITEM_KEYS)[number],
  documentId: string,
  expectedVersion: number,
  expiresOn?: string,
) =>
  api()
    .patch(`/v1/verification-cases/${caseId}/checklist`)
    .send({ key, documentId, expectedVersion, ...(expiresOn ? { expiresOn } : {}) });

const removeDocument = (
  caseId: string,
  key: (typeof CHECKLIST_ITEM_KEYS)[number],
  expectedVersion: number,
) => api().post(`/v1/verification-cases/${caseId}/checklist/remove`).send({ key, expectedVersion });

/** Every required item gets its own document in `status`; returns the case after the last change. */
async function fillRequired(
  c: VerificationCaseDto,
  status: 'quarantined' | 'clean' | 'infected' = 'clean',
): Promise<VerificationCaseDto> {
  let dto = c;
  for (const key of REQUIRED_KEYS) {
    const doc = await attach(dto.id, status === 'infected' ? 'quarantined' : status);
    const res = await putDocument(dto.id, key, doc.documentId, dto.version);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (status === 'infected') await scanFinds(doc.versionId, 'infected');
    dto = VerificationCaseDtoSchema.parse(res.body);
  }
  return dto;
}

const submitCase = async (id: string) => {
  const current = await api().get(`/v1/verification-cases/${id}`);
  return api()
    .post(`/v1/verification-cases/${id}/submit`)
    .set('Idempotency-Key', randomUUID())
    .send({
      expectedVersion: VerificationCaseDtoSchema.safeParse(current.body).data?.version ?? 1,
    });
};
async function reviewAll(c: VerificationCaseDto) {
  let current = c;
  for (const item of c.checklist.filter((i) => i.documentId)) {
    const result = await api()
      .post(`/v1/verification-cases/${c.id}/checklist/${item.key}/decision`)
      .set('Idempotency-Key', randomUUID())
      .send({ decision: 'approve', expectedVersion: current.version });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    current = VerificationCaseDtoSchema.parse(result.body);
  }
  return current;
}
const decide = (id: string, body: Record<string, unknown>, key?: string) => {
  const req = api().post(`/v1/verification-cases/${id}/decision`);
  if (key !== undefined) req.set('Idempotency-Key', key);
  return req.send(body);
};

/** A case that the founder submitted, ready for a reviewer. */
async function submittedCase(docStatus: 'quarantined' | 'clean' | 'infected' = 'clean') {
  const filled = await fillRequired(await openCase(), docStatus);
  const res = await submitCase(filled.id);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return VerificationCaseDtoSchema.parse(res.body);
}

const domainEvents = async (caseId: string): Promise<string[]> => {
  const { rows } = await ownerPool.query<{ action: string }>(
    `SELECT action FROM audit.audit_events
      WHERE entity_type = 'verification_case' AND entity_id = $1 ORDER BY id`,
    [caseId],
  );
  return rows.map((r) => r.action);
};

const rawCase = async (id: string) => {
  const { rows } = await ownerPool.query<{
    status: string;
    version: number;
    submitted_by_user_id: string | null;
    submitted_at: Date | null;
    reviewer_user_id: string | null;
  }>(
    `SELECT status, version, submitted_by_user_id, submitted_at, reviewer_user_id
       FROM app.verification_cases WHERE id = $1`,
    [id],
  );
  return rows[0]!;
};

// -------------------------------------------------------------------------------------------------- tests

describe('POST /v1/verification-cases', () => {
  it('follows a normal Sales customer create without optional ownership through case detail and list', async () => {
    as(U.salesA, 'sales');
    const customers = new CustomersService(
      db,
      new NumberingService(),
      authz as unknown as AuthzService,
      caller,
      new AuditService(db),
    );
    const customer = await customers.create(
      {
        legalName: 'Normal form customer',
        contact: {
          fullName: 'Test contact',
          email: 'review@example.test',
          country: 'NP',
          phones: [],
        },
        relationship: 'prospect',
        country: 'NP',
        address: { line: 'Durbar Marg 1', city: 'Kathmandu' },
      },
      randomUUID(),
    );
    const opened = await api().post('/v1/verification-cases').send({ partyId: customer.id });
    expect(opened.status).toBe(201);
    const openedCase = VerificationCaseDtoSchema.parse(opened.body);
    expect((await api().get(`/v1/verification-cases/${openedCase.id}`)).status).toBe(200);
    const list = await api().get('/v1/verification-cases');
    expect(JSON.stringify(list.body)).toContain(openedCase.id);
    as(U.salesB, 'sales');
    expect((await api().get(`/v1/verification-cases/${openedCase.id}`)).status).toBe(404);
  });

  it('refuses starting unreadable unowned or differently owned cases without changing ownership', async () => {
    for (const owner of [null, U.salesB]) {
      const partyId = await newCustomer(scope, owner);
      as(U.salesA, 'sales');
      expect((await api().post('/v1/verification-cases').send({ partyId })).status).toBe(404);
      as(U.founder, 'founder');
      const opened = await api().post('/v1/verification-cases').send({ partyId });
      expect(opened.status).toBe(201);
      as(U.salesA, 'sales');
      expect((await api().post('/v1/verification-cases').send({ partyId })).status).toBe(404);
    }
  });

  it('creates a draft case with the default checklist (201) and returns the same case for the same customer (200)', async () => {
    const partyId = await newCustomer();
    const first = await api().post('/v1/verification-cases').send({ partyId });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const dto = VerificationCaseDtoSchema.parse(first.body);
    expect(dto).toMatchObject({ partyId, status: 'draft', version: 1, reviewedBy: null });
    expect(dto.checklist.map((i) => i.key).sort()).toEqual([...CHECKLIST_ITEM_KEYS].sort());
    expect(dto.checklist.every((i) => i.status === 'missing')).toBe(true);

    const again = await api().post('/v1/verification-cases').send({ partyId });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    const { rows } = await ownerPool.query(
      'SELECT 1 FROM app.verification_cases WHERE party_id = $1',
      [partyId],
    );
    expect(rows).toHaveLength(1);
    expect(await domainEvents(dto.id)).toEqual(['verification.created']);
  });

  it('is 404 for a party that is not a customer of this tenant, and 400 for a malformed body', async () => {
    const foreign = await newCustomer(scope2);
    expect((await api().post('/v1/verification-cases').send({ partyId: foreign })).status).toBe(
      404,
    );
    expect(
      (await api().post('/v1/verification-cases').send({ partyId: randomUUID() })).status,
    ).toBe(404);
    expect((await api().post('/v1/verification-cases').send({ partyId: 'nope' })).status).toBe(400);
    expect(
      (await api().post('/v1/verification-cases').send({ partyId: randomUUID(), extra: 1 })).status,
    ).toBe(400);
  });

  it('reopens an expired case in place: draft again, with only the lapsed items emptied', async () => {
    const filled = await fillRequired(await openCase());
    // Give two items an expiry, then expire the case the way a sweep would.
    const reg = filled.checklist.find((i) => i.key === 'registration_certificate')!;
    const pan = filled.checklist.find((i) => i.key === 'pan_vat_certificate')!;
    let res = await putDocument(
      filled.id,
      'registration_certificate',
      reg.documentId!,
      filled.version,
      '2026-11-01',
    );
    res = await putDocument(
      filled.id,
      'pan_vat_certificate',
      pan.documentId!,
      (res.body as VerificationCaseDto).version,
      '2027-06-30',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx.execute(sql`UPDATE app.verification_cases SET status = 'expired' WHERE id = ${filled.id}`),
    );

    const reopened = await api().post('/v1/verification-cases').send({ partyId: filled.partyId });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    const dto = VerificationCaseDtoSchema.parse(reopened.body);
    expect(dto.id).toBe(filled.id);
    expect(dto.status).toBe('draft');
    expect(dto.checklist.find((i) => i.key === 'registration_certificate')).toMatchObject({
      status: 'missing',
      documentId: null,
    });
    expect(dto.checklist.find((i) => i.key === 'pan_vat_certificate')).toMatchObject({
      status: 'provided',
    });
    expect(await domainEvents(filled.id)).toContain('verification.reopened');
  });
});

describe('PATCH /v1/verification-cases/:id/checklist', () => {
  it('puts a document of the case on an item and bumps the version', async () => {
    const c = await openCase();
    const doc = await attach(c.id, 'clean');
    const res = await putDocument(
      c.id,
      'registration_certificate',
      doc.documentId,
      c.version,
      '2027-01-31',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const dto = VerificationCaseDtoSchema.parse(res.body);
    expect(dto.version).toBe(c.version + 1);
    expect(dto.checklist.find((i) => i.key === 'registration_certificate')).toMatchObject({
      status: 'provided',
      documentId: doc.documentId,
      expiresOn: '2027-01-31',
    });
  });

  it('is 422 for a document that belongs to another case, and 409 for a stale version', async () => {
    const a = await openCase();
    const b = await openCase();
    const docOfB = await attach(b.id, 'clean');
    expect((await putDocument(a.id, 'other', docOfB.documentId, a.version)).status).toBe(422);
    const docOfA = await attach(a.id, 'clean');
    expect((await putDocument(a.id, 'other', docOfA.documentId, a.version + 5)).status).toBe(409);
  });

  it('is 409 once the case is submitted, and the documents module refuses new files too', async () => {
    const submitted = await submittedCase();
    const doc = await attach(submitted.id, 'clean').catch((e: unknown) => e);
    expect(doc).toBeInstanceOf(ConflictException);
    const res = await putDocument(submitted.id, 'other', randomUUID(), submitted.version);
    expect(res.status).toBe(409);
  });
});

describe('POST /v1/verification-cases/:id/checklist/remove', () => {
  it('detaches as the owner, preserves the document and shows the empty row in the case list', async () => {
    const key = 'address_proof';
    const partyId = await newCustomer(scope, U.salesA);
    as(U.salesA, 'sales');
    const draft = await openCase(partyId);
    const first = await attach(draft.id, 'clean');
    const initial = await putDocument(draft.id, key, first.documentId, draft.version);
    expect(initial.status).toBe(200);
    const initialDto = VerificationCaseDtoSchema.parse(initial.body);

    const next = await attach(draft.id, 'clean');
    const replacement = await putDocument(
      draft.id,
      key,
      next.documentId,
      initialDto.version,
      '2027-01-31',
    );
    expect(replacement.status).toBe(200);
    const replaced = VerificationCaseDtoSchema.parse(replacement.body);
    const documentBefore = await documents.get(scope, next.documentId);

    as(U.salesB, 'sales');
    expect((await removeDocument(draft.id, key, replaced.version)).status).toBe(404);
    as(U.pmo, 'pmo');
    expect((await removeDocument(draft.id, key, replaced.version)).status).toBe(403);
    as(U.salesA, 'sales');
    expect((await removeDocument(draft.id, key, initialDto.version)).status).toBe(409);
    expect((await api().get(`/v1/verification-cases/${draft.id}`)).body).toMatchObject(replaced);

    const res = await removeDocument(draft.id, key, replaced.version);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const dto = VerificationCaseDtoSchema.parse(res.body);
    const emptyRow = {
      review: null,
      evidence: null,
      key,
      required: false,
      status: 'missing',
      documentId: null,
      expiresOn: null,
    };
    expect(dto).toEqual({
      ...replaced,
      version: replaced.version + 1,
      checklist: replaced.checklist.map((item) => (item.key === key ? emptyRow : item)),
    });
    const list = await api().get('/v1/verification-cases').query({ partyId, status: 'draft' });
    expect(list.status).toBe(200);
    // The list also names the party (audit #8); the case itself is the same.
    expect(list.body).toEqual([
      {
        ...dto,
        partyName: 'Acme Pvt. Ltd.',
        partyNumber: expect.stringMatching(/^CUS-/) as unknown,
      },
    ]);
    expect(await documents.get(scope, next.documentId)).toEqual(documentBefore);
    expect((await removeDocument(draft.id, key, dto.version)).status).toBe(409);
    expect(await domainEvents(draft.id)).toEqual([
      'verification.created',
      'verification.checklist_updated',
      'verification.checklist_updated',
      'verification.checklist_document_detached',
    ]);
  });

  it('refuses a submitted case, reopens a rejected case and keeps the removed row required', async () => {
    const key = 'registration_certificate';
    const submitted = await submittedCase();
    expect((await removeDocument(submitted.id, key, submitted.version)).status).toBe(409);

    as(U.pmo, 'pmo');
    const rejected = await decide(submitted.id, {
      decision: 'reject',
      comment: 'Please provide a newer certificate',
      expectedVersion: submitted.version,
    });
    expect(rejected.status).toBe(200);
    const rejectedDto = VerificationCaseDtoSchema.parse(rejected.body);

    as(U.founder, 'founder');
    const res = await removeDocument(submitted.id, key, rejectedDto.version);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const dto = VerificationCaseDtoSchema.parse(res.body);
    expect(dto).toMatchObject({
      status: 'draft',
      version: rejectedDto.version + 1,
      reviewedBy: null,
      decidedAt: null,
      decisionNote: null,
    });
    expect(dto.checklist.find((item) => item.key === key)).toEqual({
      evidence: null,
      review: null,
      key,
      required: true,
      status: 'missing',
      documentId: null,
      expiresOn: null,
    });
    expect(await domainEvents(dto.id)).toContain('verification.rejected');
    const resubmit = await submitCase(dto.id);
    expect(resubmit.status).toBe(409);
    expect(ErrorBodySchema.parse(resubmit.body).error.message).toContain(key);
  });
});

describe('POST /v1/verification-cases/:id/submit', () => {
  it('is 409 while a required item has no document', async () => {
    const c = await openCase();
    const res = await submitCase(c.id);
    expect(res.status).toBe(409);
    expect(ErrorBodySchema.parse(res.body).error.message).toContain('documents');
    expect((await rawCase(c.id)).status).toBe('draft');
  });

  it('submits a complete draft once; a second submit is 409', async () => {
    const submitted = await submittedCase();
    expect(submitted.status).toBe('submitted');
    expect(submitted.reviewedBy).toBeNull();
    // The submit records its own columns and leaves the reviewer's alone.
    const raw = await rawCase(submitted.id);
    expect(raw.submitted_by_user_id).toBe(U.founder);
    expect(raw.submitted_at).toEqual(clock);
    expect(raw.reviewer_user_id).toBeNull();
    expect((await submitCase(submitted.id)).status).toBe(409);
  });
});

describe('POST /v1/verification-cases/:id/decision', () => {
  it('blocks final approval after all rows are accepted when a loose upload is still scanning', async () => {
    const draft = await fillRequired(await openCase());
    const old = await attach(draft.id, 'quarantined');
    const withOld = await putDocument(
      draft.id,
      'registration_certificate',
      old.documentId,
      draft.version,
    );
    expect(withOld.status).toBe(200);
    await scanFinds(old.versionId, 'infected');
    const replacement = await attach(draft.id, 'clean');
    const replaced = await putDocument(
      draft.id,
      'registration_certificate',
      replacement.documentId,
      VerificationCaseDtoSchema.parse(withOld.body).version,
    );
    expect(replaced.status).toBe(200);
    const optional = await attach(draft.id, 'quarantined');
    const attached = await putDocument(
      draft.id,
      'address_proof',
      optional.documentId,
      VerificationCaseDtoSchema.parse(replaced.body).version,
    );
    expect(attached.status).toBe(200);
    await scanFinds(optional.versionId, 'infected');
    const detached = await removeDocument(
      draft.id,
      'address_proof',
      VerificationCaseDtoSchema.parse(attached.body).version,
    );
    expect(detached.status).toBe(200);
    await attach(draft.id, 'quarantined');

    const submitted = await submitCase(draft.id);
    expect(submitted.status).toBe(200);
    as(U.pmo, 'pmo');
    const reviewed = await reviewAll(VerificationCaseDtoSchema.parse(submitted.body));
    const decision = await decide(draft.id, {
      decision: 'approve',
      comment: 'Reviewed the replacement and remaining documents',
      expectedVersion: reviewed.version,
    });
    expect(decision.status, JSON.stringify(decision.body)).toBe(409);
    expect(ErrorBodySchema.parse(decision.body).error.message).toContain('not all clean');
  });

  it('refuses to put a file the scan found infected on the checklist with 409 document_infected (TR-Q12e)', async () => {
    const draft = await fillRequired(await openCase());
    const infected = await attach(draft.id, 'infected');
    const res = await putDocument(draft.id, 'address_proof', infected.documentId, draft.version);
    expect(res.status).toBe(409);
    expect(ErrorBodySchema.parse(res.body).error.code).toBe('document_infected');
    expect(ErrorBodySchema.parse(res.body).error.message).not.toContain('certificate.pdf');
    expect((await rawCase(draft.id)).version).toBe(draft.version);
  });

  it('blocks approval when a currently attached optional file is still scanning', async () => {
    const draft = await fillRequired(await openCase());
    const optional = await attach(draft.id, 'quarantined');
    expect(
      (await putDocument(draft.id, 'address_proof', optional.documentId, draft.version)).status,
    ).toBe(200);
    const submitted = await submitCase(draft.id);
    expect(submitted.status).toBe(200);
    as(U.pmo, 'pmo');
    const decision = await api()
      .post(`/v1/verification-cases/${draft.id}/checklist/address_proof/decision`)
      .set('Idempotency-Key', randomUUID())
      .send({
        decision: 'approve',
        expectedVersion: VerificationCaseDtoSchema.parse(submitted.body).version,
      });
    expect(decision.status).toBe(409);
    expect(ErrorBodySchema.parse(decision.body).error.message).toContain('clean');
  });

  it('runs the flow draft -> submit -> approve, and every write leaves a domain event', async () => {
    let submitted = await submittedCase();
    as(U.pmo, 'pmo');
    submitted = await reviewAll(submitted);
    const res = await decide(submitted.id, {
      decision: 'approve',
      comment: 'Registration and PAN verified against the registry',
      expectedVersion: submitted.version,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const dto = VerificationCaseDtoSchema.parse(res.body);
    expect(dto).toMatchObject({
      status: 'approved',
      reviewedBy: U.pmo,
      decisionNote: 'Registration and PAN verified against the registry',
    });
    expect(dto.decidedAt).not.toBeNull();
    expect(dto.version).toBe(submitted.version + 1);
    // The decision names the reviewer and keeps the submitter.
    const raw = await rawCase(dto.id);
    expect(raw.reviewer_user_id).toBe(U.pmo);
    expect(raw.submitted_by_user_id).toBe(U.founder);
    for (const key of REQUIRED_KEYS) {
      expect(dto.checklist.find((i) => i.key === key)!.status).toBe('accepted');
    }
    expect(await domainEvents(dto.id)).toEqual([
      'verification.created',
      'verification.checklist_updated',
      'verification.checklist_updated',
      'verification.checklist_updated',
      'verification.submitted',
      'verification.item_approved',
      'verification.item_approved',
      'verification.item_approved',
      'verification.approved',
    ]);
    // An approved case is frozen.
    as(U.founder, 'founder');
    expect((await removeDocument(dto.id, 'registration_certificate', dto.version)).status).toBe(
      409,
    );
    as(U.pmo, 'pmo');
    expect(
      (await decide(dto.id, { decision: 'reject', comment: 'x', expectedVersion: dto.version }))
        .status,
    ).toBe(409);
  });

  it('rejects with a reason, sends the case back to draft when the customer fixes an item, and allows a new round', async () => {
    const submitted = await submittedCase();
    as(U.pmo, 'pmo');
    const rejected = await decide(submitted.id, {
      decision: 'reject',
      comment: 'The signatory ID is expired',
      expectedVersion: submitted.version,
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const dto = VerificationCaseDtoSchema.parse(rejected.body);
    expect(dto).toMatchObject({
      status: 'rejected',
      reviewedBy: U.pmo,
      decisionNote: 'The signatory ID is expired',
    });

    as(U.founder, 'founder');
    const doc = await attach(dto.id, 'clean');
    const fixed = await putDocument(dto.id, 'authorised_signatory_id', doc.documentId, dto.version);
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(fixed.body).toMatchObject({
      status: 'draft',
      reviewedBy: null,
      decidedAt: null,
      decisionNote: null,
    });
    expect((await submitCase(dto.id)).status).toBe(200);
  });

  it('is 400 without a comment: to reject (contract) and to approve (the UI asks for one)', async () => {
    const submitted = await submittedCase();
    as(U.pmo, 'pmo');
    const noReason = await decide(submitted.id, {
      decision: 'reject',
      expectedVersion: submitted.version,
    });
    expect(noReason.status).toBe(400);
    const noNote = await decide(submitted.id, {
      decision: 'approve',
      expectedVersion: submitted.version,
    });
    expect(noNote.status).toBe(400);
    expect(
      (
        await decide(submitted.id, {
          decision: 'approve',
          comment: '   ',
          expectedVersion: submitted.version,
        })
      ).status,
    ).toBe(400);
    expect((await rawCase(submitted.id)).status).toBe('submitted');
  });

  it('is 403 for the person who submitted it (separation of duties), and the case stays submitted', async () => {
    const submitted = await submittedCase();
    // The founder holds every permission, including verification.review: only the rule stops this.
    const res = await decide(submitted.id, {
      decision: 'approve',
      comment: 'ok',
      expectedVersion: submitted.version,
    });
    expect(res.status).toBe(403);
    expect(ErrorBodySchema.parse(res.body).error.reason).toBe('separation_of_duties');
    const raw = await rawCase(submitted.id);
    expect(raw.status).toBe('submitted');
    expect(raw.reviewer_user_id).toBeNull();
  });

  it('is 403 for a user without verification.review', async () => {
    const submitted = await submittedCase();
    as(U.salesA, 'sales');
    const res = await decide(submitted.id, {
      decision: 'approve',
      comment: 'ok',
      expectedVersion: submitted.version,
    });
    expect(res.status).toBe(403);
  });

  it('is 409 to approve while a document is still being scanned, and works once the scan is clean', async () => {
    const submitted = await submittedCase('quarantined');
    as(U.pmo, 'pmo');
    const body = { decision: 'approve', comment: 'ok', expectedVersion: submitted.version };
    const blocked = await decide(submitted.id, body);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect((await rawCase(submitted.id)).status).toBe('submitted');

    // The scan finishes: every version of the case's documents becomes clean, with the hash a real scan stores.
    const versions = await documents.listForOwner(scope, 'verification_case', submitted.id);
    await withTx(db, scope, systemActor('test'), async (tx) => {
      for (const v of versions) {
        await tx
          .update(documentVersions)
          .set({
            status: 'clean',
            sha256: createHash('sha256').update(v.id).digest(),
            detectedMime: 'application/pdf',
            scannedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(documentVersions.id, v.id));
      }
    });
    const reviewed = await reviewAll(submitted);
    expect(
      (await decide(submitted.id, { ...body, expectedVersion: reviewed.version })).status,
    ).toBe(200);
  });

  it('is 409 to approve with an infected document', async () => {
    const submitted = await submittedCase('infected');
    as(U.pmo, 'pmo');
    const res = await decide(submitted.id, {
      decision: 'approve',
      comment: 'ok',
      expectedVersion: submitted.version,
    });
    expect(res.status).toBe(409);
    expect((await rawCase(submitted.id)).status).toBe('submitted');
  });

  it('is 409 to approve when a required item has lost its document, and a reject still works', async () => {
    const submitted = await submittedCase();
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx.execute(sql`UPDATE app.verification_cases
                        SET checklist = (SELECT jsonb_agg(
                              CASE WHEN i->>'key' = 'pan_vat_certificate'
                                   THEN jsonb_set(jsonb_set(i, '{status}', '"missing"'), '{documentId}', 'null')
                                   ELSE i END)
                              FROM jsonb_array_elements(checklist) i)
                      WHERE id = ${submitted.id}`),
    );
    as(U.pmo, 'pmo');
    const approve = await decide(submitted.id, {
      decision: 'approve',
      comment: 'ok',
      expectedVersion: submitted.version,
    });
    expect(approve.status, JSON.stringify(approve.body)).toBe(409);
    expect(ErrorBodySchema.parse(approve.body).error.message).toContain('document');
    const reject = await decide(submitted.id, {
      decision: 'reject',
      comment: 'PAN missing',
      expectedVersion: submitted.version,
    });
    expect(reject.status).toBe(200);
  });

  it('is 409 for a stale expectedVersion and for a case that is not submitted', async () => {
    // Both cases are opened as the founder (customer.write); only the decisions come from the reviewer.
    const submitted = await submittedCase();
    const draft = await openCase();
    as(U.pmo, 'pmo');
    const stale = await decide(submitted.id, {
      decision: 'approve',
      comment: 'ok',
      expectedVersion: submitted.version + 1,
    });
    expect(stale.status).toBe(409);
    const notSubmitted = await decide(draft.id, {
      decision: 'reject',
      comment: 'no',
      expectedVersion: draft.version,
    });
    expect(notSubmitted.status).toBe(409);
  });

  it('decides once per Idempotency-Key: a retry replays the answer, another body with the key is 422', async () => {
    let submitted = await submittedCase();
    as(U.pmo, 'pmo');
    submitted = await reviewAll(submitted);
    const key = `kyb-${randomUUID()}`;
    const body = { decision: 'approve', comment: 'ok', expectedVersion: submitted.version };
    const first = await decide(submitted.id, body, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const replay = await decide(submitted.id, body, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(
      (await domainEvents(submitted.id)).filter((a) => a === 'verification.approved'),
    ).toHaveLength(1);
    // The same retry without a key sees the new version and is refused.
    expect((await decide(submitted.id, body)).status).toBe(409);
    const other = await decide(submitted.id, { ...body, comment: 'something else' }, key);
    expect(other.status).toBe(422);
    expect((await decide(submitted.id, body, 'has a space')).status).toBe(400);
  });
});

describe('reading', () => {
  it('lists as a bare array, filtered by status and partyId', async () => {
    // Earlier tests in this file create >25 cases at the default clock (2026-11-08T04:00:00Z).
    // Listing orders by (created_at DESC, id DESC) with default limit 25, so cases sharing that
    // timestamp compete by random UUID and can fall off page 1. Advance the clock past every
    // other fixture in this file so `a` and `b` deterministically sort to the top of page 1.
    clock = new Date('2026-11-25T00:00:00Z');
    const a = await openCase();
    const b = await submittedCase();
    const all = await api().get('/v1/verification-cases');
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body)).toBe(true);
    const ids = (all.body as VerificationCaseDto[]).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    for (const c of all.body as unknown[]) VerificationCaseDtoSchema.parse(c);

    const drafts = await api().get('/v1/verification-cases').query({ status: 'draft' });
    expect((drafts.body as VerificationCaseDto[]).every((c) => c.status === 'draft')).toBe(true);
    expect((drafts.body as VerificationCaseDto[]).map((c) => c.id)).toContain(a.id);
    const byParty = await api().get('/v1/verification-cases').query({ partyId: b.partyId });
    expect((byParty.body as VerificationCaseDto[]).map((c) => c.id)).toEqual([b.id]);
    expect((await api().get('/v1/verification-cases').query({ status: 'bogus' })).status).toBe(400);
  });

  it('shows a salesperson only the cases of the customers they own (verification.read is own)', async () => {
    const mine = await openCase(await newCustomer(scope, U.salesA));
    const theirs = await openCase(await newCustomer(scope, U.salesB));
    as(U.salesA, 'sales');
    const list = await api().get('/v1/verification-cases');
    const ids = (list.body as VerificationCaseDto[]).map((c) => c.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect((await api().get(`/v1/verification-cases/${mine.id}`)).status).toBe(200);
    expect((await api().get(`/v1/verification-cases/${theirs.id}`)).status).toBe(404);
  });

  it('pages and counts only what the salesperson may read, not what the SQL matched', async () => {
    const mine = [];
    for (let i = 0; i < 3; i++) mine.push(await openCase(await newCustomer(scope, U.salesA)));
    for (let i = 0; i < 3; i++) await openCase(await newCustomer(scope, U.salesB));
    as(U.salesA, 'sales');
    const ids = new Set<string>();
    let total = -1;
    for (let offset = 0; ; offset += 2) {
      const page = await api().get('/v1/verification-cases').query({ limit: 2, offset });
      expect(page.status).toBe(200);
      total = Number(page.headers['x-total-count']);
      const rows = page.body as VerificationCaseDto[];
      for (const c of rows) ids.add(c.id);
      if (rows.length < 2) break;
    }
    // Every page came from the readable set only, and the header equals the readable rows walked.
    expect(ids.size).toBe(total);
    expect(total).toBeGreaterThanOrEqual(3);
    for (const c of mine) expect(ids.has(c.id)).toBe(true);
    const beyond = await api().get('/v1/verification-cases').query({ limit: 2, offset: total });
    expect(beyond.body).toEqual([]);
    expect(beyond.headers['x-total-count']).toBe(String(total));
    const filtered = await api()
      .get('/v1/verification-cases')
      .query({ status: ['draft', 'submitted'], partyKind: 'customer' });
    expect(Number(filtered.headers['x-total-count'])).toBeLessThanOrEqual(total);
  });

  it('is 404 across tenants: read, change, submit and decide', async () => {
    const foreignParty = await newCustomer(scope2);
    const { rows } = await withTx(db, scope2, systemActor('test'), (tx) =>
      tx.execute<{ id: string }>(
        sql`INSERT INTO app.verification_cases (tenant_id, party_id, status)
            VALUES (${scope2.tenantId}, ${foreignParty}, 'draft') RETURNING id`,
      ),
    );
    const foreignId = rows[0]!.id;
    expect((await api().get(`/v1/verification-cases/${foreignId}`)).status).toBe(404);
    expect((await putDocument(foreignId, 'other', randomUUID(), 1)).status).toBe(404);
    expect((await removeDocument(foreignId, 'other', 1)).status).toBe(404);
    expect((await submitCase(foreignId)).status).toBe(404);
    as(U.pmo, 'pmo');
    expect(
      (await decide(foreignId, { decision: 'approve', comment: 'ok', expectedVersion: 1 })).status,
    ).toBe(404);
    const list = await api().get('/v1/verification-cases');
    expect((list.body as VerificationCaseDto[]).map((c) => c.id)).not.toContain(foreignId);
    expect((await rawCase(foreignId)).status).toBe('draft');
  });
});

describe('customer document decisions', () => {
  it('reviews producer-provided documents before final approval and preserves Sales reasons through correction', async () => {
    as(U.salesA, 'sales');
    const c = await fillRequired(await openCase(await newCustomer(scope, U.salesA)));
    const submitted = await api()
      .post(`/v1/verification-cases/${c.id}/submit`)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedVersion: c.version });
    expect(submitted.status).toBe(200);
    let currentCase = VerificationCaseDtoSchema.parse(submitted.body);
    expect(
      currentCase.checklist.filter((i) => i.required).every((i) => i.status === 'provided'),
    ).toBe(true);
    as(U.founder, 'founder');
    const early = await decide(c.id, {
      decision: 'approve',
      comment: 'Not reviewed',
      expectedVersion: currentCase.version,
    });
    expect(early.status, 'final approval must not bulk-accept supplied files').toBe(409);
    const reason = 'Please replace the PAN. अस्पष्ट छ.';
    const key = randomUUID();
    const body = { decision: 'reject', comment: reason, expectedVersion: currentCase.version };
    const path = `/v1/verification-cases/${c.id}/checklist/pan_vat_certificate/decision`;
    const rejected = await api().post(path).set('Idempotency-Key', key).send(body);
    expect(rejected.status).toBe(200);
    currentCase = VerificationCaseDtoSchema.parse(rejected.body);
    expect(currentCase.status).toBe('submitted');
    expect((await api().post(path).set('Idempotency-Key', key).send(body)).body).toEqual(
      rejected.body,
    );
    expect(
      (
        await api()
          .post(path)
          .set('Idempotency-Key', key)
          .send({ ...body, comment: 'changed' })
      ).status,
    ).toBe(422);
    const returned = await decide(c.id, {
      decision: 'reject',
      comment: 'Correct PAN',
      expectedVersion: currentCase.version,
    });
    expect(returned.status).toBe(200);
    currentCase = VerificationCaseDtoSchema.parse(returned.body);
    as(U.salesA, 'sales');
    expect(JSON.stringify((await api().get(`/v1/verification-cases/${c.id}`)).body)).toContain(
      reason,
    );
    const fresh = await attach(c.id, 'clean');
    const replaced = await putDocument(
      c.id,
      'pan_vat_certificate',
      fresh.documentId,
      currentCase.version,
    );
    expect(replaced.status).toBe(200);
    currentCase = VerificationCaseDtoSchema.parse(replaced.body);
    expect(
      JSON.stringify((await api().get(`/v1/verification-cases/${c.id}/review-history`)).body),
    ).toContain(reason);
    const resubmitted = await api()
      .post(`/v1/verification-cases/${c.id}/submit`)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedVersion: currentCase.version });
    expect(resubmitted.status).toBe(200);
    currentCase = VerificationCaseDtoSchema.parse(resubmitted.body);
    expect(
      currentCase.checklist.filter((i) => i.documentId).every((i) => i.status === 'provided'),
    ).toBe(true);
    as(U.founder, 'founder');
    for (const itemKey of REQUIRED_KEYS) {
      const reviewed = await api()
        .post(`/v1/verification-cases/${c.id}/checklist/${itemKey}/decision`)
        .set('Idempotency-Key', randomUUID())
        .send({ decision: 'approve', expectedVersion: currentCase.version });
      expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
      currentCase = VerificationCaseDtoSchema.parse(reviewed.body);
    }
    expect(
      (
        await decide(c.id, {
          decision: 'approve',
          comment: 'All reviewed',
          expectedVersion: currentCase.version,
        })
      ).status,
    ).toBe(200);
  });
});

describe('document review boundaries', () => {
  it('requires bounded reasons, serializes competing rows and authorizes before retry', async () => {
    const c = await submittedCase();
    as(U.pmo, 'pmo');
    const path = `/v1/verification-cases/${c.id}/checklist/registration_certificate/decision`;
    for (const comment of ['', '   ', 'x'.repeat(2001)]) {
      expect(
        (
          await api()
            .post(path)
            .set('Idempotency-Key', randomUUID())
            .send({ decision: 'reject', comment, expectedVersion: c.version })
        ).status,
      ).toBe(400);
    }
    const key = randomUUID(),
      body = { decision: 'reject', comment: 'द'.repeat(2000), expectedVersion: c.version };
    const results = await Promise.all([
      api().post(path).set('Idempotency-Key', key).send(body),
      api()
        .post(`/v1/verification-cases/${c.id}/checklist/pan_vat_certificate/decision`)
        .set('Idempotency-Key', randomUUID())
        .send({ decision: 'approve', expectedVersion: c.version }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    if (results[0].status === 200) {
      as(U.salesB, 'sales');
      expect((await api().post(path).set('Idempotency-Key', key).send(body)).status).toBe(403);
    }
    const history = await ownerPool.query(
      'SELECT id FROM app.verification_review_events WHERE case_id=$1',
      [c.id],
    );
    expect(history.rows).toHaveLength(1);
    await expect(
      ownerPool.query('DELETE FROM app.verification_review_events WHERE case_id=$1', [c.id]),
    ).rejects.toThrow('immutable');
    as(U.salesB, 'sales');
    expect((await api().get(`/v1/verification-cases/${c.id}/review-history`)).status).toBe(404);
  });

  it('pins the newest version and refuses expiry-only correction of rejected evidence', async () => {
    const c = await openCase();
    const filled = await fillRequired(c);
    const old = filled.checklist.find((i) => i.key === 'pan_vat_certificate')!.documentId!;
    const v2 = await withTx(
      db,
      scope,
      { kind: 'user', id: current.userId, correlationId: 'new-version' },
      (tx) =>
        documents.createVersion(tx, old, {
          filename: 'new.pdf',
          declaredMime: 'application/pdf',
          sizeBytes: 10,
        }),
    );
    const submitted = await submitCase(c.id);
    expect(submitted.status).toBe(200);
    let currentCase = VerificationCaseDtoSchema.parse(submitted.body);
    expect(
      currentCase.checklist.find((i) => i.key === 'pan_vat_certificate')?.evidence
        ?.documentVersionId,
    ).toBe(v2.versionId);
    as(U.pmo, 'pmo');
    const path = `/v1/verification-cases/${c.id}/checklist/pan_vat_certificate/decision`;
    expect(
      (
        await api()
          .post(path)
          .set('Idempotency-Key', randomUUID())
          .send({ decision: 'approve', expectedVersion: currentCase.version })
      ).status,
    ).toBe(409);
    const rejected = await api().post(path).set('Idempotency-Key', randomUUID()).send({
      decision: 'reject',
      comment: 'Replace unreadable file',
      expectedVersion: currentCase.version,
    });
    expect(rejected.status).toBe(200);
    currentCase = VerificationCaseDtoSchema.parse(rejected.body);
    const returned = await decide(c.id, {
      decision: 'reject',
      comment: 'Correct evidence',
      expectedVersion: currentCase.version,
    });
    currentCase = VerificationCaseDtoSchema.parse(returned.body);
    as(U.founder, 'founder');
    const reattached = await putDocument(
      c.id,
      'pan_vat_certificate',
      old,
      currentCase.version,
      '2028-01-01',
    );
    expect(reattached.status).toBe(200);
    expect((await submitCase(c.id)).status).toBe(409);
  });

  it('atomically retires replaced infected optional evidence and permits absence after detach', async () => {
    let c = await fillRequired(await openCase());
    const infected = await attach(c.id, 'quarantined');
    c = VerificationCaseDtoSchema.parse(
      (await putDocument(c.id, 'other', infected.documentId, c.version)).body,
    );
    await scanFinds(infected.versionId, 'infected');
    const fresh = await attach(c.id, 'clean');
    c = VerificationCaseDtoSchema.parse(
      (await putDocument(c.id, 'other', fresh.documentId, c.version)).body,
    );
    expect(await documents.allClean(scope, 'verification_case', c.id)).toBe(true);
    const detached = await api()
      .delete(`/v1/verification-cases/${c.id}/checklist/other`)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedVersion: c.version });
    expect(detached.status).toBe(200);
    c = VerificationCaseDtoSchema.parse(detached.body);
    expect(c.checklist.find((i) => i.key === 'other')!.status).toBe('missing');
    const submitted = await submitCase(c.id);
    expect(submitted.status).toBe(200);
    as(U.pmo, 'pmo');
    c = await reviewAll(VerificationCaseDtoSchema.parse(submitted.body));
    expect(
      (
        await decide(c.id, {
          decision: 'approve',
          comment: 'Optional evidence absent',
          expectedVersion: c.version,
        })
      ).status,
    ).toBe(200);
  });
});

describe('document review activation', () => {
  it('rehearses rollback and restart without deciding a submitted case or inventing reviews', async () => {
    const c = await submittedCase();
    await withTx(db, scope, systemActor('legacy-fixture'), (tx) =>
      tx.execute(
        sql`UPDATE app.verification_cases SET review_policy='case_review_v0',review_round=0 WHERE id=${c.id}`,
      ),
    );
    const source = readFileSync(
      join(process.cwd(), '../../tools/db/activate-customer-document-review.sql'),
      'utf8',
    );
    const activation = (apply: boolean) =>
      source
        .replace(/:'tenant_id'/g, `'${scope.tenantId}'`)
        .replace(/:'organization_id'/g, `'${scope.organizationId}'`)
        .split('\n')
        .filter(
          (line) => !line.startsWith('\\') && !(apply ? line === 'ROLLBACK;' : line === 'COMMIT;'),
        )
        .join('\n');
    await ownerPool.query(activation(false));
    expect(
      (
        await ownerPool.query<{ review_policy: string }>(
          'SELECT review_policy FROM app.verification_cases WHERE id=$1',
          [c.id],
        )
      ).rows[0]?.review_policy,
    ).toBe('case_review_v0');
    await ownerPool.query(activation(true));
    const activated = await api().get(`/v1/verification-cases/${c.id}`);
    expect(activated.body).toMatchObject({
      status: 'submitted',
      reviewPolicy: 'document_review_v1',
      version: c.version + 1,
    });
    expect(
      VerificationCaseDtoSchema.parse(activated.body)
        .checklist.filter((i) => i.required)
        .every((i) => i.status === 'provided' && i.evidence),
    ).toBe(true);
    await ownerPool.query(activation(true));
    expect((await rawCase(c.id)).version).toBe(c.version + 1);
    expect(
      (
        await ownerPool.query<{ count: string }>(
          'SELECT count(*) FROM app.verification_review_events WHERE case_id=$1',
          [c.id],
        )
      ).rows[0]?.count,
    ).toBe('0');
  });
});

it('paginates equal-time journal decisions without duplicates and refuses malformed cursors', async () => {
  let c = await submittedCase();
  as(U.pmo, 'pmo');
  c = await reviewAll(c);
  const first = await api().get(`/v1/verification-cases/${c.id}/review-history?limit=2`);
  expect(first.status).toBe(200);
  const firstPage = VerificationReviewHistorySchema.parse(first.body);
  expect(firstPage.items).toHaveLength(2);
  const second = await api()
    .get(`/v1/verification-cases/${c.id}/review-history`)
    .query({ limit: 2, before: firstPage.nextCursor });
  expect(second.status).toBe(200);
  const secondPage = VerificationReviewHistorySchema.parse(second.body);
  expect(secondPage.items).toHaveLength(1);
  expect(new Set([...firstPage.items, ...secondPage.items].map((i) => i.id)).size).toBe(3);
  expect(secondPage.nextCursor).toBeNull();
  expect(
    (await api().get(`/v1/verification-cases/${c.id}/review-history?before=invalid`)).status,
  ).toBe(400);
  expect((await api().get(`/v1/verification-cases/${c.id}/review-history?limit=101`)).status).toBe(
    400,
  );
});

it('rechecks expiry after individual approvals before making the final decision', async () => {
  let c = await fillRequired(await openCase());
  const item = c.checklist.find((i) => i.key === 'registration_certificate')!;
  c = VerificationCaseDtoSchema.parse(
    (await putDocument(c.id, 'registration_certificate', item.documentId!, c.version, '2026-11-09'))
      .body,
  );
  c = VerificationCaseDtoSchema.parse((await submitCase(c.id)).body);
  as(U.pmo, 'pmo');
  c = await reviewAll(c);
  clock = new Date('2026-11-09T00:00:00Z');
  expect(
    (
      await decide(c.id, {
        decision: 'approve',
        comment: 'No stale expiry approval',
        expectedVersion: c.version,
      })
    ).status,
  ).toBe(409);
});

describe('evidence expiry uses the Kathmandu day, not the UTC day', () => {
  // 2026-11-19T20:30Z is 02:15 on 2026-11-20 in Kathmandu; the UTC date is still 2026-11-19.
  const KATHMANDU_EARLY_MORNING = new Date('2026-11-19T20:30:00Z');

  /** A filled case whose registration certificate expires on `expiresOn`. */
  async function caseExpiring(expiresOn: string) {
    const c = await fillRequired(await openCase());
    const item = c.checklist.find((i) => i.key === 'registration_certificate')!;
    const res = await putDocument(
      c.id,
      'registration_certificate',
      item.documentId!,
      c.version,
      expiresOn,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return VerificationCaseDtoSchema.parse(res.body);
  }

  it('refuses to submit evidence that expires today in Kathmandu and accepts tomorrow', async () => {
    clock = KATHMANDU_EARLY_MORNING;
    const today = await caseExpiring('2026-11-20');
    const refused = await submitCase(today.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { message: 'Evidence has expired' } });

    const tomorrow = await caseExpiring('2026-11-21');
    expect((await submitCase(tomorrow.id)).status).toBe(200);
  });

  it('refuses to approve a row whose evidence expires today in Kathmandu and accepts tomorrow', async () => {
    clock = new Date('2026-11-19T12:00:00Z');
    const submit = async (expiresOn: string) => {
      const res = await submitCase((await caseExpiring(expiresOn)).id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return VerificationCaseDtoSchema.parse(res.body);
    };
    const today = await submit('2026-11-20');
    const tomorrow = await submit('2026-11-21');
    as(U.pmo, 'pmo');
    clock = KATHMANDU_EARLY_MORNING;
    const approve = (c: VerificationCaseDto) =>
      api()
        .post(`/v1/verification-cases/${c.id}/checklist/registration_certificate/decision`)
        .set('Idempotency-Key', randomUUID())
        .send({ decision: 'approve', expectedVersion: c.version });
    const refused = await approve(today);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: { message: 'Evidence must be clean and unexpired' },
    });
    expect((await approve(tomorrow)).status).toBe(200);
  });

  it('reports a case whose evidence expires today in Kathmandu as not approvable, and tomorrow as approvable', async () => {
    clock = new Date('2026-11-19T12:00:00Z');
    const reviewed = async (expiresOn: string) => {
      const c = await caseExpiring(expiresOn);
      const res = await submitCase(c.id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      as(U.pmo, 'pmo');
      const done = await reviewAll(VerificationCaseDtoSchema.parse(res.body));
      as(U.founder, 'founder');
      return done;
    };
    const today = await reviewed('2026-11-20');
    const tomorrow = await reviewed('2026-11-21');
    as(U.pmo, 'pmo');
    clock = KATHMANDU_EARLY_MORNING;
    const blocked = async (c: VerificationCaseDto) =>
      (
        (await api().get(`/v1/verification-cases/${c.id}`)).body as {
          approvalBlockedReason?: unknown;
        }
      ).approvalBlockedReason;
    expect(await blocked(today)).toBe(
      'All active evidence must be readable, clean, unchanged and unexpired',
    );
    expect(await blocked(tomorrow)).toBeNull();
  });

  it('reopens an expired case emptying evidence that expires today in Kathmandu and keeping tomorrow', async () => {
    clock = KATHMANDU_EARLY_MORNING;
    const filled = await caseExpiring('2026-11-20');
    const pan = filled.checklist.find((i) => i.key === 'pan_vat_certificate')!;
    const res = await putDocument(
      filled.id,
      'pan_vat_certificate',
      pan.documentId!,
      filled.version,
      '2026-11-21',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx.execute(sql`UPDATE app.verification_cases SET status = 'expired' WHERE id = ${filled.id}`),
    );
    const reopened = await api().post('/v1/verification-cases').send({ partyId: filled.partyId });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    const dto = VerificationCaseDtoSchema.parse(reopened.body);
    expect(dto.checklist.find((i) => i.key === 'registration_certificate')).toMatchObject({
      status: 'missing',
      documentId: null,
    });
    expect(dto.checklist.find((i) => i.key === 'pan_vat_certificate')).toMatchObject({
      status: 'provided',
      expiresOn: '2026-11-21',
    });
  });
});

it('preserves real legacy case notes before correction and leaves legacy approved cases approved', async () => {
  const approved = await submittedCase();
  const rejected = await submittedCase();
  await withTx(db, scope, systemActor('legacy-history-fixture'), async (tx) => {
    for (const [id, status] of [
      [approved.id, 'approved'],
      [rejected.id, 'rejected'],
    ]) {
      await tx.execute(
        sql`UPDATE app.verification_cases SET status=${status},review_policy='case_review_v0',reviewer_user_id=${U.pmo},decided_at=${clock.toISOString()},reason='Original legacy decision' WHERE id=${id}`,
      );
    }
  });
  const unchanged = VerificationCaseDtoSchema.parse(
    (await api().get(`/v1/verification-cases/${approved.id}`)).body,
  );
  expect(unchanged.status).toBe('approved');
  expect(unchanged.reviewPolicy).toBe('case_review_v0');
  const document = await attach(rejected.id, 'clean');
  expect(
    (
      await putDocument(
        rejected.id,
        'registration_certificate',
        document.documentId,
        rejected.version,
      )
    ).status,
  ).toBe(200);
  const history = VerificationReviewHistorySchema.parse(
    (await api().get(`/v1/verification-cases/${rejected.id}/review-history`)).body,
  );
  expect(history.items).toHaveLength(1);
  expect(history.items[0]).toMatchObject({
    kind: 'legacy_case_decided',
    comment: 'Original legacy decision',
    reviewedBy: U.pmo,
    reviewedAt: clock.toISOString(),
    evidence: null,
  });
});

it('removes only loose files belonging to an editable case the caller owns', async () => {
  const mine = await openCase(await newCustomer(scope, U.salesA));
  const theirs = await openCase(await newCustomer(scope, U.salesB));
  const foreign = await attach(theirs.id, 'clean');
  as(U.salesA, 'sales');
  const loose = await attach(mine.id, 'infected');
  const attached = await attach(mine.id, 'clean');
  expect((await putDocument(mine.id, 'other', attached.documentId, mine.version)).status).toBe(200);
  const remove = (documentId: string) =>
    api().delete(`/v1/verification-cases/${mine.id}/loose-documents/${documentId}`);
  expect((await remove(foreign.documentId)).status).toBe(404);
  expect((await remove(attached.documentId)).status).toBe(409);
  as(U.salesB, 'sales');
  expect((await remove(loose.documentId)).status).toBe(404);
  as(U.salesA, 'sales');
  expect((await remove(loose.documentId)).status).toBe(204);
  expect(await documents.allClean(scope, 'verification_case', mine.id)).toBe(true);
});

describe('Can review names the pmo reviewer (audit #19)', () => {
  it('names a pmo user on a tenant with no stored grant rows, through the built-in defaults (R5 FU6)', async () => {
    const stored = await appPool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM app.role_permissions WHERE tenant_id = $1',
      [scope.tenantId],
    );
    expect(stored.rows[0]?.n, 'this test needs a tenant that has no role rows yet').toBe('0');
    const pmo = await createStaffUser(appPool, {
      ...scope,
      idpOrgId: staffIdpOrgId,
      roleKeys: ['pmo'],
    });
    const c = await submittedCase();
    const res = await api().get(`/v1/verification-cases/${c.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { rows } = await appPool.query<{ display_name: string }>(
      'SELECT display_name FROM app.users WHERE id = $1',
      [pmo.userId],
    );
    expect((res.body as { reviewerNames: string[] }).reviewerNames).toContain(
      rows[0]!.display_name,
    );
  });

  it('names a pmo user, who reads case files through verification.review, and not a read-only role', async () => {
    const pmo = await createStaffUser(appPool, {
      ...scope,
      idpOrgId: staffIdpOrgId,
      roleKeys: ['pmo'],
    });
    const reader = await createStaffUser(appPool, {
      ...scope,
      idpOrgId: staffIdpOrgId,
      roleKeys: ['operations_head'],
    });
    // The live role rows, as the seed writes them: pmo holds documents.read only at scope own.
    await withTx(db, scope, systemActor('test'), async (tx) => {
      for (const role of ['pmo', 'operations_head'] as const) {
        for (const [permission, s] of Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) {
          await tx.execute(
            sql`INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope)
                VALUES (${scope.tenantId}, ${role}, ${permission}, ${s})`,
          );
        }
      }
    });
    const nameOf = async (userId: string) => {
      const { rows } = await appPool.query<{ display_name: string }>(
        'SELECT display_name FROM app.users WHERE id = $1',
        [userId],
      );
      expect(rows[0]?.display_name).toBeTruthy();
      return rows[0]!.display_name;
    };

    const c = await submittedCase();
    const res = await api().get(`/v1/verification-cases/${c.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const names = (res.body as { reviewerNames: string[] }).reviewerNames;
    expect(names).toContain(await nameOf(pmo.userId));
    expect(names).not.toContain(await nameOf(reader.userId));
  });
});

describe('the own-scope case list is scoped in SQL, before its limit (audit #9)', () => {
  it('lists an older case of Sales A even when more than 500 newer cases belong to other customers', async () => {
    // Sales A's own customer and its case, opened long before the others.
    clock = new Date('2026-01-05T04:00:00Z');
    const mine = await openCase(await newCustomer(scope, U.salesA));

    // 501 newer cases on Sales B's customers: more than the list limit, all outside Sales A's scope.
    const tag = randomUUID().slice(0, 8);
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx.execute(sql`
        WITH p AS (
          INSERT INTO app.parties (id, tenant_id, kind, code, name)
          SELECT gen_random_uuid(), ${scope.tenantId}, 'customer', 'B' || ${tag} || '-' || g, 'Bulk ' || g
          FROM generate_series(1, 501) g
          RETURNING id
        ), c AS (
          INSERT INTO app.customers
              (id, tenant_id, number, legal_name, name_norm, owner_user_id, country, address_line, address_city)
          SELECT id, ${scope.tenantId}, 'CUS-' || id::text, 'Bulk Pvt. Ltd.', 'bulk', ${U.salesB}::uuid,
                 'NP', 'Durbar Marg 1', 'Kathmandu'
          FROM p
          RETURNING id
        )
        INSERT INTO app.verification_cases
          (tenant_id, party_id, party_kind, status, review_policy, checklist, created_at, updated_at)
        SELECT ${scope.tenantId}, id, 'customer', 'draft', 'document_review_v1', '[]'::jsonb,
               '2026-11-08T04:00:00Z'::timestamptz, '2026-11-08T04:00:00Z'::timestamptz
        FROM c
      `),
    );

    as(U.salesA, 'sales');
    const res = await api().get('/v1/verification-cases');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const items = VerificationCaseDtoSchema.array().parse(res.body);
    expect(items.map((c) => c.id)).toContain(mine.id);
    // No extra data: nothing of Sales B's customers reaches Sales A.
    const { rows: bulk } = await appPool.query<{ id: string }>(
      'SELECT id FROM app.parties WHERE code LIKE $1',
      [`B${tag}-%`],
    );
    expect(bulk).toHaveLength(501);
    const bulkIds = new Set(bulk.map((r) => r.id));
    expect(items.some((c) => bulkIds.has(c.partyId))).toBe(false);

    // Sales B (own scope) is paged and counted over their own cases only, never Sales A's.
    as(U.salesB, 'sales');
    const resB = await api().get('/v1/verification-cases?limit=100');
    expect(resB.status, JSON.stringify(resB.body)).toBe(200);
    const theirs = VerificationCaseDtoSchema.array().parse(resB.body);
    expect(theirs).toHaveLength(100);
    // At least the 501 bulk cases (earlier tests in this file also gave Sales B a few of their own).
    expect(Number(resB.headers['x-total-count'])).toBeGreaterThanOrEqual(501);
    expect(theirs.map((c) => c.id)).not.toContain(mine.id);
  });
});

describe('R6AE: a customer identity edit locks after approval and resets the review before it', () => {
  const customersService = () =>
    new CustomersService(
      db,
      new NumberingService(),
      authz as unknown as AuthzService,
      caller,
      new AuditService(db),
      () => clock,
      verificationService,
    );
  const customerVersion = async (id: string) =>
    (
      await ownerPool.query<{ version: number }>(
        'SELECT version FROM app.customers WHERE id = $1',
        [id],
      )
    ).rows[0]!.version;
  const getCase = async (id: string) =>
    VerificationCaseDtoSchema.parse((await api().get(`/v1/verification-cases/${id}`)).body);
  const resetAudit = async (partyId: string) =>
    (
      await ownerPool.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
        `SELECT before, after FROM audit.audit_events
          WHERE entity_id = $1 AND action = 'customer.verification_reset' ORDER BY id`,
        [partyId],
      )
    ).rows;
  const approvedCase = async () => {
    const partyId = await newCustomer();
    const submitted = await fillRequired(await openCase(partyId)).then((c) => submitCase(c.id));
    as(U.pmo, 'pmo');
    const reviewed = await reviewAll(VerificationCaseDtoSchema.parse(submitted.body));
    const done = await decide(reviewed.id, {
      decision: 'approve',
      comment: 'Checked every document',
      expectedVersion: reviewed.version,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    as(U.founder, 'founder');
    return { partyId, caseId: reviewed.id };
  };

  it('refuses a change of the legal name, PAN or country of a verified customer with customer_identity_locked', async () => {
    const { partyId, caseId } = await approvedCase();
    const version = await customerVersion(partyId);
    const attempts: Parameters<CustomersService['update']>[2][] = [
      { legalName: 'Renamed Ltd' },
      { panVatNo: '123456789' },
      { country: 'IN' },
    ];
    for (const fields of attempts) {
      const err = await customersService()
        .update(partyId, version, fields)
        .then(
          () => undefined,
          (e: unknown) => e as ConflictException,
        );
      expect(err, JSON.stringify(fields)).toBeInstanceOf(ConflictException);
      const response = err!.getResponse() as { code: string; message: string };
      expect(response.code).toBe('customer_identity_locked');
      expect(response.message).toMatch(/of a verified customer cannot be edited$/);
    }
    expect((await getCase(caseId)).status).toBe('approved');
    expect(await customerVersion(partyId)).toBe(version);
    // What is not identity still saves, and the same name sent again is not a change.
    const same = await customersService().update(partyId, version, {
      legalName: 'Acme Pvt. Ltd.',
      industry: 'Retail',
    });
    expect(same.industry).toBe('Retail');
    expect((await getCase(caseId)).status).toBe('approved');
  });

  it('resets a submitted case to an empty draft in a new review round when the identity changes', async () => {
    const partyId = await newCustomer();
    const filled = await fillRequired(await openCase(partyId));
    const submitted = VerificationCaseDtoSchema.parse((await submitCase(filled.id)).body);
    const oldDocs = submitted.checklist.flatMap((i) => i.documentId ?? []);
    expect(oldDocs).toHaveLength(3);
    const before = await customerVersion(partyId);
    const founder = await customersService().update(partyId, before, { legalName: 'Renamed Ltd' });
    expect(founder.legalName).toBe('Renamed Ltd');
    const c = await getCase(filled.id);
    expect(c.status).toBe('draft');
    expect(c.checklist.every((i) => i.status === 'missing' && i.documentId === null)).toBe(true);
    expect(c.reviewRound).toBe((submitted.reviewRound ?? 0) + 1);
    expect(c.identityReset?.by).toBe(U.founder);
    expect(typeof c.identityReset?.byName).toBe('string');
    expect([...(c.beforeChangeDocumentIds ?? [])].sort()).toEqual([...oldDocs].sort());
    // The files stay on the case as history.
    expect(c.looseEvidence?.map((v) => v.documentId).sort()).toEqual([...oldDocs].sort());
    const [audit] = await resetAudit(partyId);
    expect(audit?.before).toMatchObject({ legalName: 'Acme Pvt. Ltd.', country: 'NP' });
    expect(audit?.after).toMatchObject({ legalName: 'Renamed Ltd', country: 'NP' });
    // Submitting again needs every required document again.
    expect((await submitCase(filled.id)).status).toBe(409);
  });

  it('refuses a file from before the change on the checklist, and takes a new one', async () => {
    const partyId = await newCustomer();
    const filled = await fillRequired(await openCase(partyId));
    const oldDoc = filled.checklist.find((i) => i.key === 'registration_certificate')!.documentId!;
    await customersService().update(partyId, await customerVersion(partyId), {
      panVatNo: '123456789',
    });
    const reset = await getCase(filled.id);
    const reuse = await putDocument(filled.id, 'registration_certificate', oldDoc, reset.version);
    expect(reuse.status, JSON.stringify(reuse.body)).toBe(409);
    expect(ErrorBodySchema.parse(reuse.body).error.message).toMatch(/before the details changed/);
    const fresh = await attach(filled.id, 'clean');
    const ok = await putDocument(
      filled.id,
      'registration_certificate',
      fresh.documentId,
      reset.version,
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await getCase(filled.id);
    expect(after.beforeChangeDocumentIds).not.toContain(fresh.documentId);
    expect(after.beforeChangeDocumentIds).toContain(oldDoc);
  });

  it('writes nothing when the PATCH repeats the stored values, and leaves a draft with no file alone', async () => {
    const partyId = await newCustomer();
    const empty = await openCase(partyId);
    const version = await customerVersion(partyId);
    const same = await customersService().update(partyId, version, {
      legalName: 'Acme Pvt. Ltd.',
      country: 'NP',
    });
    expect(same.version).toBe(version);
    expect(await customerVersion(partyId)).toBe(version);
    // An identity change with nothing on the case resets nothing and writes no reset audit.
    await customersService().update(partyId, version, { legalName: 'Another Name Ltd' });
    const c = await getCase(empty.id);
    expect(c.version).toBe(empty.version);
    expect(c.identityReset ?? null).toBeNull();
    expect(await resetAudit(partyId)).toHaveLength(0);
  });

  it('stamps a draft that holds only an unattached file, and keeps that file as undeletable history', async () => {
    const partyId = await newCustomer();
    const draft = await openCase(partyId);
    const loose = await attach(draft.id, 'clean');
    await customersService().update(partyId, await customerVersion(partyId), {
      legalName: 'Third Name Ltd',
    });
    const c = await getCase(draft.id);
    expect(c.identityReset).not.toBeNull();
    expect(c.beforeChangeDocumentIds).toContain(loose.documentId);
    const reuse = await putDocument(
      draft.id,
      'registration_certificate',
      loose.documentId,
      c.version,
    );
    expect(reuse.status).toBe(409);
    const del = await api().delete(
      `/v1/verification-cases/${draft.id}/loose-documents/${loose.documentId}`,
    );
    expect(del.status, JSON.stringify(del.body)).toBe(409);
  });

  it('shows the reset only to the tenant that owns the case', async () => {
    const partyId = await newCustomer();
    const filled = await fillRequired(await openCase(partyId));
    await customersService().update(partyId, await customerVersion(partyId), {
      legalName: 'X Ltd',
    });
    expect((await getCase(filled.id)).identityReset).not.toBeNull();
    const other = await newCustomer(scope2);
    const foreignId = randomUUID();
    await withTx(db, scope2, systemActor('test'), (tx) =>
      tx.execute(
        sql`INSERT INTO app.verification_cases (id, tenant_id, party_id, party_kind, status, checklist, review_policy)
            VALUES (${foreignId}, ${scope2.tenantId}, ${other}, 'customer', 'draft', '[]'::jsonb, 'document_review_v1')`,
      ),
    );
    const res = await api().get(`/v1/verification-cases/${foreignId}`);
    expect(res.status).toBe(404);
  });
});
