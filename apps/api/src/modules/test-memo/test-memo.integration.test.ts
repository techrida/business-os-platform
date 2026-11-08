// Integration tests of the test memo on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations 0000-0007 as bos_owner, queries as bos_app, the controller behind the production body
// parser and error filter, TestMemoService, NumberingService, MoneyService, the real DocumentsService (for
// allClean) and the real ApprovalsService with the plan's test_memo workflow. Faked: audit, notify, the user
// directory, the request context, and authz.assert (which still runs the real pure can() on a fake principal,
// so the ResourceRef the memo builds is what decides 403, not a canned answer).
// Run: pnpm --filter @bos/api exec vitest run src/modules/test-memo
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  MemoDtoSchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  approvalSteps,
  checkTenancy,
  documentVersions,
  organizations,
  runMigrations,
  tenants,
  testMemos,
  users,
} from '@bos/db';
import { fiscalYearOf } from '@bos/locale';
import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
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
let customerOrgId: string;
let vendorOrgId: string;
let now = new Date('2026-11-08T04:00:00Z');

// Users that own memos need an app.users row (foreign key). Approvers only appear in the fake directory.
const U = {
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
/** Who is calling: `as()` switches it. Sales hold memo permissions with scope `own`; founder holds `all`. */
const current: { userId: string; grants: Map<Permission, Scope> } = {
  userId: U.salesA,
  grants: grantsOf('sales'),
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

  // One tenant with a staff org (owns the memos), a customer org and a vendor org (ADR 0017 trigger).
  const [tenant] = await db.insert(tenants).values({}).returning({ id: tenants.id });
  if (tenant === undefined) throw new Error('no tenant');
  const staffOrgId = randomUUID();
  customerOrgId = randomUUID();
  vendorOrgId = randomUUID();
  scope = { tenantId: tenant.id, organizationId: staffOrgId };
  await withTx(db, scope, systemActor('test'), async (tx) => {
    for (const [id, kind] of [
      [staffOrgId, 'staff'],
      [customerOrgId, 'customer'],
      [vendorOrgId, 'vendor'],
    ] as const) {
      await tx.insert(organizations).values({
        id,
        tenantId: tenant.id,
        organizationId: id,
        kind,
        name: `Test ${kind} org`,
        zitadelOrgId: `zitadel-${id}`,
      });
    }
    for (const id of [U.salesA, U.salesB, U.boss]) {
      await tx
        .insert(users)
        .values({ id, ...scope, zitadelUserId: `z-${id}`, status: 'active' as const });
    }
  });

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
        await tx
          .update(documentVersions)
          .set({ status, updatedAt: new Date() })
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

  it('only lets a memo name a customer-kind organization as its customer (assert_org_kind)', async () => {
    const insert = (customerOrganizationId: string | null) =>
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
          customerOrganizationId,
        }),
      );
    await expect(insert(customerOrgId)).resolves.toBeDefined();
    await expect(insert(null)).resolves.toBeDefined();
    // The staff org and the vendor org exist but have the wrong kind.
    await expect(insert(scope.organizationId)).rejects.toThrow(/customer/);
    await expect(insert(vendorOrgId)).rejects.toThrow(/customer/);
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
      customerOrganizationId: null,
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

  it('answers 403 for another sales user (scope own), 404 for an unknown id, 400 for a bad id', async () => {
    const { id } = await createMemo();
    as(U.salesB, 'sales');
    const res = await request(baseUrl).get(`/v1/test-memos/${id}`);
    expect(res.status).toBe(403);
    expect(ErrorBodySchema.parse(res.body).error).toMatchObject({
      code: 'forbidden',
      reason: 'out_of_scope',
    });
    as(U.boss, 'founder');
    expect((await request(baseUrl).get(`/v1/test-memos/${randomUUID()}`)).status).toBe(404);
    expect((await request(baseUrl).get('/v1/test-memos/not-a-uuid')).status).toBe(400);
    // Founder holds memo.read with scope all, so the same memo opens.
    expect((await request(baseUrl).get(`/v1/test-memos/${id}`)).status).toBe(200);
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

  it('answers 403 to a non-owner and leaves the memo untouched', async () => {
    const { id } = await createMemo();
    as(U.salesB, 'sales');
    const res = await request(baseUrl).patch(`/v1/test-memos/${id}`).send({ title: 'Hijack' });
    expect(res.status).toBe(403);
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

  it('answers 403 to a non-owner and does not submit', async () => {
    const { id } = await createMemo();
    as(U.salesB, 'sales');
    expect((await submitMemo(id)).status).toBe(403);
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
