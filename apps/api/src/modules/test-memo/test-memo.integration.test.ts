// Integration tests of the test memo on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations 0000-0007 as bos_owner, queries as bos_app, the controller behind the production body
// parser and error filter, TestMemoService, NumberingService, MoneyService, the real DocumentsService (for
// allClean) and the real ApprovalsService with the plan's test_memo workflow. Faked: audit, notify, the user
// directory, the request context, and authz.assert (which still runs the real pure can() on a fake principal,
// so the ResourceRef the memo builds is what decides 403 or 404, not a canned answer).
// Run: pnpm --filter @bos/api exec vitest run src/modules/test-memo
import 'reflect-metadata';

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  MemoDtoSchema,
  MemoDirectorySchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  approvalRequests,
  approvalSteps,
  checkTenancy,
  createParty,
  createDepartment,
  createPortalUser,
  createStaffUser,
  createTenantWithEntity,
  documentVersions,
  runMigrations,
  testMemos,
  users,
} from '@bos/db';
import { fiscalYearOf } from '@bos/locale';
import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { CAN_KEY } from '../../platform/authz/decorators';
import { can } from '../../platform/authz/can';
import type { AuthzService } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SignedLinks } from '../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../platform/documents/storage.adapter';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { MoneyService } from '../../platform/settings/money.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import { ApprovalsAdminService } from '../approvals/admin.service';
import { ApprovalsService } from '../approvals/requests.service';
import { TestMemoController } from './test-memo.controller';
import { TestMemoService } from './test-memo.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const SECRET = 'an-integration-test-secret-of-32-plus-chars';

// The plan's section 6.2 workflow, written the way the seed writes it.
const seedSpec = {
  documentType: 'test_memo',
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: 'Base route: accountant checks the memo',
    },
    { id: 'finance', kind: 'role', role: 'finance', reason: 'Base route: finance approves' },
  ],
  rules: [
    {
      id: 'over-1-lakh',
      when: { field: 'amountNpr', op: 'gt', value: '100000' },
      add: { id: 'management', kind: 'role', role: 'management', reason: 'Management approval' },
      position: 'end',
      reason: 'Management approval because NPR equivalent exceeds 1,00,000',
    },
    {
      id: 'over-10-lakh',
      when: { field: 'amountNpr', op: 'gt', value: '1000000' },
      add: { id: 'founder', kind: 'role', role: 'founder', reason: 'Founder approval' },
      position: 'end',
      reason: 'Founder approval because NPR equivalent exceeds 10,00,000',
    },
  ],
};

let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
let storageRoot: string;
let service: TestMemoService;
let documents: DocumentsService;
let approvals: ApprovalsService;
let scope: { tenantId: string; organizationId: string };
/** The staff IdP org of the tenant: every staff principal below logs in through it. */
let staffIdpOrgId: string;
/** Two customer parties (P1, P2) and a vendor party, each with its portal IdP org (ADR 0027). */
let p1: { partyId: string; idpOrgId: string; userId: string };
let p2: { partyId: string; idpOrgId: string; userId: string };
let vendorPartyId: string;
let now = new Date('2026-11-08T04:00:00Z');

// Users that own memos need an app.users row (foreign key): beforeAll replaces salesA, salesB and boss with the
// ids createStaffUser returns. Approvers only appear in the fake directory.
const U: Record<'salesA' | 'salesB' | 'boss' | 'acc' | 'fin' | 'mgmt' | 'founder', string> = {
  salesA: randomUUID(),
  salesB: randomUUID(),
  boss: randomUUID(),
  acc: randomUUID(),
  fin: randomUUID(),
  mgmt: randomUUID(),
  founder: randomUUID(),
};
const roles: Partial<Record<RoleKey, string[]>> = {};
const resetRoles = () => {
  roles.accountant = [U.acc];
  roles.finance = [U.fin];
  roles.management = [U.mgmt];
  roles.founder = [U.founder];
};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
/**
 * Who is calling: `as()` switches to a staff user, `asCustomer()` to a portal user of a customer party. Sales hold
 * memo permissions with scope `own`; founder holds `all`.
 */
const current: {
  userId: string;
  grants: Map<Permission, Scope>;
  orgKind: Principal['orgKind'];
  partyId: string | null;
  idpOrgId: string | null;
} = {
  userId: U.salesA,
  grants: grantsOf('sales'),
  orgKind: 'staff',
  partyId: null,
  idpOrgId: null,
};
const as = (userId: string, role: RoleKey) => {
  current.userId = userId;
  current.grants = grantsOf(role);
  current.orgKind = 'staff';
  current.partyId = null;
  current.idpOrgId = null;
};
/** customer_user has no default grants, so the portal caller gets `memo.read` at `customer_org` here. */
const asCustomer = (party: { partyId: string; idpOrgId: string; userId: string }) => {
  current.userId = party.userId;
  current.grants = new Map<Permission, Scope>([['memo.read', 'customer_org']]);
  current.orgKind = 'customer';
  current.partyId = party.partyId;
  current.idpOrgId = party.idpOrgId;
};

