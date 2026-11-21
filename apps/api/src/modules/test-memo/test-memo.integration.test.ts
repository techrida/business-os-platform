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
  MemoListSchema,
  type Permission,
  type RoleKey,
  RoutePlanSchema,
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
  departments,
  documentVersions,
  rolePermissions,
  testMemos,
  userEntities,
  users,
} from '@bos/db';
import { fiscalYearOf } from '@bos/locale';
import { ForbiddenException, NotFoundException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../../platform/authz/decorators';
import { can } from '../../platform/authz/can';
import { scopeWhereFor, type AuthzService } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SignedLinks } from '../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../platform/documents/storage.adapter';
import { RoleCache } from '../../platform/authz/role-cache';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { MoneyService } from '../../platform/settings/money.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import { ApprovalsAdminService } from '../approvals/admin.service';
import { asSecondPerson, SKIP_LIVE_PUBLISHER_CHECK } from '../../../test/support/second-person';
import { ApprovalsController } from '../approvals/approvals.controller';
import { ApprovalsService } from '../approvals/requests.service';
import { TestMemoController } from './test-memo.controller';
import { TestMemoService } from './test-memo.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

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

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
let storageRoot: string;
let service: TestMemoService;
let settingsService: SettingsService;
let documents: DocumentsService;
let roleCache: RoleCache;
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
  roles.sales = [U.salesA, U.salesB];
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
  departmentId: string | null;
} = {
  userId: U.salesA,
  grants: grantsOf('sales'),
  orgKind: 'staff',
  partyId: null,
  idpOrgId: null,
  departmentId: null,
};
const as = (userId: string, role: RoleKey) => {
  current.userId = userId;
  current.grants = grantsOf(role);
  current.orgKind = 'staff';
  current.partyId = null;
  current.idpOrgId = null;
  current.departmentId = null;
};
/** customer_user has no default grants, so the portal caller gets `memo.read` at `customer_org` here. */
const asCustomer = (party: { partyId: string; idpOrgId: string; userId: string }) => {
  current.userId = party.userId;
  current.grants = new Map<Permission, Scope>([['memo.read', 'customer_org']]);
  current.orgKind = 'customer';
  current.partyId = party.partyId;
  current.idpOrgId = party.idpOrgId;
  current.departmentId = null;
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
  departmentId: current.departmentId,
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
  // The real SQL twin of can(): the list test proves the memo list and the record check agree.
  scopeWhere: (table: Parameters<typeof scopeWhereFor>[1], action: Permission) =>
    scopeWhereFor(principalNow(), table, action),
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

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 6 });
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
  // The user_roles mirror gives each user the roles the signer-eligibility check reads (the fake directory above
  // is only for the approvals engine's role steps).
  const mirror: Record<keyof typeof U, RoleKey[]> = {
    salesA: ['sales'],
    salesB: ['sales'],
    boss: ['founder'],
    acc: ['accountant'],
    fin: ['finance'],
    mgmt: ['management'],
    founder: ['founder'],
  };
  for (const key of Object.keys(mirror) as (keyof typeof U)[]) {
    U[key] = (
      await createStaffUser(appPool, {
        ...scope,
        idpOrgId: tenant.idpOrgId,
        roleKeys: mirror[key],
      })
    ).userId;
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
  settingsService = new SettingsService(db);
  const money = new MoneyService(db, settingsService);
  // The real cache over the real role_permissions table (empty here, so the defaults), as the route guard reads it.
  roleCache = new RoleCache(db);
  service = new TestMemoService(
    db,
    new NumberingService(),
    money,
    documents,
    approvals,
    authz as unknown as AuthzService,
    roleCache,
    caller,
    () => now,
    settingsService,
    notify as never,
  );
  // onModuleInit (owner policy for attachments and the approval subject) runs when the Nest app below starts.

  // The published workflow and one INR rate, entered as the founder would.
  resetRoles();
  as(U.boss, 'founder');
  const adminSvc = new ApprovalsAdminService(db, audit, caller, () => now);
  const adminSvcPublisher = new ApprovalsAdminService(db, audit, asSecondPerson(caller), () => now);
  await adminSvc.createWorkflow({ key: 'test_memo', name: 'Test memo', spec: seedSpec });
  await adminSvcPublisher.publish('test_memo', 1, SKIP_LIVE_PUBLISHER_CHECK);
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
  await testDb?.drop();
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

/** A template memo body the way the Workspace sends it from P2: no amount, no currency. */
const templateMemoBody = (
  template: Record<string, unknown>,
  over: Record<string, unknown> = {},
) => ({
  title: 'Office chairs',
  body: 'Twelve chairs for the new desk row',
  template,
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

/** The users of a request's steps, in order (explicit-route requests name a user on every step). */
const userStepsOf = async (requestId: string) =>
  (await db.select().from(approvalSteps).where(eq(approvalSteps.requestId, requestId)))
    .sort((a, b) => a.seq - b.seq)
    .map((s) => s.userId);

const statusOf = async (id: string) => {
  const [row] = await db.select().from(testMemos).where(eq(testMemos.id, id));
  return row!;
};

/** How many Memo approver versions this file has saved: each publish adds the next one (F1-Q9). */
let memoApproverVersions = 0;
/** Saves `spec` as the next Memo approver version as the founder and publishes it as a second person. */
async function publishMemoApprover(spec: unknown): Promise<void> {
  as(U.boss, 'founder');
  const editor = new ApprovalsAdminService(db, audit, caller, () => now);
  if (memoApproverVersions === 0) {
    await editor.createWorkflow({ key: 'memo_approver', name: 'Memo approver', spec });
  } else {
    await editor.addVersion('memo_approver', spec);
  }
  memoApproverVersions += 1;
  await new ApprovalsAdminService(db, audit, asSecondPerson(caller), () => now).publish(
    'memo_approver',
    memoApproverVersions,
    SKIP_LIVE_PUBLISHER_CHECK,
  );
  as(U.salesA, 'sales');
}

let memoSignersGroup: string | undefined;
/**
 * The tests below that are about something other than who may approve name signers freely: the Memo approver
 * workflow becomes one group step holding `people`, so each of them may sign "Approved by".
 */
async function memoSignersAre(people: readonly string[]): Promise<void> {
  as(U.boss, 'founder');
  const admin = new ApprovalsAdminService(db, audit, caller, () => now);
  memoSignersGroup ??= (await admin.createGroup({ key: 'memo-signers', name: 'Memo signers' })).id;
  for (const userId of people) await admin.addMember(memoSignersGroup, userId);
  await publishMemoApprover({
    documentType: 'memo_approver',
    steps: [
      { id: 'approver', kind: 'group', group: 'memo-signers', reason: 'A memo signer approves' },
    ],
    rules: [],
  });
}

/** Puts the memo author's membership in `departmentId` (null: no department) for the length of `fn`. */
async function inDepartment<T>(departmentId: string | null, fn: () => Promise<T>): Promise<T> {
  const setDepartment = (id: string | null) =>
    withTx(db, scope, systemActor('test'), (tx) =>
      tx.update(userEntities).set({ departmentId: id }).where(eq(userEntities.userId, U.salesA)),
    );
  await setDepartment(departmentId);
  try {
    return await fn();
  } finally {
    await setDepartment(null);
  }
}

/** A department of the entity with `headUserId` as its head (null: no head). */
async function departmentHeadedBy(headUserId: string | null): Promise<string> {
  const { departmentId } = await createDepartment(appPool, scope);
  await withTx(db, scope, systemActor('test'), (tx) =>
    tx.update(departments).set({ headUserId }).where(eq(departments.id, departmentId)),
  );
  return departmentId;
}

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

  it('prints numbering.memo_prefix on new numbers without resetting or forking the series', async () => {
    const fy = fiscalYearOf(now);
    const setPrefix = (prefix: string) =>
      withTx(db, scope, systemActor('test'), (tx) =>
        settingsService.set(tx, 'numbering.memo_prefix', prefix),
      );
    const create = async () =>
      MemoDtoSchema.parse((await request(baseUrl).post('/v1/test-memos').send(draftBody())).body);
    const seqOf = (number: string) => Number(number.slice(-5));
    // No setting written yet: the default MEMO prints exactly what the series printed before the setting existed.
    const before = await create();
    expect(before.number).toMatch(new RegExp(`^MEMO-${fy.replace('/', '\\/')}-\\d{5}$`));
    try {
      await setPrefix('NOTE');
      const renamed = await create();
      expect(renamed.number).toBe(
        `NOTE-${fy}-${String(seqOf(before.number) + 1).padStart(5, '0')}`,
      );
      await setPrefix('MEMO');
      const back = await create();
      expect(back.number).toBe(`MEMO-${fy}-${String(seqOf(before.number) + 2).padStart(5, '0')}`);
      // Numbers already issued keep the prefix they were stored with.
      expect((await statusOf(before.id)).number).toBe(before.number);
      expect((await statusOf(renamed.id)).number).toBe(renamed.number);
      // One counter row: the prefix is presentation only, the series key stays MEMO.
      // Read as the app role inside the entity's transaction, the way NumberingService itself reads the row.
      const { rows } = await withTx(db, scope, systemActor('test'), (tx) =>
        tx.execute<{ key: string; n: string }>(sql`
          SELECT key, count(*)::text AS n FROM app.number_series
           WHERE tenant_id = ${scope.tenantId}::uuid AND organization_id = ${scope.organizationId}::uuid
             AND key IN ('MEMO', 'NOTE')
           GROUP BY key`),
      );
      expect(rows).toEqual([{ key: 'MEMO', n: '1' }]);
    } finally {
      await setPrefix('MEMO');
    }
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
    // Broad read scope does not reveal a private draft.
    expect((await request(baseUrl).get(`/v1/test-memos/${id}`)).status).toBe(404);
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

    await submitMemo(forP1.id);
    await submitMemo(forP2.id);
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
  it('keeps a newer saved version when a stale tab edits or submits', async () => {
    const { id } = await createMemo();
    const newer = await request(baseUrl)
      .patch(`/v1/test-memos/${id}`)
      .send({ title: 'Newer version', expectedVersion: 1 });
    expect(newer.status).toBe(200);

    const staleEdit = await request(baseUrl)
      .patch(`/v1/test-memos/${id}`)
      .send({ title: 'Stale version', expectedVersion: 1 });
    expect(staleEdit.status).toBe(409);
    const staleSubmit = await request(baseUrl)
      .post(`/v1/test-memos/${id}/submit`)
      .send({ expectedVersion: 1 });
    expect(staleSubmit.status).toBe(409);
    for (const result of [staleEdit, staleSubmit]) {
      expect(result.body).toMatchObject({ error: { reason: 'stale_memo' } });
    }
    const memo = await request(baseUrl).get(`/v1/test-memos/${id}`);
    expect(memo.body).toMatchObject({ title: 'Newer version', status: 'draft', version: 2 });
  });

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
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx
        .update(testMemos)
        .set({ editorUserIds: [U.boss] })
        .where(eq(testMemos.id, id)),
    );
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

  it('refuses a broad-scope founder submitting another account’s draft', async () => {
    const { id } = await createMemo();
    as(U.boss, 'founder');
    expect((await submitMemo(id)).status).toBe(404);
  });

  it('refuses the founder who uploaded a file to the sales draft that sales then submitted', async () => {
    roles.accountant = [U.boss, U.acc];
    const { id } = await createMemo();
    const attachment = await attach(id, 'clean');
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx
        .update(documentVersions)
        .set({ uploadedBy: U.boss })
        .where(eq(documentVersions.id, attachment.versionId)),
    );
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
    const money = new MoneyService(db, new SettingsService(db));
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

describe('the Memo approver: who may sign "Approved by" (F1-Q9)', () => {
  // Runs before any other template memo is submitted: until then the entity has no published Memo approver
  // workflow, so the first tests read the built-in rule (the one the seed publishes).
  const memoFor = async (departmentId: string, approvedByUserId: string) => {
    const res = await request(baseUrl)
      .post('/v1/test-memos')
      .send(
        templateMemoBody({
          departmentId,
          date: '2026-11-12',
          closing: '',
          preparedByUserId: U.salesA,
          recommenderUserIds: [],
          approvedByUserId,
        }),
      );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return MemoDtoSchema.parse(res.body).id;
  };
  const ruleNow = async () =>
    MemoDirectorySchema.parse((await request(baseUrl).get('/v1/test-memos/directory')).body)
      .approverRule;

  it("defaults to the head of the author's department, with no workflow published", async () => {
    const dept = await departmentHeadedBy(U.mgmt);
    await inDepartment(dept, async () => {
      const rule = await ruleNow();
      expect(rule).toMatchObject({
        basis: 'department_head',
        departmentId: dept,
        eligibleUserIds: [U.mgmt],
        defaultUserId: U.mgmt,
      });
      expect(rule?.blockReason).toBeUndefined();

      // The memo's own page carries the same rule for its owner.
      const wrong = await memoFor(dept, U.fin);
      const detail = (await request(baseUrl).get(`/v1/test-memos/${wrong}`)).body as {
        approverRule?: unknown;
      };
      expect(detail.approverRule).toEqual(rule);

      // Anyone else in "Approved by" is shown blocked before submit and refused at submit, in the same words.
      const preview = RoutePlanSchema.parse(
        (await request(baseUrl).get(`/v1/test-memos/${wrong}/route`)).body,
      );
      expect(preview.blocked).toBe(true);
      expect(preview.steps.at(-1)?.blocked).toBe(true);
      expect(preview.blockReason).toMatch(/cannot approve this memo.*the head of/);
      const refused = await submitMemo(wrong);
      expect(refused.status).toBe(409);
      expect(ErrorBodySchema.parse(refused.body).error.message).toBe(preview.blockReason);
      expect((await statusOf(wrong)).status).toBe('draft');

      const right = await memoFor(dept, U.mgmt);
      const submitted = await submitMemo(right);
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      expect(await userStepsOf((submitted.body as { requestId: string }).requestId)).toEqual([
        U.mgmt,
      ]);
    });
  });

  it('falls back to the Founder, and says so, when the department has no head or the author has none', async () => {
    const headless = await departmentHeadedBy(null);
    for (const departmentId of [headless, null]) {
      await inDepartment(departmentId, async () => {
        expect(await ruleNow()).toMatchObject({
          basis: 'fallback',
          departmentId,
          roleKey: 'founder',
          eligibleUserIds: [U.founder],
          defaultUserId: U.founder,
        });
      });
    }
    await inDepartment(headless, async () => {
      const id = await memoFor(headless, U.founder);
      expect((await submitMemo(id)).status).toBe(200);
    });
  });

  it('treats a head who cannot decide approvals as no head: the Founder approves, and the form says why', async () => {
    // Sales holds no approvals.requests.act (nor do the seeded operations and sales heads), so a sales head cannot sign.
    const dept = await departmentHeadedBy(U.salesB);
    await inDepartment(dept, async () => {
      expect(await ruleNow()).toMatchObject({
        basis: 'fallback',
        headCannotApprove: true,
        roleKey: 'founder',
        eligibleUserIds: [U.founder],
        defaultUserId: U.founder,
      });
      const head = await memoFor(dept, U.salesB);
      expect((await submitMemo(head)).status).toBe(409);
      const founder = await memoFor(dept, U.founder);
      expect((await submitMemo(founder)).status).toBe(200);

      // With nobody in the fallback role either, the rule is a dead end that names its fix, and submit refuses it.
      roles.founder = [];
      const rule = await ruleNow();
      expect(rule).toMatchObject({ eligibleUserIds: [], defaultUserId: null });
      expect(rule?.blockReason).toMatch(
        /Nobody in the Founder role can approve this memo, and the head of .* cannot decide approvals/,
      );
      const id = await memoFor(dept, U.fin);
      const refused = await submitMemo(id);
      expect(refused.status).toBe(409);
      expect(ErrorBodySchema.parse(refused.body).error.message).toBe(rule?.blockReason);
    });
  });

  it('follows the published Memo approver workflow instead of the built-in rule', async () => {
    await publishMemoApprover({
      documentType: 'memo_approver',
      steps: [
        { id: 'approver', kind: 'role', role: 'management', reason: 'Management approves memos' },
      ],
      rules: [],
    });
    const dept = await departmentHeadedBy(U.founder);
    await inDepartment(dept, async () => {
      expect(await ruleNow()).toMatchObject({
        basis: 'workflow',
        roleKey: 'management',
        eligibleUserIds: [U.mgmt],
        defaultUserId: U.mgmt,
      });
      const id = await memoFor(dept, U.founder);
      const refused = await submitMemo(id);
      expect(refused.status).toBe(409);
      expect(ErrorBodySchema.parse(refused.body).error.message).toMatch(
        /cannot approve this memo.*someone in the Management role/,
      );
    });
  });

  it('refuses a Memo approver workflow that says more than who approves', async () => {
    as(U.boss, 'founder');
    const admin = new ApprovalsAdminService(db, audit, caller, () => now);
    await expect(
      admin.addVersion('memo_approver', {
        documentType: 'memo_approver',
        steps: [
          { id: 'one', kind: 'role', role: 'management', reason: 'Management' },
          { id: 'two', kind: 'role', role: 'founder', reason: 'Founder' },
        ],
        rules: [],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('internal memo template', () => {
  beforeAll(() => memoSignersAre([U.acc, U.fin]));
  it('returns a selectable signer with a blank mirrored name as "Unnamed user", never an email fragment', async () => {
    const staff = await createStaffUser(appPool, { ...scope, idpOrgId: staffIdpOrgId });
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx
        .update(users)
        .set({ displayName: ' ', email: 'accounts.desk@example.test' })
        .where(eq(users.id, staff.userId)),
    );
    const directory = await request(baseUrl).get('/v1/test-memos/directory').expect(200);
    const person = MemoDirectorySchema.parse(directory.body).people.find(
      (p) => p.userId === staff.userId,
    );
    expect(person?.name).toBe('Unnamed user');
    expect(person?.avatarDocumentId).toBeNull();
  });

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
    const created = await request(baseUrl).post('/v1/test-memos').send(templateMemoBody(template));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // No money was sent, so the table's NOT NULL columns hold the NPR 0.00 compatibility value.
    expect(created.body).toMatchObject({
      amount: '0.00',
      currency: 'NPR',
      fxRate: '1',
      fxSource: 'NPR',
    });
    expect(Number((created.body as { amountNpr: string }).amountNpr)).toBe(0);
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
    // Submit freezes the letterhead onto the template; the draft carries none (the directory shows it live).
    const frozen = rows.rows[0]!.snapshot.template as { letterhead?: { primaryColour?: string } };
    expect(typeof frozen.letterhead?.primaryColour).toBe('string');
    const { letterhead: _frozenLetterhead, ...withoutLetterhead } = frozen as Record<
      string,
      unknown
    >;
    expect(withoutLetterhead).toEqual(MemoDtoSchema.parse(created.body).template);
    const requestId = (submitted.body as { requestId: string }).requestId;
    // Someone who is not the named person for the active step is refused, whatever role they hold.
    as(U.boss, 'founder');
    await expect(
      approvals.act(requestId, { action: 'approve', expectedVersion: 1 }, randomUUID()),
    ).rejects.toBeInstanceOf(ForbiddenException);
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

  it('no longer ties the signers to the workflow roles: finance may recommend and the accountant approve', async () => {
    const dept = await createDepartment(appPool, scope);
    const created = await request(baseUrl)
      .post('/v1/test-memos')
      .send(
        templateMemoBody({
          departmentId: dept.departmentId,
          date: '2026-11-10',
          closing: '',
          preparedByUserId: U.salesA,
          recommenderUserIds: [U.fin],
          approvedByUserId: U.acc,
        }),
      );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = MemoDtoSchema.parse(created.body).id;
    const submitted = await submitMemo(id);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(await userStepsOf((submitted.body as { requestId: string }).requestId)).toEqual([
      U.fin,
      U.acc,
    ]);
    expect((await statusOf(id)).status).toBe('submitted');
  });
});

// ------------------------------------------------------------------------ explicit route (P2 removal)

describe('a template memo routes through exactly the people the author named', () => {
  let ops: { a: string; b: string; c: string; sales: string };
  let deptId: string;

  beforeAll(async () => {
    const staff = async (roleKeys: RoleKey[]) =>
      (await createStaffUser(appPool, { ...scope, idpOrgId: staffIdpOrgId, roleKeys })).userId;
    // Approver-capable but not finance: management and founder hold approvals.requests.act in the default
    // role grants and no accountant or finance role. `sales` does not, so it must never be named.
    ops = {
      a: await staff(['management']),
      b: await staff(['founder']),
      c: await staff(['management']),
      sales: await staff(['sales']),
    };
    deptId = (await createDepartment(appPool, scope)).departmentId;
    await memoSignersAre([ops.a, ops.b, ops.c, U.boss]);
  });

  const nameOf = async (userId: string) =>
    (await db.select({ n: users.displayName }).from(users).where(eq(users.id, userId)))[0]!.n!;

  const template = (recommenders: string[], approver: string, preparer = current.userId) => ({
    departmentId: deptId,
    date: '2026-11-12',
    closing: 'Submitted for your approval.',
    preparedByUserId: preparer,
    recommenderUserIds: recommenders,
    approvedByUserId: approver,
  });

  async function createTemplateMemo(
    recommenders: string[],
    approver: string,
    over: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const res = await request(baseUrl)
      .post('/v1/test-memos')
      .send(templateMemoBody(template(recommenders, approver), over));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  const routeOf = (id: string) => request(baseUrl).get(`/v1/test-memos/${id}/route`);
  const stepRows = async (requestId: string) =>
    (await db.select().from(approvalSteps).where(eq(approvalSteps.requestId, requestId))).sort(
      (a, b) => a.seq - b.seq,
    );
  const requestsOf = (memoId: string) =>
    db.select().from(approvalRequests).where(eq(approvalRequests.documentId, memoId));

  const signerCases: { label: string; recommenders: ('a' | 'b')[]; approver: 'a' | 'b' | 'c' }[] = [
    { label: '1 signer', recommenders: [], approver: 'a' },
    { label: '2 signers', recommenders: ['a'], approver: 'b' },
    { label: '3 signers', recommenders: ['a', 'b'], approver: 'c' },
  ];
  it.each(signerCases)(
    'submits a memo with $label to exactly the selected users, in order, with no threshold step',
    async ({ recommenders, approver }) => {
      const recommenderIds = recommenders.map((k) => ops[k]);
      const approverId = ops[approver];
      // A money amount sent with a template must not matter: nothing routes on it.
      const { id } = await createTemplateMemo(recommenderIds, approverId, {
        amount: '5000000.00',
        currency: 'NPR',
      });
      const res = await submitMemo(id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: 'pending' });
      const { requestId } = res.body as { requestId: string };

      const steps = await stepRows(requestId);
      expect(steps.map((s) => s.userId)).toEqual([...recommenderIds, approverId]);
      expect(steps.every((s) => s.kind === 'user' && s.roleKey === null)).toBe(true);
      expect(steps.map((s) => s.reason)).toEqual([
        ...recommenderIds.map((_, i) => `Selected recommender ${i + 1}`),
        'Selected approver',
      ]);
      expect(steps.map((s) => s.status)).toEqual([
        'active',
        ...steps.slice(1).map(() => 'waiting'),
      ]);

      // Frozen with the published definition, but with no money facts and no amount in the snapshot.
      const row = await requestRow(requestId);
      expect(row.facts).toEqual({ routing: 'explicit' });
      expect(Object.keys(row.snapshot as object).sort()).toEqual([
        'attachments',
        'body',
        'customerPartyId',
        'memoVersion',
        'number',
        'ownerUserId',
        'template',
        'title',
      ]);
      expect(await statusOf(id)).toMatchObject({ status: 'submitted', version: 2 });
    },
  );

  it('checks the named signers through the submit transaction, never a second pooled connection', async () => {
    const { id } = await createTemplateMemo([ops.a], ops.b);
    const guard = poolGuard(db);
    // The same collaborators as `service`; only the memo service's own handle is watched.
    const guarded = new TestMemoService(
      guard.db,
      new NumberingService(),
      new MoneyService(db, settingsService),
      documents,
      approvals,
      authz as unknown as AuthzService,
      roleCache,
      caller,
      () => now,
      settingsService,
      notify as never,
    );

    expect(await guarded.submit(id, 1)).toMatchObject({ status: 'pending' });
    expect(guard.touches).toEqual([]);
    expect(await statusOf(id)).toMatchObject({ status: 'submitted', version: 2 });
  });

  it('keeps the compatibility value when the memo is submitted without money', async () => {
    const { id } = await createTemplateMemo([], ops.a);
    await submitMemo(id);
    const row = await statusOf(id);
    expect(row.currency).toBe('NPR');
    expect([Number(row.amount), Number(row.amountNpr), Number(row.fxRate)]).toEqual([0, 0, 1]);
  });

  it('shows a preview that equals the submitted route', async () => {
    const { id } = await createTemplateMemo([ops.a, ops.b], ops.c);
    const preview = RoutePlanSchema.parse((await routeOf(id)).body);
    expect(preview.blocked).toBe(false);
    const { requestId } = (await submitMemo(id)).body as { requestId: string };
    const steps = await stepRows(requestId);
    const shape = (s: {
      seq: number;
      kind: string;
      userId?: string | null | undefined;
      reason: string;
    }) => ({ seq: s.seq, kind: s.kind, userId: s.userId ?? null, reason: s.reason });
    expect(preview.steps.map(shape)).toEqual(steps.map(shape));
  });

  it('refuses to submit when the author who owns the memo is named as a signer', async () => {
    // The author is a founder (an approver-capable role), so only separation of duties can refuse them.
    as(U.founder, 'founder');
    const { id } = await createTemplateMemo([ops.a], ops.c);
    // Legacy stored templates still enforce owner separation of duties.
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx
        .update(testMemos)
        .set({
          template: sql`jsonb_set(template, '{approvedBy,userId}', to_jsonb(${U.founder}::text))`,
        })
        .where(eq(testMemos.id, id)),
    );
    const plan = RoutePlanSchema.parse((await routeOf(id)).body);
    expect(plan.blocked).toBe(true);
    expect(plan.blockReason).toMatch(/prepared or edited/);
    const res = await submitMemo(id);
    expect(res.status).toBe(409);
    expect(ErrorBodySchema.parse(res.body).error.message).toMatch(/cannot approve/);
    expect((await statusOf(id)).status).toBe('draft');
    expect(await requestsOf(id)).toHaveLength(0);
  });

  it('refuses to submit when an editor or the person pressing submit is named as a signer', async () => {
    const { id } = await createTemplateMemo([U.boss], ops.b);
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx
        .update(testMemos)
        .set({ editorUserIds: [U.boss] })
        .where(eq(testMemos.id, id)),
    );
    as(U.salesA, 'sales');
    expect((await submitMemo(id)).status).toBe(409);

    // A founder submitting a colleague's memo cannot also be its approver.
    const second = await createTemplateMemo([], U.boss);
    as(U.boss, 'founder');
    expect((await submitMemo(second.id)).status).toBe(404);
    expect((await statusOf(second.id)).status).toBe('draft');
    expect(await requestsOf(second.id)).toHaveLength(0);
  });

  it('refuses to submit when a selected signer is no longer active', async () => {
    const gone = (
      await createStaffUser(appPool, {
        ...scope,
        idpOrgId: staffIdpOrgId,
        roleKeys: ['management'],
      })
    ).userId;
    const { id } = await createTemplateMemo([], gone);
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx.update(users).set({ status: 'inactive' }).where(eq(users.id, gone)),
    );
    const res = await submitMemo(id);
    expect(res.status).toBe(409);
    expect((await statusOf(id)).status).toBe('draft');
    expect(await requestsOf(id)).toHaveLength(0);
  });

  it('lets only the selected person decide each step, then approves the memo', async () => {
    const { id } = await createTemplateMemo([ops.a, ops.b], ops.c);
    const { requestId } = (await submitMemo(id)).body as { requestId: string };
    const approve = (version: number) =>
      approvals.act(requestId, { action: 'approve', expectedVersion: version }, randomUUID());

    // Since 0ce3ad41 the approvals routes are AnyAuthenticated and ApprovalsService decides who may act. Callers
    // carry the roles they really hold (a = management, b = founder, c = management), because the service now
    // reads the act grant itself. It refuses in two ways:
    // - a caller who holds the approval permission but is not this step's named person: ForbiddenException
    //   ('You are not an approver for the active step', from act() step 3);
    // - a caller with no approval permission on a memo: NotFoundException from eligibleRequest, so the
    //   refusal does not reveal that the request exists. A department-head role grants nothing on a memo.
    // Nobody but the first signer may decide step 1: not a later signer, not a founder.
    as(ops.b, 'founder');
    await expect(approve(1)).rejects.toBeInstanceOf(ForbiddenException);
    as(U.boss, 'founder');
    await expect(approve(1)).rejects.toBeInstanceOf(ForbiddenException);
    for (const [who, role] of [
      [ops.sales, 'sales'],
      [ops.b, 'operations_head'],
    ] as const) {
      as(who, role);
      await expect(approve(1)).rejects.toBeInstanceOf(NotFoundException);
    }
    // None of those refusals advanced the memo.
    expect(await requestRow(requestId)).toMatchObject({
      status: 'pending',
      currentSeq: 1,
      version: 1,
    });
    // Only the active step's person has it in their inbox.
    as(ops.b, 'founder');
    expect((await approvals.inbox()).map((i) => i.requestId)).not.toContain(requestId);
    as(ops.a, 'management');
    expect((await approvals.inbox()).map((i) => i.requestId)).toContain(requestId);
    expect((await approvals.inbox()).find((i) => i.requestId === requestId)?.amountNpr).toBeNull();

    const first = await approve(1);
    expect(first).toMatchObject({ status: 'pending', currentSeq: 2 });
    as(ops.a, 'management');
    // The first signer has decided; step 2 belongs to someone else.
    await expect(approve(first.version)).rejects.toBeInstanceOf(ForbiddenException);
    as(ops.b, 'founder');
    const second = await approve(first.version);
    expect(second).toMatchObject({ status: 'pending', currentSeq: 3 });
    as(ops.c, 'management');
    const third = await approve(second.version);
    expect(third.status).toBe('approved');
    expect((await statusOf(id)).status).toBe('approved');
  });

  it('routes a management-only memo with no accountant or finance step, whatever amount is sent', async () => {
    const { id } = await createTemplateMemo([], ops.a, { amount: '9000000.00', currency: 'NPR' });
    const { requestId } = (await submitMemo(id)).body as { requestId: string };
    const steps = await stepRows(requestId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'user', userId: ops.a, roleKey: null });
    expect((await requestRow(requestId)).facts).toEqual({ routing: 'explicit' });
  });

  it('refuses a signer who cannot decide approvals, by name, at submit and in the route preview', async () => {
    const who = await nameOf(ops.sales);
    const message = `${who} cannot decide approvals; choose someone with approval rights.`;
    const cases: [string[], string][] = [
      [[ops.sales], ops.a],
      [[ops.a], ops.sales],
    ];
    for (const [recommenders, approver] of cases) {
      const { id } = await createTemplateMemo(recommenders, approver);
      const plan = RoutePlanSchema.parse((await routeOf(id)).body);
      expect(plan.blocked).toBe(true);
      expect(plan.blockReason).toBe(message);
      expect(plan.steps.filter((s) => s.blocked)).toHaveLength(1);
      const res = await submitMemo(id);
      expect(res.status).toBe(409);
      expect(ErrorBodySchema.parse(res.body).error.message).toBe(message);
      expect((await statusOf(id)).status).toBe('draft');
      expect(await requestsOf(id)).toHaveLength(0);
    }
  });

  it('follows the live role_permissions rows, not a fixed list of roles', async () => {
    const who = await nameOf(ops.a);
    const { id } = await createTemplateMemo([], ops.a);
    expect((await submitMemo(id)).status).toBe(200);
    // Take the grant away from management for this tenant (rows replace the defaults), then reload the cache.
    const rows = Object.entries(DEFAULT_ROLE_PERMISSIONS).flatMap(([role, grants]) =>
      Object.entries(grants).flatMap(([permission, grantScope]) =>
        role === 'management' && permission === 'approvals.requests.act'
          ? []
          : [{ tenantId: scope.tenantId, roleKey: role, permission, scope: grantScope }],
      ),
    );
    const setRows = (values: typeof rows) =>
      withTx(db, scope, systemActor('test'), async (tx) => {
        await tx.delete(rolePermissions).where(eq(rolePermissions.tenantId, scope.tenantId));
        if (values.length > 0) await tx.insert(rolePermissions).values(values);
      });
    await setRows(rows);
    roleCache.forget(scope.tenantId, scope.organizationId);
    try {
      const second = await createTemplateMemo([], ops.a);
      const res = await submitMemo(second.id);
      expect(res.status).toBe(409);
      expect(ErrorBodySchema.parse(res.body).error.message).toBe(
        `${who} cannot decide approvals; choose someone with approval rights.`,
      );
    } finally {
      await setRows([]);
      roleCache.forget(scope.tenantId, scope.organizationId);
    }
  });

  it('marks who can approve in the directory, so the pickers can offer only those people', async () => {
    const directory = MemoDirectorySchema.parse(
      (await request(baseUrl).get('/v1/test-memos/directory')).body,
    );
    const mark = (id: string) => directory.people.find((p) => p.userId === id)?.canApprove;
    expect([ops.a, ops.b, U.acc, U.fin, U.founder].map(mark)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect([ops.sales, U.salesA, U.salesB].map(mark)).toEqual([false, false, false]);
  });

  it('lets a named signer reach the inbox and the decide route through the permission check', async () => {
    // 0ce3ad41 made inbox and act AnyAuthenticated (a purchase request's designated head may lack the role
    // permission), so the route guard no longer carries a @Can marker. ApprovalsService decides instead.
    for (const handler of ['act', 'inbox'] as const) {
      const target = ApprovalsController.prototype[handler];
      expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, target)).toBe(true);
      expect(Reflect.getMetadata(CAN_KEY, target)).toBeUndefined();
    }

    const { id } = await createTemplateMemo([ops.a], ops.b);
    const { requestId } = (await submitMemo(id)).body as { requestId: string };
    const decide = (version: number) =>
      approvals.act(requestId, { action: 'approve', expectedVersion: version }, randomUUID());

    // Sales can open the quotation inbox, but cannot see or decide this memo.
    as(U.salesB, 'sales');
    expect((await approvals.inbox()).map((item) => item.requestId)).not.toContain(requestId);
    await expect(decide(1)).rejects.toBeInstanceOf(NotFoundException);
    expect(await requestRow(requestId)).toMatchObject({
      status: 'pending',
      currentSeq: 1,
      version: 1,
    });

    // The named management signer and then the named founder each see the request and decide their own step.
    as(ops.a, 'management');
    expect((await approvals.inbox()).map((i) => i.requestId)).toContain(requestId);
    const first = await decide(1);
    expect(first).toMatchObject({ status: 'pending', currentSeq: 2 });
    as(ops.b, 'founder');
    expect((await approvals.inbox()).map((i) => i.requestId)).toContain(requestId);
    expect((await decide(first.version)).status).toBe('approved');
  });

  it('keeps the attachment rules: unscanned files block submit and clean ones are frozen', async () => {
    const { id } = await createTemplateMemo([], ops.a);
    await attach(id, 'quarantined');
    const blocked = await submitMemo(id);
    expect(blocked.status).toBe(409);
    expect(ErrorBodySchema.parse(blocked.body).error.message).toBe('attachments are not all clean');

    const clean = await createTemplateMemo([], ops.a);
    const file = await attach(clean.id, 'clean');
    const { requestId } = (await submitMemo(clean.id)).body as { requestId: string };
    const snapshot = (await requestRow(requestId)).snapshot as {
      attachments: { documentId: string; versionId: string }[];
    };
    expect(snapshot.attachments.map((a) => a.versionId)).toEqual([file.versionId]);
  });

  it('still reads and routes a legacy memo with an amount and an attachment as before', async () => {
    const { id } = await createMemo({ amount: '250000.00' });
    const file = await attach(id, 'clean');
    const detail = await request(baseUrl).get(`/v1/test-memos/${id}`);
    expect(detail.body).toMatchObject({ amount: '250000.00', currency: 'NPR', template: null });
    expect((detail.body as { attachments: { id: string }[] }).attachments.map((a) => a.id)).toEqual(
      [file.versionId],
    );

    // The preview and the submit still take the role steps and the management threshold from the amount.
    const preview = RoutePlanSchema.parse((await routeOf(id)).body);
    expect(preview.steps.map((s) => s.roleKey)).toEqual(['accountant', 'finance', 'management']);
    const { requestId } = (await submitMemo(id)).body as { requestId: string };
    expect((await stepRows(requestId)).map((s) => s.roleKey)).toEqual([
      'accountant',
      'finance',
      'management',
    ]);
    const row = await requestRow(requestId);
    expect(row.facts).toEqual({ amountNpr: '250000.00' });
    expect((row.snapshot as { attachments: unknown[] }).attachments).toHaveLength(1);
  });

  it('answers 400 for a legacy memo without money and 404 for a route preview outside scope', async () => {
    const res = await request(baseUrl).post('/v1/test-memos').send({ title: 'No money', body: '' });
    expect(res.status).toBe(400);
    const { id } = await createTemplateMemo([], ops.a);
    as(U.salesB, 'sales');
    expect((await routeOf(id)).status).toBe(404);
  });
});

describe('GET /v1/test-memos (the Memos list)', () => {
  const at = (iso: string) => {
    now = new Date(iso);
  };
  /** A staff user of the entity who is not part of any other test, so "own" lists exactly what this test made. */
  const freshStaff = async () =>
    (await createStaffUser(appPool, { ...scope, idpOrgId: staffIdpOrgId })).userId;
  const list = (query = '') => request(baseUrl).get(`/v1/test-memos${query}`);
  const parsed = async (query = '') => {
    const res = await list(query);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return MemoListSchema.parse(res.body);
  };

  it('keeps draft and returned current content private despite broad grants or historical editing', async () => {
    // A fresh owner, so the owner's list holds only this test's memo: U.salesA owns dozens of memos made at the same
    // fake clock, and among equal created_at the id decides the order, so the memo could fall off a 50-item page.
    const owner = await freshStaff();
    as(owner, 'sales');
    const dept = await createDepartment(appPool, scope);
    const memo = await createMemo({
      title: 'Private draft',
      template: {
        departmentId: dept.departmentId,
        date: '2026-11-10',
        closing: '',
        preparedByUserId: owner,
        recommenderUserIds: [U.acc],
        approvedByUserId: U.fin,
      },
    });
    const file = await attach(memo.id, 'clean');
    for (const status of ['draft', 'returned'] as const) {
      await withTx(db, scope, systemActor('test'), (tx) =>
        tx
          .update(testMemos)
          .set({ status, editorUserIds: [U.acc] })
          .where(eq(testMemos.id, memo.id)),
      );
      for (const [user, role] of [
        [U.acc, 'accountant'],
        [U.fin, 'finance'],
        [U.salesB, 'sales'],
        [U.boss, 'founder'],
      ] as const) {
        as(user, role);
        expect((await parsed('?limit=50')).items.map((m) => m.id)).not.toContain(memo.id);
        expect((await request(baseUrl).get(`/v1/test-memos/${memo.id}`)).status).toBe(404);
        await expect(service.routePreview(memo.id)).rejects.toMatchObject({ status: 404 });
        await expect(documents.issueLink(scope, file.versionId)).rejects.toMatchObject({
          status: 404,
        });
        expect(
          (await request(baseUrl).patch(`/v1/test-memos/${memo.id}`).send({ title: 'No' })).status,
        ).toBe(404);
        expect((await submitMemo(memo.id)).status).toBe(404);
      }
      as(owner, 'sales');
      expect((await request(baseUrl).get(`/v1/test-memos/${memo.id}`)).status).toBe(200);
      expect((await parsed('?limit=50')).items.map((m) => m.id)).toContain(memo.id);
    }
  });

  it('shows a Sales user only their own memos, newest first, with the listing fields', async () => {
    const mine = await freshStaff();
    const other = await freshStaff();
    as(mine, 'sales');
    at('2026-11-01T04:00:00Z');
    const first = await createMemo({ title: 'First' });
    at('2026-11-02T04:00:00Z');
    const second = await createMemo({ title: 'Second' });
    as(other, 'sales');
    await createMemo({ title: 'Someone else' });
    as(mine, 'sales');

    const page = await parsed();
    expect(page.items.map((m) => m.id)).toEqual([second.id, first.id]);
    expect(page.nextCursor).toBeNull();
    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({
      title: 'Second',
      status: 'draft',
      amount: '50000.00',
      currency: 'NPR',
      ownerUserId: mine,
    });
    // The list never carries a body or signers: it only finds memos.
    expect(page.items[0]).not.toHaveProperty('body');
    expect(page.items[0]).not.toHaveProperty('template');
  });

  it('shows the whole entity to a role with scope all, in the order the database defines', async () => {
    as(U.boss, 'founder');
    const rows = await db
      .select({ id: testMemos.id })
      .from(testMemos)
      .where(
        sql`${testMemos.organizationId} = ${scope.organizationId} AND (${testMemos.status} NOT IN ('draft', 'returned') OR ${testMemos.ownerUserId} = ${U.boss})`,
      )
      .orderBy(sql`created_at DESC, id DESC`)
      .limit(50);
    const page = await parsed('?limit=50');
    expect(page.items.map((m) => m.id)).toEqual(rows.map((r) => r.id));
  });

  it('never lists another tenant memo, even to a role with scope all', async () => {
    const foreign = await createTenantWithEntity(appPool);
    const foreignScope = { tenantId: foreign.tenantId, organizationId: foreign.organizationId };
    const foreignOwner = await createStaffUser(appPool, {
      ...foreignScope,
      idpOrgId: foreign.idpOrgId,
    });
    const foreignId = randomUUID();
    // An approved memo: it is the kind an entity-wide reader would see if the tenant wall failed, so a leak shows.
    const token = `Foreignwall${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await withTx(db, foreignScope, systemActor('test'), (tx) =>
      tx.insert(testMemos).values({
        ...foreignScope,
        id: foreignId,
        number: `FOREIGN-${randomUUID()}`,
        title: `Foreign tenant memo ${token}`,
        body: '',
        amount: '1.00',
        currency: 'NPR',
        amountNpr: '1.00',
        fxRate: '1',
        fxSource: 'identity',
        fxDate: '2026-11-08',
        status: 'approved',
        ownerUserId: foreignOwner.userId,
        version: 1,
      }),
    );
    as(U.boss, 'founder');
    const ids = (await parsed('?limit=50')).items.map((m) => m.id);
    expect(ids).not.toContain(foreignId);
    // Searching for its own title token finds nothing here, and the count says so.
    const searched = await parsed(`?q=${token}&limit=50`);
    expect(searched.items).toEqual([]);
    expect(searched.total).toBe(0);
    // And its id does not open either: the list and the record check give the same answer.
    expect((await request(baseUrl).get(`/v1/test-memos/${foreignId}`)).status).toBe(404);
  });

  it('limits a department scope to that department and shows nothing without a department', async () => {
    const dept = await createDepartment(appPool, scope);
    const otherDept = await createDepartment(appPool, scope);
    const lead = await freshStaff();
    const template = (departmentId: string) => ({
      departmentId,
      date: '2026-11-10',
      closing: '',
      preparedByUserId: lead,
      recommenderUserIds: [] as string[],
      approvedByUserId: U.fin,
    });
    as(lead, 'sales');
    const inside = await createMemo({
      title: 'In my department',
      template: template(dept.departmentId),
    });
    const outside = await createMemo({
      title: 'Other department',
      template: template(otherDept.departmentId),
    });

    // A department grant also covers the reader's own memos, so the other department's memo belongs to someone else.
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx.update(testMemos).set({ ownerUserId: U.salesB }).where(eq(testMemos.id, outside.id)),
    );
    current.grants = new Map<Permission, Scope>([['memo.read', 'department']]);
    current.departmentId = dept.departmentId;
    const page = await parsed();
    expect(page.items.map((m) => m.id)).toEqual([inside.id]);
    expect(page.items[0]?.departmentName).toBeTruthy();
    expect((await request(baseUrl).get(`/v1/test-memos/${outside.id}`)).status).toBe(404);

    current.departmentId = null;
    // Without a department only the reader's own memo is left; the other department's memo stays out.
    expect((await parsed()).items.map((m) => m.id)).toEqual([inside.id]);
  });

  it('shows a portal customer only the memos that name their party, like the record check', async () => {
    as(U.salesA, 'sales');
    const forP1 = await createMemo({ title: 'For P1', customerPartyId: p1.partyId });
    const forP2 = await createMemo({ title: 'For P2', customerPartyId: p2.partyId });
    const internal = await createMemo({ title: 'Internal' });
    await submitMemo(forP1.id);
    await submitMemo(forP2.id);
    asCustomer(p1);
    const ids = (await parsed('?limit=50')).items.map((m) => m.id);
    expect(ids).toContain(forP1.id);
    expect(ids).not.toContain(forP2.id);
    expect(ids).not.toContain(internal.id);
    // Every row the customer sees names their party: the same rule `get` applies to one id.
    for (const id of ids) expect((await statusOf(id)).customerPartyId).toBe(p1.partyId);
  });

  it('answers 403 to a role without memo.read', async () => {
    current.grants = new Map<Permission, Scope>();
    expect((await list()).status).toBe(403);
  });

  it('pages without skipping or repeating, even when memos share a timestamp', async () => {
    const mine = await freshStaff();
    as(mine, 'sales');
    at('2026-11-05T04:00:00Z');
    const tied = [];
    for (let i = 0; i < 4; i += 1) tied.push((await createMemo({ title: `Tied ${i}` })).id);
    at('2026-11-06T04:00:00Z');
    const newest = (await createMemo({ title: 'Newest' })).id;

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await parsed(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.items.map((m) => m.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect(seen[0]).toBe(newest);
    expect([...seen.slice(1)].sort()).toEqual([...tied].sort());
    // Ties break on id descending, the same as the database orders them.
    expect(seen.slice(1)).toEqual([...tied].sort().reverse());
  });

  it('filters by status', async () => {
    const mine = await freshStaff();
    as(mine, 'sales');
    await createMemo({ title: 'Stays draft' });
    expect((await parsed('?status=approved')).items).toEqual([]);
    expect((await parsed('?status=draft')).items).toHaveLength(1);
  });

  /** Sets the status (and optionally the owner's display name) directly: the list tests do not need a full approval. */
  const setStatus = (
    id: string,
    status: 'draft' | 'submitted' | 'approved' | 'returned' | 'rejected',
  ) =>
    withTx(db, scope, systemActor('test'), (tx) =>
      tx.update(testMemos).set({ status }).where(eq(testMemos.id, id)),
    );
  const rename = (userId: string, displayName: string) =>
    withTx(db, scope, systemActor('test'), (tx) =>
      tx.update(users).set({ displayName }).where(eq(users.id, userId)),
    );

  it('filters by several statuses at once, repeated in the URL, and counts every match', async () => {
    const mine = await freshStaff();
    as(mine, 'sales');
    const [a, b, c] = [
      await createMemo({ title: 'Multi one' }),
      await createMemo({ title: 'Multi two' }),
      await createMemo({ title: 'Multi three' }),
    ];
    await setStatus(b.id, 'approved');
    await setStatus(c.id, 'rejected');
    const both = await parsed('?status=draft&status=approved');
    expect(both.items.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect(both.total).toBe(2);
    const all = await parsed('');
    expect(all.total).toBe(3);
    expect((await parsed('?status=rejected&status=rejected')).total).toBe(1);
  });

  it('searches number, title and owner name by substring, ignoring case and one-character input', async () => {
    const mine = await freshStaff();
    const other = await freshStaff();
    await rename(mine, 'Zephyrine Quillfeather');
    as(mine, 'sales');
    const budget = await createMemo({ title: 'Annual Budget Review' });
    await createMemo({ title: 'Office plants' });
    as(other, 'sales');
    await createMemo({ title: 'Budget of someone else' });
    as(mine, 'sales');

    const number = (await parsed('')).items.find((m) => m.id === budget.id)!.number;
    expect((await parsed('?q=budget')).items.map((m) => m.id)).toEqual([budget.id]);
    expect((await parsed(`?q=${number}`)).items.map((m) => m.id)).toEqual([budget.id]);
    expect((await parsed('?q=QUILLFEATHER')).total).toBe(2);
    // Wildcards are text, not patterns; one character is no search at all.
    expect((await parsed('?q=%25%25')).total).toBe(0);
    expect((await parsed('?q=__')).total).toBe(0);
    expect((await parsed('?q=_')).total).toBe(2);
    expect((await parsed('?q=zz-nothing')).items).toEqual([]);
    // Statuses and search narrow together.
    expect((await parsed('?q=budget&status=approved')).total).toBe(0);
  });

  it('reports the same total on every page of a search while the cursor keeps paging', async () => {
    const mine = await freshStaff();
    as(mine, 'sales');
    at('2026-11-07T04:00:00Z');
    for (let i = 0; i < 5; i += 1) await createMemo({ title: `Quarterly review ${i}` });
    await createMemo({ title: 'Unrelated' });

    const seen: string[] = [];
    const totals = new Set<number>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await parsed(`?q=quarterly&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.items.map((m) => m.id));
      totals.add(page.total);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect([...totals]).toEqual([5]);
  });

  it('never lets a status or a search reach another user’s draft or returned memo', async () => {
    // Tokens no other memo or user in this database carries, so every search below can only match this memo and
    // its owner: a count of 0 then means the memo was hidden, not that nothing matched.
    const unique = () => randomUUID().replaceAll('-', '').slice(0, 12);
    const titleToken = `Staffing${unique()}`;
    const nameToken = `Hiddenhall${unique()}`;
    const owner = await freshStaff();
    await rename(owner, `Ottoline ${nameToken}`);
    as(owner, 'sales');
    const memo = await createMemo({ title: `Confidential plan ${titleToken}` });
    for (const status of ['draft', 'returned'] as const) {
      await setStatus(memo.id, status);
      as(U.boss, 'founder');
      for (const query of [
        `?status=${status}&q=${titleToken}`,
        `?q=${titleToken}`,
        `?q=${titleToken.toLowerCase()}`,
        `?q=${nameToken}`,
        `?status=${status}&q=${nameToken}`,
        `?status=draft&status=returned&status=approved&q=${titleToken}`,
      ]) {
        const page = await parsed(`${query}&limit=50`);
        expect(
          page.items.map((m) => m.id),
          query,
        ).not.toContain(memo.id);
        // The count must not leak that a hidden memo matched.
        expect(page.total, query).toBe(0);
      }
      as(owner, 'sales');
      const mine = await parsed(`?status=${status}&q=${nameToken}`);
      expect(mine.items.map((m) => m.id)).toEqual([memo.id]);
      expect(mine.total).toBe(1);
    }
    // Once approved the same query finds it for a reader with entity-wide scope.
    await setStatus(memo.id, 'approved');
    as(U.boss, 'founder');
    expect((await parsed(`?q=${nameToken}&status=approved`)).items.map((m) => m.id)).toEqual([
      memo.id,
    ]);
  });

  it('answers 400, not a database error, for a forged cursor, an out-of-range limit or an unknown parameter', async () => {
    expect((await list('?cursor=not-a-real-cursor')).status).toBe(400);
    const forged = Buffer.from(JSON.stringify(["1'; DROP TABLE x;--", randomUUID()])).toString(
      'base64url',
    );
    expect((await list(`?cursor=${forged}`)).status).toBe(400);
    // Well-formed but not a real moment (month 13, day 45, hour 25, 30 February): 400, not a database error.
    for (const createdAt of [
      '2026-13-05T10:00:00.000000Z',
      '2026-11-45T10:00:00.000000Z',
      '2026-11-05T25:00:00.000000Z',
      '2026-02-30T10:00:00.000000Z',
    ]) {
      const unreal = Buffer.from(JSON.stringify([createdAt, randomUUID()])).toString('base64url');
      expect((await list(`?cursor=${unreal}`)).status, createdAt).toBe(400);
    }
    expect((await list('?limit=0')).status).toBe(400);
    expect((await list('?limit=51')).status).toBe(400);
    expect((await list('?limit=abc')).status).toBe(400);
    expect((await list('?ownerUserId=' + U.boss)).status).toBe(400);
    expect((await list('?status=weird')).status).toBe(400);
    expect((await list('?status=draft&status=weird')).status).toBe(400);
    expect((await list('?q=ab&q=cd')).status).toBe(400);
  });
});

// ----------------------------------------------------------------------------------- discard (soft)

describe('POST /v1/test-memos/:id/discard (Delete draft)', () => {
  const discard = (id: string) => request(baseUrl).post(`/v1/test-memos/${id}/discard`);
  const listedIds = async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await request(baseUrl)
        .get('/v1/test-memos')
        .query(cursor === null ? { limit: 50 } : { limit: 50, cursor });
      const page = MemoListSchema.parse(res.body);
      ids.push(...page.items.map((memo) => memo.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return ids;
  };
  /** Audit rows of the memo itself (the row trigger writes one per change), oldest first. */
  const auditOf = async (id: string) =>
    (
      await ownerPool.query<{ action: string; actor_id: string; after: Record<string, unknown> }>(
        `SELECT action, actor_id, after FROM audit.audit_events WHERE entity_type = 'test_memos' AND entity_id = $1 ORDER BY id`,
        [id],
      )
    ).rows;
  const requestCount = async (id: string) =>
    (
      await ownerPool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM app.approval_requests WHERE document_id = $1',
        [id],
      )
    ).rows[0]!.n;
  /** A memo the approver sent back: status returned, one decided approval request on record. */
  const returnedMemo = async () => {
    const { id } = await createMemo({ title: 'Needs a quote' });
    const { requestId } = (await submitMemo(id)).body as { requestId: string };
    as(U.acc, 'founder');
    await approvals.act(
      requestId,
      { action: 'return', comment: 'add a quote', expectedVersion: 1 },
      randomUUID(),
    );
    as(U.salesA, 'sales');
    expect((await statusOf(id)).status).toBe('returned');
    return id;
  };

  it('lets the creator discard a draft: 204, then it is gone from reads and writes, and only the discard is written', async () => {
    const { id } = await createMemo({ title: 'Discard me' });
    const file = await attach(id, 'clean');
    const before = await statusOf(id);
    const auditBefore = (await auditOf(id)).length;
    now = new Date('2026-11-08T05:00:00Z');

    const res = await discard(id);
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(res.text).toBe('');

    // Soft: the row, its number and its status stay; only the discard columns and the version change.
    const after = await statusOf(id);
    expect(after).toMatchObject({
      status: 'draft',
      number: before.number,
      title: before.title,
      body: before.body,
      amount: before.amount,
      ownerUserId: U.salesA,
      discardedByUserId: U.salesA,
      version: before.version + 1,
    });
    expect(after.discardedAt).toEqual(now);
    // Audited: exactly one new row event, by the creator, carrying the discard.
    const events = await auditOf(id);
    expect(events).toHaveLength(auditBefore + 1);
    expect(events.at(-1)).toMatchObject({
      action: 'test_memos.update',
      actor_id: U.salesA,
      after: { discarded_by_user_id: U.salesA },
    });

    // Private even to the creator: as absent as a random id, in the list and in every route.
    expect(await listedIds()).not.toContain(id);
    expect((await request(baseUrl).get(`/v1/test-memos/${id}`)).status).toBe(404);
    expect(
      (await request(baseUrl).patch(`/v1/test-memos/${id}`).send({ title: 'Back again' })).status,
    ).toBe(404);
    expect((await submitMemo(id)).status).toBe(404);
    expect((await discard(id)).status).toBe(404);
    // Attachments: no new upload, no download link; the stored evidence itself is untouched.
    await expect(attach(id, 'clean')).rejects.toMatchObject({ status: 404 });
    await expect(documents.issueLink(scope, file.versionId)).rejects.toMatchObject({
      status: 404,
    });
    const [version] = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.id, file.versionId));
    expect(version).toMatchObject({ status: 'clean' });

    // The refused attempts above wrote nothing: same row, same audit trail, no approval request.
    expect(await statusOf(id)).toEqual(after);
    expect(await auditOf(id)).toHaveLength(auditBefore + 1);
    expect(await requestCount(id)).toBe(0);
  });

  it('discards a returned memo too, and keeps its number, its decided request and its history', async () => {
    const id = await returnedMemo();
    const before = await statusOf(id);
    expect(await requestCount(id)).toBe(1);

    expect((await discard(id)).status).toBe(204);

    expect(await statusOf(id)).toMatchObject({
      status: 'returned',
      number: before.number,
      discardedByUserId: U.salesA,
    });
    const [request1] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.documentId, id));
    expect(request1).toMatchObject({ status: 'returned' });
    expect(await requestCount(id)).toBe(1);
    expect(await listedIds()).not.toContain(id);
    expect((await request(baseUrl).get(`/v1/test-memos/${id}`)).status).toBe(404);
    expect(
      (await request(baseUrl).patch(`/v1/test-memos/${id}`).send({ body: 'edit' })).status,
    ).toBe(404);
    expect((await submitMemo(id)).status).toBe(404);
    // The next memo does not reuse the discarded number.
    const next = await createMemo({ title: 'Next' });
    expect(
      MemoDtoSchema.parse((await request(baseUrl).get(`/v1/test-memos/${next.id}`)).body).number,
    ).not.toBe(before.number);
  });

  it('is creator-only: another user gets 404 on a private draft, 403 on a memo they can read, and nothing changes', async () => {
    const draft = await createMemo({ title: 'Mine' });
    const submitted = await createMemo({ title: 'Sent' });
    expect((await submitMemo(submitted.id)).status).toBe(200);

    for (const [user, role] of [
      [U.salesB, 'sales'],
      [U.boss, 'founder'],
    ] as const) {
      as(user, role);
      // Someone else's draft is private, whatever the grant: 404 (it is not even known to exist).
      expect((await discard(draft.id)).status).toBe(404);
    }
    as(U.salesB, 'sales');
    expect((await discard(submitted.id)).status).toBe(404); // outside scope own
    as(U.boss, 'founder');
    expect((await discard(submitted.id)).status).toBe(403); // can read it, did not create it
    as(U.acc, 'accountant');
    expect((await discard(submitted.id)).status).toBe(403); // no memo.update grant at all

    // A creator cannot discard a submitted memo: it is evidence of a pending decision.
    as(U.salesA, 'sales');
    expect((await discard(submitted.id)).status).toBe(409);
    for (const id of [draft.id, submitted.id]) {
      expect((await statusOf(id)).discardedAt).toBeNull();
    }
    expect((await statusOf(submitted.id)).status).toBe('submitted');
    expect(await listedIds()).toEqual(expect.arrayContaining([draft.id, submitted.id]));
  });

  it('refuses an approved memo, an unknown id and a bad id, and a portal customer', async () => {
    const { id } = await createMemo();
    const { requestId } = (await submitMemo(id)).body as { requestId: string };
    let version = 1;
    for (const user of [U.acc, U.fin]) {
      as(user, 'founder');
      version = (
        await approvals.act(
          requestId,
          { action: 'approve', expectedVersion: version },
          randomUUID(),
        )
      ).version;
    }
    as(U.salesA, 'sales');
    expect((await statusOf(id)).status).toBe('approved');
    expect((await discard(id)).status).toBe(409);
    expect((await discard(randomUUID())).status).toBe(404);
    expect((await discard('not-a-uuid')).status).toBe(400);
    asCustomer(p1);
    expect((await discard(id)).status).toBe(403);
    expect((await statusOf(id)).discardedAt).toBeNull();
  });

  it('is final in the database too: a discarded memo cannot change, and only an unsubmitted memo can be marked discarded', async () => {
    const { id } = await createMemo();
    expect((await discard(id)).status).toBe(204);
    // Even the table owner cannot edit or restore it (trigger test_memos_discarded_guard).
    await expect(
      ownerPool.query(`UPDATE app.test_memos SET title = 'Changed' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      ownerPool.query(
        `UPDATE app.test_memos SET discarded_at = NULL, discarded_by_user_id = NULL WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const sent = await createMemo({ title: 'Sent' });
    expect((await submitMemo(sent.id)).status).toBe(200);
    await expect(
      ownerPool.query(
        `UPDATE app.test_memos SET discarded_at = now(), discarded_by_user_id = owner_user_id WHERE id = $1`,
        [sent.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'test_memos_discarded_status_check' });
    // Creator only: someone else cannot be recorded as the discarder, even by a direct write.
    const draft = await createMemo({ title: 'Other' });
    await expect(
      ownerPool.query(
        `UPDATE app.test_memos SET discarded_at = now(), discarded_by_user_id = $2 WHERE id = $1`,
        [draft.id, U.salesB],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'test_memos_discarded_by_owner_check' });
  });
});

/**
 * A Db that records every call made on it while a transaction it opened is still open. Such a call takes a second
 * pooled connection while the transaction holds the first, so under load the pool can run dry and stall.
 */
function poolGuard(real: Db): { db: Db; touches: string[] } {
  const touches: string[] = [];
  let open = 0;
  const where = () =>
    (new Error().stack ?? '')
      .split('\n')
      .filter((line) => line.includes('/src/') && !line.includes('.test.'))
      .slice(0, 2)
      .map((line) => line.trim())
      .join(' < ');
  const db = new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      if (prop === 'transaction') {
        return (fn: (tx: unknown) => Promise<unknown>, config?: unknown) =>
          target.transaction(async (tx) => {
            open += 1;
            try {
              return await fn(tx);
            } finally {
              open -= 1;
            }
          }, config as never);
      }
      return (...args: unknown[]) => {
        if (open > 0) touches.push(`${String(prop)} at ${where()}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { db, touches };
}
