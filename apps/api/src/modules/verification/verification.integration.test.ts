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
  runMigrations,
} from '@bos/db';
import { ConflictException, ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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
import type { AuthzService } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SignedLinks } from '../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../platform/documents/storage.adapter';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const SECRET = 'an-integration-test-secret-of-32-plus-chars';
const ADDRESS = JSON.stringify({ line1: 'Durbar Marg 1', city: 'Kathmandu', country: 'NP' });
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

let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
let storageRoot: string;
let documents: DocumentsService;
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
const authz = {
  assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
    const d = can(principalNow(), action, ref);
    if (!d.allowed) {
      throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: d.reason });
    }
  },
};
const documentsAudit = { record: vi.fn(() => Promise.resolve(undefined)) };

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const admin0 = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin0.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin0.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin0.query('CREATE DATABASE bos OWNER bos_owner');
  await admin0.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();
  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  ownerPool = new Pool({ connectionString: urlFor('bos_owner', OWNER_PW, 'bos'), max: 2 });
  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 6 });
  db = drizzle({ client: appPool });

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
  await container?.stop();
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
      sql`INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, owner_user_id, address)
          VALUES (${partyId}, ${s.tenantId}, ${`CUS-${partyId.slice(0, 8)}`}, 'Acme Pvt. Ltd.', 'acme',
                  ${ownerUserId}, ${ADDRESS}::jsonb)`,
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
            updatedAt: new Date(),
          })
          .where(eq(documentVersions.id, created.versionId));
      }
      return created;
    },
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

/** Every required item gets its own document in `status`; returns the case after the last change. */
async function fillRequired(
  c: VerificationCaseDto,
  status: 'quarantined' | 'clean' | 'infected' = 'clean',
): Promise<VerificationCaseDto> {
  let dto = c;
  for (const key of REQUIRED_KEYS) {
    const doc = await attach(dto.id, status);
    const res = await putDocument(dto.id, key, doc.documentId, dto.version);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    dto = VerificationCaseDtoSchema.parse(res.body);
  }
  return dto;
}

const submitCase = (id: string) => api().post(`/v1/verification-cases/${id}/submit`);
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
    );
    const customer = await customers.create(
      {
        legalName: 'Normal form customer',
        relationship: 'prospect',
        address: { line1: 'Durbar Marg 1', city: 'Kathmandu', country: 'NP' },
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

describe('POST /v1/verification-cases/:id/submit', () => {
  it('is 409 while a required item has no document', async () => {
    const c = await openCase();
    const res = await submitCase(c.id);
    expect(res.status).toBe(409);
    expect(ErrorBodySchema.parse(res.body).error.message).toContain('registration_certificate');
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
  it('runs the flow draft -> submit -> approve, and every write leaves a domain event', async () => {
    const submitted = await submittedCase();
    as(U.pmo, 'pmo');
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
      'verification.approved',
    ]);
    // An approved case is frozen.
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
            updatedAt: new Date(),
          })
          .where(eq(documentVersions.id, v.id));
      }
    });
    expect((await decide(submitted.id, body)).status).toBe(200);
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
    expect(ErrorBodySchema.parse(approve.body).error.message).toContain('pan_vat_certificate');
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
    const submitted = await submittedCase();
    as(U.pmo, 'pmo');
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