/** The token's roles match the mirror's (the fake directory): act() checks a role step against the token. */
const rolesOf = (id: string) =>
  (Object.keys(roles) as RoleKey[]).filter((r) => roles[r]?.includes(id) === true);

const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  ...scope,
  orgKind: current.orgKind,
  partyId: current.partyId,
  idpOrgId: current.idpOrgId ?? staffIdpOrgId,
  roles: rolesOf(current.userId),
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
const audit = { record: vi.fn(() => Promise.resolve(undefined)) };
const notify = {
  notifyUser: vi.fn(() => Promise.resolve(undefined)),
  notifyRole: vi.fn(() => Promise.resolve(undefined)),
  nudge: vi.fn(() => Promise.resolve(undefined)),
};
const directory = {
  userIdsWithRole: vi.fn((_s: unknown, role: RoleKey) => Promise.resolve(roles[role] ?? [])),
  resolve: vi.fn(),
  emailOf: vi.fn(),
};

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

  // One tenant with its default legal entity (owns the memos), two customer parties and a vendor party, each
  // with a portal user (ADR 0027): the memo's customer is a party, never an organization.
  const tenant = await createTenantWithEntity(appPool);
  staffIdpOrgId = tenant.idpOrgId;
  scope = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  const customer = async () => {
    const party = await createParty(appPool, { tenantId: tenant.tenantId, kind: 'customer' });
    const { userId } = await createPortalUser(appPool, {
      tenantId: tenant.tenantId,
      idpOrgId: party.idpOrgId,
    });
    return { ...party, userId };
  };
  p1 = await customer();
  p2 = await customer();
  vendorPartyId = (await createParty(appPool, { tenantId: tenant.tenantId, kind: 'vendor' }))
    .partyId;
  for (const key of ['salesA', 'salesB', 'boss', 'acc', 'fin', 'mgmt', 'founder'] as const) {
    U[key] = (await createStaffUser(appPool, { ...scope, idpOrgId: tenant.idpOrgId })).userId;
  }

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-memo-it-'));
  documents = new DocumentsService(
    db,
    new DiskStorageAdapter(storageRoot),
    new SignedLinks(SECRET, { claim: () => Promise.resolve(true) }),
    { add: vi.fn().mockResolvedValue({}) } as unknown as Queue,
    authz,
    audit,
  );
  approvals = new ApprovalsService(db, audit, notify, directory, caller, () => now);
  const money = new MoneyService(db);
  service = new TestMemoService(
    db,
    new NumberingService(),
    money,
    documents,
    approvals,
    authz as unknown as AuthzService,
    caller,
    () => now,
    notify as never,
  );
  // onModuleInit (owner policy for attachments and the approval subject) runs when the Nest app below starts.

  // The published workflow and one INR rate, entered as the founder would.
  resetRoles();
  as(U.boss, 'founder');
  const adminSvc = new ApprovalsAdminService(db, audit, caller, () => now);
  await adminSvc.createWorkflow({ key: 'test_memo', name: 'Test memo', spec: seedSpec });
  await adminSvc.publish('test_memo', 1);
  await withTx(db, scope, systemActor('test'), (tx) =>
    money.setRate(tx, 'USD', '133.5', '2026-11-01', 'manual'),
  );

  const moduleRef = await Test.createTestingModule({
    controllers: [TestMemoController],
    providers: [{ provide: TestMemoService, useValue: service }],
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
  resetRoles();
  now = new Date('2026-11-08T04:00:00Z');
  as(U.salesA, 'sales');
});

// ---------------------------------------------------------------------------------------- helpers

const draftBody = (over: Record<string, unknown> = {}) => ({
  title: 'Office chairs',
  body: 'Twelve chairs for the new desk row',
  amount: '50000.00',
  currency: 'NPR',
  ...over,
});

async function createMemo(over: Record<string, unknown> = {}): Promise<{ id: string }> {
  const res = await request(baseUrl).post('/v1/test-memos').send(draftBody(over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string };
}

const submitMemo = (id: string) => request(baseUrl).post(`/v1/test-memos/${id}/submit`);

/** The sha256 a clean attachment gets in `attach`: derived from the version id, so a test can predict it. */
const shaOf = (versionId: string) => createHash('sha256').update(versionId).digest();

const requestRow = async (requestId: string) => {
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, requestId));
  return row!;
};

/** An attachment of the memo in the given scan status, made through the real DocumentsService. */
async function attach(memoId: string, status: 'quarantined' | 'clean' | 'infected') {
  return withTx(
    db,
    scope,
    { kind: 'user', id: current.userId, correlationId: 'test-corr' },
    async (tx) => {
      const created = await documents.create(tx, {
        ownerType: 'test_memo',
        ownerId: memoId,
        filename: 'quote.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: 10,
      });
      await tx
        .update(documentVersions)
        .set({ status: 'quarantined', updatedAt: new Date() })
        .where(eq(documentVersions.id, created.versionId));
      if (status !== 'quarantined') {
        // A real scan stores the hash and the sniffed type with the verdict; the snapshot freezes both.
        await tx
          .update(documentVersions)
          .set({
            status,
            sha256: shaOf(created.versionId),
            detectedMime: 'application/pdf',
            updatedAt: new Date(),
          })
          .where(eq(documentVersions.id, created.versionId));
      }
      return created;
    },
  );
}

const statusOf = async (id: string) => {
  const [row] = await db.select().from(testMemos).where(eq(testMemos.id, id));
  return row!;
};

// ------------------------------------------------------------------------------------------- tests

describe('migration 0007', () => {
  it('passes check-tenancy and has the audit trigger', async () => {
    const violations = await checkTenancy(ownerPool);
    expect(violations.filter((v) => v.table === 'app.test_memos')).toEqual([]);
    const { rows } = await ownerPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_trigger
        WHERE tgrelid = 'app.test_memos'::regclass AND tgname = 'audit_capture'`,
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('only lets a memo name a customer party of its tenant as its customer (test_memos_customer_party_fk)', async () => {
    const insert = (customerPartyId: string | null) =>
      withTx(db, scope, systemActor('test'), (tx) =>
        tx.insert(testMemos).values({
          ...scope,
          number: `RAW-${randomUUID()}`,
          title: 'raw',
          body: '',
          amount: '1.00',
          currency: 'NPR',
          amountNpr: '1.00',
          fxRate: '1',
          fxSource: 'NPR',
          fxDate: '2026-11-08',
          ownerUserId: U.salesA,
          customerPartyId,
        }),
      );
    /** The constraint that refused the insert; Drizzle wraps the pg error in `cause`. */
    const refusedBy = async (customerPartyId: string) => {
      const error: unknown = await insert(customerPartyId).then(
        () => undefined,
        (e: unknown) => e,
      );
      const pgError = (error as { cause?: unknown } | undefined)?.cause ?? error;
      return (pgError as { constraint?: string } | undefined)?.constraint;
    };
    await expect(insert(p1.partyId)).resolves.toBeDefined();
    await expect(insert(null)).resolves.toBeDefined();
    // A vendor party has the wrong kind; the legal entity and a random id are not parties at all.
    for (const wrong of [vendorPartyId, scope.organizationId, randomUUID()]) {
      expect(await refusedBy(wrong)).toBe('test_memos_customer_party_fk');
    }
  });
});

describe('route metadata', () => {
  it('names a permission on every route', () => {
    const permissionOf = (name: keyof TestMemoController) =>
      Reflect.getMetadata(CAN_KEY, TestMemoController.prototype[name]) as string;
    expect(permissionOf('create')).toBe('memo.create');
    expect(permissionOf('get')).toBe('memo.read');
    expect(permissionOf('update')).toBe('memo.update');
    expect(permissionOf('submit')).toBe('memo.update');
  });
});

describe('POST /v1/test-memos', () => {
  it('creates a draft numbered MEMO-<fy>-00001 with the NPR snapshot, then 00002', async () => {
    const fy = fiscalYearOf(now);
    const first = await request(baseUrl).post('/v1/test-memos').send(draftBody());
    expect(first.status).toBe(201);
    const memo = MemoDtoSchema.parse(first.body);
    // First numbered memo of the file: tests run in order, and nothing before this takes a number.
    expect(memo.number).toBe(`MEMO-${fy}-00001`);
    expect(memo).toMatchObject({
      status: 'draft',
      version: 1,
      amount: '50000.00',
      currency: 'NPR',
      amountNpr: '50000.00',
      fxRate: '1',
      fxSource: 'NPR',
      fxDate: '2026-11-08',
      ownerUserId: U.salesA,
      departmentId: null,
      customerPartyId: null,
      editorUserIds: [],
    });
    const second = MemoDtoSchema.parse(
      (await request(baseUrl).post('/v1/test-memos').send(draftBody())).body,
    );
    expect(Number(second.number.slice(-5))).toBe(Number(memo.number.slice(-5)) + 1);
  });

  it('converts a foreign amount at the latest rate on or before the day', async () => {
    const res = await request(baseUrl)
      .post('/v1/test-memos')
      .send(draftBody({ amount: '100.00', currency: 'USD' }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      amountNpr: '13350.00',
      fxRate: '133.5',
      fxSource: 'manual',
      fxDate: '2026-11-01',
    });
  });

  it('answers 400 for a negative amount and 409 when the currency has no rate', async () => {
    expect(
      (
        await request(baseUrl)
          .post('/v1/test-memos')
          .send(draftBody({ amount: '-1' }))
      ).status,
    ).toBe(400);
    const noRate = await request(baseUrl)
      .post('/v1/test-memos')
      .send(draftBody({ currency: 'INR' }));
    expect(noRate.status).toBe(409);
  });
});

describe('GET /v1/test-memos/:id', () => {
  it('returns the memo with attachments and no approval before the first submit', async () => {
    const { id } = await createMemo();
    await attach(id, 'quarantined');
    const res = await request(baseUrl).get(`/v1/test-memos/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, approval: null });
    expect((res.body as { attachments: unknown[] }).attachments).toHaveLength(1);
    expect(res.body).toHaveProperty('attachments.0.status', 'quarantined');
  });

  it('answers 404 for another sales user (scope own) and for an unknown id, 400 for a bad id', async () => {
    const { id } = await createMemo();
    as(U.salesB, 'sales');
    const res = await request(baseUrl).get(`/v1/test-memos/${id}`);
    expect(res.status).toBe(404);
    expect(ErrorBodySchema.parse(res.body).error).toMatchObject({ code: 'not_found' });
    as(U.boss, 'founder');
    expect((await request(baseUrl).get(`/v1/test-memos/${randomUUID()}`)).status).toBe(404);
    expect((await request(baseUrl).get('/v1/test-memos/not-a-uuid')).status).toBe(400);
    // Founder holds memo.read with scope all, so the same memo opens.
    expect((await request(baseUrl).get(`/v1/test-memos/${id}`)).status).toBe(200);
  });
});

describe('the customer of a memo is a party (ADR 0027 section 5)', () => {
  it('lets staff name the customer by party id when they create a memo', async () => {
    const res = await request(baseUrl)
      .post('/v1/test-memos')
      .send(draftBody({ customerPartyId: p1.partyId }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(MemoDtoSchema.parse(res.body).customerPartyId).toBe(p1.partyId);
    expect((await statusOf((res.body as { id: string }).id)).customerPartyId).toBe(p1.partyId);
  });

  it('answers 400, not 500, when staff name a vendor, an entity or an unknown id as the customer', async () => {
    for (const wrong of [vendorPartyId, scope.organizationId, randomUUID()]) {
      const res = await request(baseUrl)
        .post('/v1/test-memos')
        .send(draftBody({ customerPartyId: wrong }));
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body).toMatchObject({ error: { code: 'bad_request' } });
    }
  });

  it('shows a customer of party P1 only the memos of the acting entity that name P1; P2 gets 404, not 403', async () => {
    const forP1 = await createMemo({ customerPartyId: p1.partyId });
    const forP2 = await createMemo({ customerPartyId: p2.partyId });
    const internal = await createMemo();
    // A memo of a second legal entity of the same tenant that also names P1: the portal acts in the default
    // entity, so it must not see it. No fixture makes a second entity yet, hence the raw insert.
    const otherEntity = randomUUID();
    const otherScope = { tenantId: scope.tenantId, organizationId: otherEntity };
    const elsewhere = await withTx(db, otherScope, systemActor('test'), async (tx) => {
      await tx.execute(
        sql`INSERT INTO app.organizations (id, tenant_id, organization_id, code, name, legal_name, is_default)
            VALUES (${otherEntity}, ${scope.tenantId}, ${otherEntity}, 'E2', 'Entity two', 'Entity two', false)`,
      );
      const [row] = await tx
        .insert(testMemos)
        .values({
          ...otherScope,
          number: `RAW-${randomUUID()}`,
          title: 'other entity',
          body: '',
          amount: '1.00',
          currency: 'NPR',
          amountNpr: '1.00',
          fxRate: '1',
          fxSource: 'NPR',
          fxDate: '2026-11-08',
          ownerUserId: U.salesA,
          customerPartyId: p1.partyId,
        })
        .returning({ id: testMemos.id });
      return row!;
    });

    asCustomer(p1);
    const own = await request(baseUrl).get(`/v1/test-memos/${forP1.id}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body).toMatchObject({ id: forP1.id, customerPartyId: p1.partyId });

    const answer = async (id: string) => {
      const res = await request(baseUrl).get(`/v1/test-memos/${id}`);
      const { code, message, reason } = ErrorBodySchema.parse(res.body).error;
      return { status: res.status, code, message, reason };
    };
    const unknown = await answer(randomUUID());
    expect(unknown).toMatchObject({ status: 404, code: 'not_found' });
    // P2's memo, an internal memo and P1's memo in another entity all look like an unknown id.
    for (const id of [forP2.id, internal.id, elsewhere.id]) {
      expect(await answer(id)).toEqual(unknown);
    }

    asCustomer(p2);
    expect((await request(baseUrl).get(`/v1/test-memos/${forP2.id}`)).status).toBe(200);
    expect(await answer(forP1.id)).toEqual(unknown);
  });
});

describe('PATCH /v1/test-memos/:id', () => {
  it('lets the owner edit a draft, bumps the version and re-freezes the NPR value', async () => {
    const { id } = await createMemo();
    const res = await request(baseUrl)
      .patch(`/v1/test-memos/${id}`)
      .send({ title: 'Office chairs (12)', amount: '100.00', currency: 'USD' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      title: 'Office chairs (12)',
      amountNpr: '13350.00',
      fxRate: '133.5',
      version: 2,
      status: 'draft',
      editorUserIds: [U.salesA],
    });
  });

  it('keeps the rate when only the title changes', async () => {
    const { id } = await createMemo();
    const res = await request(baseUrl).patch(`/v1/test-memos/${id}`).send({ title: 'Renamed' });
    expect(res.body).toMatchObject({ title: 'Renamed', fxDate: '2026-11-08', version: 2 });
  });

  it('answers 404 to a non-owner and leaves the memo untouched', async () => {
    const { id } = await createMemo();
    as(U.salesB, 'sales');
    const res = await request(baseUrl).patch(`/v1/test-memos/${id}`).send({ title: 'Hijack' });
    expect(res.status).toBe(404);
    const row = await statusOf(id);
    expect(row).toMatchObject({ title: 'Office chairs', version: 1 });
  });

  it('answers 400 for an empty body or an unknown field', async () => {
    const { id } = await createMemo();
    expect((await request(baseUrl).patch(`/v1/test-memos/${id}`).send({})).status).toBe(400);
    expect(
      (await request(baseUrl).patch(`/v1/test-memos/${id}`).send({ status: 'approved' })).status,
    ).toBe(400);
  });

  it('answers 409 once the memo is submitted', async () => {
    const { id } = await createMemo();
    expect((await submitMemo(id)).status).toBe(200);
    const res = await request(baseUrl).patch(`/v1/test-memos/${id}`).send({ title: 'Too late' });
    expect(res.status).toBe(409);
    expect(ErrorBodySchema.parse(res.body).error.code).toBe('conflict');
  });
});

describe('POST /v1/test-memos/:id/submit', () => {
  it('answers 409 "attachments are not all clean" while an attachment is quarantined or infected', async () => {
    const { id } = await createMemo();
    await attach(id, 'quarantined');
    const res = await submitMemo(id);
    expect(res.status).toBe(409);
    expect(ErrorBodySchema.parse(res.body).error).toMatchObject({
      code: 'conflict',
      message: 'attachments are not all clean',
    });
    expect((await statusOf(id)).status).toBe('draft');
    await attach(id, 'infected');
    expect((await submitMemo(id)).status).toBe(409);
    expect(notify.nudge).not.toHaveBeenCalled();
  });

  it('routes NPR 50,000 through 2 steps and returns pending', async () => {
    const { id } = await createMemo();
    await attach(id, 'clean');
    const res = await submitMemo(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'pending' });
    const { requestId } = res.body as { requestId: string };
    const steps = await db
      .select()
      .from(approvalSteps)
      .where(eq(approvalSteps.requestId, requestId));
    expect(steps.map((s) => s.roleKey).sort()).toEqual(['accountant', 'finance']);
    const row = await statusOf(id);
    expect(row).toMatchObject({ status: 'submitted', version: 2 });
    expect(notify.nudge).toHaveBeenCalledTimes(1);

    const detail = await request(baseUrl).get(`/v1/test-memos/${id}`);
    expect(detail.body).toMatchObject({
      approval: { requestId, status: 'pending' },
      status: 'submitted',
    });
  });

  it('adds management above NPR 1,00,000 and founder above NPR 10,00,000', async () => {
    const steps = async (amount: string) => {
      const { id } = await createMemo({ amount });
      const { requestId } = (await submitMemo(id)).body as { requestId: string };
      return (await db.select().from(approvalSteps).where(eq(approvalSteps.requestId, requestId)))
        .sort((a, b) => a.seq - b.seq)
        .map((s) => s.roleKey);
    };
    expect(await steps('250000.00')).toEqual(['accountant', 'finance', 'management']);
    expect(await steps('2000000.00')).toEqual(['accountant', 'finance', 'management', 'founder']);
  });

  it('answers 409 for a second submit of the same memo', async () => {
    const { id } = await createMemo();
    expect((await submitMemo(id)).status).toBe(200);
    expect((await submitMemo(id)).status).toBe(409);
  });

  it('answers 404 to a non-owner and does not submit', async () => {
    const { id } = await createMemo();
    as(U.salesB, 'sales');
    expect((await submitMemo(id)).status).toBe(404);
    expect((await statusOf(id)).status).toBe('draft');
  });

  it('returns blocked when the requester is the only accountant', async () => {
    roles.accountant = [U.salesA];
    const { id } = await createMemo();
    const res = await submitMemo(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'blocked' });
    expect((await statusOf(id)).status).toBe('submitted');
  });

  it('keeps an editor out of the approvers (editors join the owner in sod_user_ids)', async () => {
    roles.accountant = [U.boss];
    const { id } = await createMemo();
    as(U.boss, 'founder');
    expect(
      (await request(baseUrl).patch(`/v1/test-memos/${id}`).send({ body: 'edited' })).status,
    ).toBe(200);
    const res = await submitMemo(id);
    expect(res.body).toMatchObject({ status: 'blocked' });
  });
});

describe('onDecided', () => {
  const approveAll = async (requestId: string, who: string[]) => {
    let version = 1;
    for (const user of who) {
      as(user, 'founder');
      const dto = await approvals.act(
        requestId,
        { action: 'approve', expectedVersion: version },
        randomUUID(),
      );
      version = dto.version;
    }
  };

  it('sets the memo to approved and bumps its version when the last step approves', async () => {
    const { id } = await createMemo();
    const { requestId } = (await submitMemo(id)).body as { requestId: string };
    await approveAll(requestId, [U.acc, U.fin]);
    expect(await statusOf(id)).toMatchObject({ status: 'approved', version: 3 });
  });

  it('sets the memo to rejected, and to returned so it can be edited and submitted again', async () => {
    const rejected = await createMemo();
    const r1 = (await submitMemo(rejected.id)).body as { requestId: string };
    as(U.acc, 'founder');
    await approvals.act(
      r1.requestId,
      { action: 'reject', comment: 'no budget', expectedVersion: 1 },
      randomUUID(),
    );
    expect((await statusOf(rejected.id)).status).toBe('rejected');

    // Back to the author: a memo's owner must be an app.users row, and the approver has none.
    as(U.salesA, 'sales');
    const { id } = await createMemo();
    const r2 = (await submitMemo(id)).body as { requestId: string };
    as(U.acc, 'founder');
    await approvals.act(
      r2.requestId,
      { action: 'return', comment: 'add a quote', expectedVersion: 1 },
      randomUUID(),
    );
    expect(await statusOf(id)).toMatchObject({ status: 'returned', version: 3 });

    as(U.salesA, 'sales');
    expect(
      (await request(baseUrl).patch(`/v1/test-memos/${id}`).send({ body: 'quote attached' }))
        .status,
    ).toBe(200);
    const again = await submitMemo(id);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((again.body as { requestId: string }).requestId).not.toBe(r2.requestId);
    expect((await statusOf(id)).status).toBe('submitted');
    // Same clock for both submits: GET must still show the new open request, not the returned one.
    const detail = await request(baseUrl).get(`/v1/test-memos/${id}`);
    expect(detail.body).toMatchObject({
      approval: { requestId: (again.body as { requestId: string }).requestId, status: 'pending' },
    });
  });

  it('refuses to record an outcome for a memo that is not submitted, and rolls back', async () => {
    const { id } = await createMemo();
    const onDecided = (outcome: 'approved') =>
      withTx(db, scope, systemActor('test'), (tx) =>
        // The registered subject is the only way to reach onDecided; go through the approvals service.
        (
          approvals as unknown as {
            subjects: Map<
              string,
              { onDecided: (tx: unknown, id: string, o: string) => Promise<void> }
            >;
          }
        ).subjects
          .get('test_memo')!
          .onDecided(tx, id, outcome),
      );
    await expect(onDecided('approved')).rejects.toMatchObject({ status: 409 });
    expect((await statusOf(id)).status).toBe('draft');
  });
});

// ------------------------------------------------------------------------------------ review fixes

describe('submit freezes the attachments (R1)', () => {
  type Policy = { canAttach?: (s: typeof scope, ownerId: string) => Promise<boolean> };
  const policy = () =>
    (documents as unknown as { owners: Map<string, Policy> }).owners.get('test_memo')!;

  it('lists exactly the clean version in the request snapshot', async () => {
    const { id } = await createMemo();
    const file = await attach(id, 'clean');
    const res = await submitMemo(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const req = await requestRow((res.body as { requestId: string }).requestId);
    expect((req.snapshot as { attachments?: unknown }).attachments).toEqual([
      {
        documentId: file.documentId,
        versionId: file.versionId,
        filename: 'quote.pdf',
        sha256: shaOf(file.versionId).toString('hex'),
        detectedMime: 'application/pdf',
      },
    ]);
  });

  it('refuses new attachments through the owner policy once the memo is submitted', async () => {
    const { id } = await createMemo();
    expect(policy().canAttach).toBeTypeOf('function');
    await expect(policy().canAttach!(scope, id)).resolves.toBe(true);
    expect((await submitMemo(id)).status).toBe(200);
    await expect(policy().canAttach!(scope, id)).resolves.toBe(false);
    await expect(policy().canAttach!(scope, randomUUID())).resolves.toBe(false);
  });
});

describe('submitter and uploaders join separation of duties (R9)', () => {
  const approveAs = async (user: string, requestId: string, expectedVersion: number) => {
    as(user, 'founder');
    return approvals.act(requestId, { action: 'approve', expectedVersion }, randomUUID());
  };
  const sodRefusal = { status: 403, response: { reason: 'separation_of_duties' } };

  it('refuses the founder who submitted a sales memo of NPR 20,00,000 without editing it', async () => {
    roles.founder = [U.boss, U.founder];
    const { id } = await createMemo({ amount: '2000000.00' });
    as(U.boss, 'founder');
    const res = await submitMemo(id);
    expect(res.body).toMatchObject({ status: 'pending' });
    const { requestId } = res.body as { requestId: string };
    expect((await requestRow(requestId)).sodUserIds).toContain(U.boss);
    let version = 1;
    for (const user of [U.acc, U.fin, U.mgmt]) {
      version = (await approveAs(user, requestId, version)).version;
    }
    await expect(approveAs(U.boss, requestId, version)).rejects.toMatchObject(sodRefusal);
  });

  it('refuses the founder who uploaded a file to the sales draft that sales then submitted', async () => {
    roles.accountant = [U.boss, U.acc];
    const { id } = await createMemo();
    as(U.boss, 'founder');
    await attach(id, 'clean');
    as(U.salesA, 'sales');
    const res = await submitMemo(id);
    expect(res.body).toMatchObject({ status: 'pending' });
    const { requestId } = res.body as { requestId: string };
    expect((await requestRow(requestId)).sodUserIds).toContain(U.boss);
    await expect(approveAs(U.boss, requestId, 1)).rejects.toMatchObject(sodRefusal);
  });
});

describe('submit re-freezes the NPR value (R11)', () => {
  it('converts at the submit day rate and routes on that value', async () => {
    const money = new MoneyService(db);
    // Days after every other test's clock, so these rates change no other memo.
    await withTx(db, scope, systemActor('test'), (tx) =>
      money.setRate(tx, 'USD', '133', '2026-11-20', 'manual'),
    );
    now = new Date('2026-11-20T04:00:00Z');
    const memo = await createMemo({ amount: '750.00', currency: 'USD' });
    expect(memo).toMatchObject({ amountNpr: '99750.00', fxRate: '133' });

    await withTx(db, scope, systemActor('test'), (tx) =>
      money.setRate(tx, 'USD', '134', '2026-11-21', 'manual'),
    );
    now = new Date('2026-11-21T04:00:00Z');
    const res = await submitMemo(memo.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { requestId } = res.body as { requestId: string };
    const req = await requestRow(requestId);
    expect(req.facts).toEqual({ amountNpr: '100500.00' });
    expect(req.snapshot).toMatchObject({
      amountNpr: '100500.00',
      fxRate: '134',
      fxDate: '2026-11-21',
    });
    const steps = await db
      .select()
      .from(approvalSteps)
      .where(eq(approvalSteps.requestId, requestId));
    expect(steps.map((s) => s.roleKey)).toContain('management');
    expect(await statusOf(memo.id)).toMatchObject({
      amountNpr: '100500.00',
      fxDate: '2026-11-21',
      status: 'submitted',
    });
  });
});

describe('a memo out of scope looks like an unknown id (R23)', () => {
  it('answers get, update and submit exactly as for a random id', async () => {
    const { id } = await createMemo();
    as(U.salesB, 'sales');
    const calls: [string, (memoId: string) => request.Test][] = [
      ['get', (memoId) => request(baseUrl).get(`/v1/test-memos/${memoId}`)],
      [
        'update',
        (memoId) => request(baseUrl).patch(`/v1/test-memos/${memoId}`).send({ title: 'x' }),
      ],
      ['submit', submitMemo],
    ];
    for (const [name, call] of calls) {
      const answer = async (memoId: string) => {
        const res = await call(memoId);
        const { code, message, reason } = ErrorBodySchema.parse(res.body).error;
        return { name, status: res.status, code, message, reason };
      };
      const outOfScope = await answer(id);
      expect(outOfScope).toEqual(await answer(randomUUID()));
      expect(outOfScope.status).toBe(404);
    }
    expect(await statusOf(id)).toMatchObject({
      status: 'draft',
      version: 1,
      title: 'Office chairs',
    });
  });
});

describe('internal memo template', () => {
  it('returns only the active company directory and snapshots authoritative staff metadata', async () => {
    const dept = await createDepartment(appPool, scope);
    const machine = await createStaffUser(appPool, { ...scope, idpOrgId: staffIdpOrgId });
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx
        .update(users)
        .set({ email: null, displayName: 'Service account' })
        .where(eq(users.id, machine.userId)),
    );
    const directory = await request(baseUrl).get('/v1/test-memos/directory');
    expect(directory.status).toBe(200);
    expect(
      MemoDirectorySchema.parse(directory.body).people.some((p) => p.userId === machine.userId),
    ).toBe(false);
    expect(MemoDirectorySchema.parse(directory.body).currentUserId).toBe(U.salesA);
    expect(
      MemoDirectorySchema.parse(directory.body).people.some(
        (p: { userId: string }) => p.userId === p1.userId,
      ),
    ).toBe(false);
    const template = {
      departmentId: dept.departmentId,
      date: '2026-11-10',
      closing: 'Submitted for approval.',
      preparedByUserId: U.salesA,
      recommenderUserIds: [U.acc],
      approvedByUserId: U.fin,
    };
    const created = await request(baseUrl).post('/v1/test-memos').send(draftBody({ template }));
    expect(created.status).toBe(201);
    expect(MemoDtoSchema.parse(created.body).template).toMatchObject({
      departmentId: dept.departmentId,
      preparedBy: { userId: U.salesA },
      approvedBy: { userId: U.fin },
    });
    expect(MemoDtoSchema.parse(created.body).template!.preparedBy.jobTitle).toBeNull();
    const reopened = await request(baseUrl).get(
      `/v1/test-memos/${MemoDtoSchema.parse(created.body).id}`,
    );
    expect(MemoDtoSchema.parse(reopened.body).template).toEqual(
      MemoDtoSchema.parse(created.body).template,
    );
    const submitted = await submitMemo(MemoDtoSchema.parse(created.body).id);
    expect(submitted.status).toBe(200);
    const rows = await ownerPool.query<{ snapshot: { template: unknown } }>(
      'SELECT snapshot FROM app.approval_requests WHERE id = $1',
      [(submitted.body as { requestId: string }).requestId],
    );
    expect(rows.rows[0]!.snapshot.template).toEqual(MemoDtoSchema.parse(created.body).template);
    const requestId = (submitted.body as { requestId: string }).requestId;
    roles.accountant = [U.acc, U.boss];
    as(U.boss, 'founder');
    await expect(
      approvals.act(requestId, { action: 'approve', expectedVersion: 1 }, randomUUID()),
    ).rejects.toThrow('different person');
    as(U.acc, 'founder');
    const first = await approvals.act(
      requestId,
      { action: 'approve', expectedVersion: 1 },
      randomUUID(),
    );
    as(U.fin, 'founder');
    await approvals.act(
      requestId,
      { action: 'approve', expectedVersion: first.version },
      randomUUID(),
    );
    as(U.salesA, 'sales');
    expect(
      MemoDtoSchema.parse(
        (await request(baseUrl).get(`/v1/test-memos/${MemoDtoSchema.parse(created.body).id}`)).body,
      ).status,
    ).toBe('approved');
  });

  it('rejects spoofed prepared attribution, foreign staff IDs, and duplicate signers', async () => {
    const dept = await createDepartment(appPool, scope);
    const template = {
      departmentId: dept.departmentId,
      date: '2026-11-10',
      closing: '',
      preparedByUserId: U.salesA,
      recommenderUserIds: [U.acc],
      approvedByUserId: U.fin,
    };
    expect(
      (
        await request(baseUrl)
          .post('/v1/test-memos')
          .send(draftBody({ template: { ...template, preparedByUserId: U.salesB } }))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(baseUrl)
          .post('/v1/test-memos')
          .send(draftBody({ template: { ...template, approvedByUserId: p1.userId } }))
      ).status,
    ).toBe(400);
    expect(
      (
        await request(baseUrl)
          .post('/v1/test-memos')
          .send(draftBody({ template: { ...template, approvedByUserId: U.acc } }))
      ).status,
    ).toBe(400);
  });

  it('refuses a printed approver who does not match the workflow step', async () => {
    const dept = await createDepartment(appPool, scope);
    const created = await request(baseUrl)
      .post('/v1/test-memos')
      .send(
        draftBody({
          template: {
            departmentId: dept.departmentId,
            date: '2026-11-10',
            closing: '',
            preparedByUserId: U.salesA,
            recommenderUserIds: [U.fin],
            approvedByUserId: U.acc,
          },
        }),
      );
    expect(created.status).toBe(201);
    expect((await submitMemo(MemoDtoSchema.parse(created.body).id)).status).toBe(409);
    expect(
      MemoDtoSchema.parse(
        (await request(baseUrl).get(`/v1/test-memos/${MemoDtoSchema.parse(created.body).id}`)).body,
      ).status,
    ).toBe('draft');
  });
});
