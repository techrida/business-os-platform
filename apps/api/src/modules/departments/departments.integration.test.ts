// Integration tests for the Departments admin API (/v1/admin/departments, U20b / US-106) against
// a real Postgres 16 container (Testcontainers, needs Docker): real migrations (including 0079 and
// 0086), real bos_app role, real DepartmentsAdminController + DepartmentsAdminService + AuditService
// + AccessRevisionTableStore + ErrorBodyFilter + production body parser.
// Run: pnpm --filter @bos/api exec vitest run src/modules/departments/departments.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  AdminDepartmentDetailSchema,
  AdminDepartmentListSchema,
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  type Permission,
  type RoleKey,
  type Scope,
  UnassignedPeopleResponseSchema,
} from '@bos/contracts';
import {
  createStaffUser,
  createTenantWithEntity,
  leads,
  runMigrations,
  type TenantWithEntity,
} from '@bos/db';
import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../../platform/authz/decorators';
import type { Principal, ResourceRef } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { type Actor, systemActor, type TxScope, withTx } from '../../platform/db/tx';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { UserMirror } from '../../platform/users/user-mirror';
import type { UsersSyncData } from '../../platform/users/users.constants';
import { SqlUsersStore } from '../../platform/users/users.store';
import type { ZitadelAdminClient } from '../../platform/users/zitadel-admin.client';
import { AccessRevisionTableStore } from './access-revision.port';
import type { DepartmentsCaller } from './departments.caller';
import { DepartmentsAdminController } from './departments.controller';
import { DepartmentsAdminService } from './departments.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;

let tenant1: TenantWithEntity;
let entity1BId: string;
let scope1A: TxScope;
let scope1B: TxScope;
let tenant2: TenantWithEntity;
let scope2A: TxScope;

let founderUserId: string;
let ashaId: string;
let bikashId: string;
let nishaId: string;
let dipakId: string;
let inactiveUserId: string;
let entity1BUserId: string;
let tenant2UserId: string;

interface CallerState {
  scope: TxScope;
  userId: string;
  orgKind: Principal['orgKind'];
  status: Principal['status'];
  grants: Map<Permission, Scope>;
}

const callerState: CallerState = {
  scope: { tenantId: '', organizationId: '' },
  userId: '',
  orgKind: 'staff',
  status: 'active',
  grants: new Map(),
};

const invalidateSpy = vi.fn<(tenantId: string, organizationId: string) => Promise<void>>(() =>
  Promise.resolve(),
);

function currentPrincipal(): Principal {
  return {
    userId: callerState.userId,
    zitadelUserId: `test-sub-${callerState.userId}`,
    tenantId: callerState.scope.tenantId,
    organizationId: callerState.scope.organizationId,
    idpOrgId: tenant1.idpOrgId,
    orgKind: callerState.orgKind,
    partyId: null,
    status: callerState.status,
    roles: [],
    departmentId: null,
    grants: callerState.grants,
  };
}

function asRole(
  role: RoleKey,
  options: {
    scope?: TxScope;
    userId?: string;
    orgKind?: Principal['orgKind'];
    status?: Principal['status'];
  } = {},
): void {
  callerState.scope = options.scope ?? scope1A;
  callerState.userId = options.userId ?? founderUserId;
  callerState.orgKind = options.orgKind ?? 'staff';
  callerState.status = options.status ?? 'active';
  callerState.grants = new Map(
    Object.entries(DEFAULT_ROLE_PERMISSIONS[role]) as [Permission, Scope][],
  );
}

function asGrants(
  grants: readonly [Permission, Scope][],
  options: {
    scope?: TxScope;
    userId?: string;
    orgKind?: Principal['orgKind'];
    status?: Principal['status'];
  } = {},
): void {
  callerState.scope = options.scope ?? scope1A;
  callerState.userId = options.userId ?? founderUserId;
  callerState.orgKind = options.orgKind ?? 'staff';
  callerState.status = options.status ?? 'active';
  callerState.grants = new Map(grants);
}

async function auditEventsOf(
  scope: TxScope,
  entityId: string,
): Promise<{ action: string; entity_type: string; meta: Record<string, unknown> | null }[]> {
  const res = await ownerPool.query<{
    action: string;
    entity_type: string;
    meta: Record<string, unknown> | null;
  }>(
    `SELECT action, entity_type, meta
       FROM audit.read_events($1::uuid, $2::uuid, 'departments', $3::text, NULL, NULL, NULL, 200)
      ORDER BY id ASC`,
    [scope.tenantId, scope.organizationId, entityId],
  );
  return res.rows;
}

async function setDisplayName(
  scope: TxScope,
  userId: string,
  displayName: string,
  email: string,
): Promise<void> {
  await withTx(db, scope, systemActor('test-seed'), (tx) =>
    tx.execute(
      sql`UPDATE app.users SET display_name = ${displayName}, email = ${email}
           WHERE tenant_id = ${scope.tenantId}::uuid AND id = ${userId}::uuid`,
    ),
  );
}

const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const urlFor = (user: string, password: string, database: string): string => {
    const url = new URL(container.getConnectionUri());
    url.username = user;
    url.password = password;
    url.pathname = `/${database}`;
    return url.toString();
  };

  const admin0 = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin0.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin0.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin0.query('CREATE DATABASE bos OWNER bos_owner');
  await admin0.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin0.end();

  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();

  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  ownerPool = new Pool({ connectionString: urlFor('bos_owner', OWNER_PW, 'bos'), max: 2 });
  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 8 });
  db = drizzle({ client: appPool });

  // Tenant 1 with two legal entities (1A default, 1B second entity).
  tenant1 = await createTenantWithEntity(appPool);
  scope1A = { tenantId: tenant1.tenantId, organizationId: tenant1.organizationId };
  entity1BId = randomUUID();
  await withTx(db, scope1A, systemActor('test-seed'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.organizations (id, tenant_id, organization_id, code, name, legal_name, is_default)
          VALUES (${entity1BId}::uuid, ${tenant1.tenantId}::uuid, ${entity1BId}::uuid, 'E1B', 'Entity 1B', 'Entity 1B Pvt. Ltd.', false)`,
    ),
  );
  scope1B = { tenantId: tenant1.tenantId, organizationId: entity1BId };

  // Tenant 2 for cross-tenant isolation tests.
  tenant2 = await createTenantWithEntity(appPool);
  scope2A = { tenantId: tenant2.tenantId, organizationId: tenant2.organizationId };

  // Staff users in Entity 1A.
  founderUserId = (await createStaffUser(appPool, { ...tenant1, roleKeys: ['founder'] })).userId;
  await setDisplayName(scope1A, founderUserId, 'Founder One', 'founder@acme.test');

  ashaId = (await createStaffUser(appPool, { ...tenant1, roleKeys: ['sales'] })).userId;
  await setDisplayName(scope1A, ashaId, 'Asha Thapa', 'asha@acme.test');

  bikashId = (await createStaffUser(appPool, { ...tenant1, roleKeys: ['sales'] })).userId;
  await setDisplayName(scope1A, bikashId, 'Bikash Rai', 'bikash@acme.test');

  nishaId = (await createStaffUser(appPool, { ...tenant1, roleKeys: ['marketing'] })).userId;
  await setDisplayName(scope1A, nishaId, 'Nisha Gurung', 'nisha@acme.test');

  dipakId = (await createStaffUser(appPool, { ...tenant1, roleKeys: ['finance', 'sales'] })).userId;
  await setDisplayName(scope1A, dipakId, 'Dipak Shrestha', 'dipak@acme.test');

  inactiveUserId = (await createStaffUser(appPool, { ...tenant1, roleKeys: ['sales'] })).userId;
  await withTx(db, scope1A, systemActor('test-seed'), (tx) =>
    tx.execute(
      sql`UPDATE app.users SET status = 'inactive', display_name = 'Former Staff'
           WHERE tenant_id = ${tenant1.tenantId}::uuid AND id = ${inactiveUserId}::uuid`,
    ),
  );

  // Staff user belonging ONLY to Entity 1B (not 1A).
  entity1BUserId = (
    await createStaffUser(appPool, {
      tenantId: tenant1.tenantId,
      organizationId: entity1BId,
      idpOrgId: tenant1.idpOrgId,
      roleKeys: ['sales'],
    })
  ).userId;
  await setDisplayName(scope1B, entity1BUserId, 'Entity B Staff', 'entityb@acme.test');

  // Staff user in Tenant 2.
  tenant2UserId = (await createStaffUser(appPool, { ...tenant2, roleKeys: ['founder'] })).userId;

  const fakeCaller: DepartmentsCaller = {
    tx: () => ({
      scope: callerState.scope,
      actor: {
        kind: 'user',
        id: callerState.userId,
        correlationId: `test:${randomUUID()}`,
      } satisfies Actor,
    }),
    principal: () => currentPrincipal(),
  };

  const fakeAuthz = {
    assert(action: Permission, ref?: ResourceRef): void {
      const decision = can(currentPrincipal(), action, ref);
      if (!decision.allowed) {
        throw new ForbiddenException({
          code: 'forbidden',
          message: 'Forbidden',
          reason: decision.reason,
        });
      }
    },
    invalidate: invalidateSpy,
  } as unknown as AuthzService;

  const audit = new AuditService(db);
  const revisions = new AccessRevisionTableStore();
  const service = new DepartmentsAdminService(db, fakeCaller, fakeAuthz, audit, revisions);

  const moduleRef = await Test.createTestingModule({
    controllers: [DepartmentsAdminController],
    providers: [{ provide: DepartmentsAdminService, useValue: service }],
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
});

beforeEach(() => {
  asRole('founder');
  invalidateSpy.mockReset();
  invalidateSpy.mockImplementation(() => Promise.resolve());
});

describe('Route metadata and permission enforcement', () => {
  it('marks reads as AnyAuthenticated and writes with admin.roles.write', () => {
    const reflector = new Reflector();
    const proto = DepartmentsAdminController.prototype;

    for (const readRoute of [proto.list, proto.listUnassigned, proto.getById]) {
      expect(reflector.get(ANY_AUTHENTICATED_KEY, readRoute)).toBe(true);
    }
    for (const writeRoute of [proto.create, proto.rename, proto.retire, proto.restore]) {
      expect(reflector.get(CAN_KEY, writeRoute)).toBe('admin.roles.write');
    }
  });

  // People changes are saved only through the access save, which re-checks every warning (W6 included). The
  // department's own people route skipped them, so it is gone, not merely unused.
  it('has no people route of its own', async () => {
    expect('updatePeople' in DepartmentsAdminController.prototype).toBe(false);
    const created = await request(baseUrl)
      .post('/v1/admin/departments')
      .send({ name: 'No People Route' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const dept = AdminDepartmentDetailSchema.parse(created.body);
    const res = await request(baseUrl)
      .post(`/v1/admin/departments/${dept.id}/people`)
      .send({
        changes: [{ kind: 'memberAdd', departmentId: dept.id, userId: ashaId }],
        expectedRevision: dept.revision,
      });
    expect(res.status).toBe(404);
    const after = AdminDepartmentDetailSchema.parse(
      (await request(baseUrl).get(`/v1/admin/departments/${dept.id}`)).body,
    );
    expect(after.members.some((m) => m.userId === ashaId)).toBe(false);
    expect(after.revision).toBe(dept.revision);
    const retired = await request(baseUrl)
      .post(`/v1/admin/departments/${dept.id}/retire`)
      .send({ expectedVersion: dept.version });
    expect(retired.status).toBe(200);
  });

  it('allows reads with admin.users.read or admin.roles.read, refuses writes for read-only callers, and refuses non-admin or portal callers', async () => {
    const created = await request(baseUrl)
      .post('/v1/admin/departments')
      .send({ name: 'Permissions Check' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const dept = AdminDepartmentDetailSchema.parse(created.body);

    for (const readGrant of ['admin.users.read', 'admin.roles.read'] as const) {
      asGrants([[readGrant, 'all']]);
      expect((await request(baseUrl).get('/v1/admin/departments')).status).toBe(200);
      expect((await request(baseUrl).get('/v1/admin/departments/unassigned')).status).toBe(200);
      expect((await request(baseUrl).get(`/v1/admin/departments/${dept.id}`)).status).toBe(200);

      // Write routes are 403 for read-only callers.
      expect(
        (await request(baseUrl).post('/v1/admin/departments').send({ name: 'Blocked' })).status,
      ).toBe(403);
      expect(
        (
          await request(baseUrl)
            .patch(`/v1/admin/departments/${dept.id}`)
            .send({ name: 'Blocked', expectedVersion: dept.version })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(baseUrl)
            .post(`/v1/admin/departments/${dept.id}/retire`)
            .send({ expectedVersion: dept.version })
        ).status,
      ).toBe(403);
    }

    // Non-admin staff (sales) -> 403 everywhere.
    asRole('sales');
    expect((await request(baseUrl).get('/v1/admin/departments')).status).toBe(403);
    expect((await request(baseUrl).get('/v1/admin/departments/unassigned')).status).toBe(403);
    expect((await request(baseUrl).get(`/v1/admin/departments/${dept.id}`)).status).toBe(403);

    // Portal caller -> 403 even with grants.
    asGrants([['admin.roles.read', 'all']], { orgKind: 'customer' });
    expect((await request(baseUrl).get('/v1/admin/departments')).status).toBe(403);

    // Clean up: retire the test department.
    asRole('founder');
    const retired = await request(baseUrl)
      .post(`/v1/admin/departments/${dept.id}/retire`)
      .send({ expectedVersion: dept.version });
    expect(retired.status).toBe(200);
  });
});

describe('Department lifecycle: create, duplicate name, list, search, rename, retire and restore', () => {
  it('creates departments, refuses case-insensitive duplicate active names, supports search and unassigned list', async () => {
    const createSales = await request(baseUrl)
      .post('/v1/admin/departments')
      .send({ name: 'Sales', headUserId: ashaId });
    expect(createSales.status, JSON.stringify(createSales.body)).toBe(201);
    const sales = AdminDepartmentDetailSchema.parse(createSales.body);
    expect(sales).toMatchObject({
      name: 'Sales',
      status: 'active',
      retiredAt: null,
      head: { id: ashaId, name: 'Asha Thapa' },
      managers: 0,
      memberCount: 1,
      version: 1,
    });
    expect(sales.members[0]).toMatchObject({
      userId: ashaId,
      name: 'Asha Thapa',
      level: 'head',
      roles: ['sales'],
    });
    expect(sales.members[0]?.since).not.toBeNull();
    expect(invalidateSpy).toHaveBeenCalledWith(scope1A.tenantId, scope1A.organizationId);

    const salesAudit = await auditEventsOf(scope1A, sales.id);
    expect(salesAudit.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'department.created',
        'department.member.added',
        'department.head.changed',
      ]),
    );

    // Duplicate name in different letter case / spaces -> 422 on `name`.
    const dup = await request(baseUrl).post('/v1/admin/departments').send({ name: '  sAlEs  ' });
    expect(dup.status).toBe(422);
    const dupErr = errorOf(dup.body);
    expect(dupErr.code).toBe('unprocessable');
    expect(String(dupErr.details?.name ?? '')).toContain('already exists');

    // Inactive user or user from another entity as head -> 422 on `headUserId`.
    const badHeadInactive = await request(baseUrl)
      .post('/v1/admin/departments')
      .send({ name: 'Support', headUserId: inactiveUserId });
    expect(badHeadInactive.status).toBe(422);
    expect(errorOf(badHeadInactive.body).details?.headUserId).toBeDefined();

    const badHeadOtherEntity = await request(baseUrl)
      .post('/v1/admin/departments')
      .send({ name: 'Support', headUserId: entity1BUserId });
    expect(badHeadOtherEntity.status).toBe(422);

    // List + unassigned count + exact & fuzzy search.
    const listRes = await request(baseUrl).get('/v1/admin/departments');
    expect(listRes.status).toBe(200);
    const list = AdminDepartmentListSchema.parse(listRes.body);
    expect(list.items.find((d) => d.id === sales.id)).toMatchObject({
      name: 'Sales',
      status: 'active',
      head: { id: ashaId, name: 'Asha Thapa' },
      managers: 0,
      members: 1,
      version: 1,
    });
    // Active staff in 1A: founder, asha (in Sales), bikash, nisha, dipak -> 4 unassigned.
    expect(list.unassigned).toBe(4);

    const exactSearch = AdminDepartmentListSchema.parse(
      (await request(baseUrl).get('/v1/admin/departments?q=sal')).body,
    );
    expect(exactSearch.items.map((d) => d.name)).toContain('Sales');

    // A misspelling matches nothing: the screen shows "No department matches" with a way to clear the search.
    const misspelt = AdminDepartmentListSchema.parse(
      (await request(baseUrl).get('/v1/admin/departments?q=Slaes')).body,
    );
    expect(misspelt.items).toEqual([]);

    const unassignedRes = await request(baseUrl).get('/v1/admin/departments/unassigned');
    expect(unassignedRes.status).toBe(200);
    const unassigned = UnassignedPeopleResponseSchema.parse(unassignedRes.body);
    expect(unassigned.total).toBe(4);
    expect(unassigned.items.map((u) => u.userId)).toEqual(
      expect.arrayContaining([founderUserId, bikashId, nishaId, dipakId]),
    );
    expect(unassigned.items.find((u) => u.userId === dipakId)?.roles).toEqual(['finance', 'sales']);
  });

  it('renames a department with optimistic version check and audits it', async () => {
    const created = AdminDepartmentDetailSchema.parse(
      (await request(baseUrl).post('/v1/admin/departments').send({ name: 'Marketing' })).body,
    );

    const renamed = await request(baseUrl)
      .patch(`/v1/admin/departments/${created.id}`)
      .send({ name: 'Growth Marketing', expectedVersion: created.version });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const after = AdminDepartmentDetailSchema.parse(renamed.body);
    expect(after.name).toBe('Growth Marketing');
    expect(after.version).toBe(2);

    // Stale expectedVersion -> 409 conflict.
    const stale = await request(baseUrl)
      .patch(`/v1/admin/departments/${created.id}`)
      .send({ name: 'Marketing 2', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(errorOf(stale.body).code).toBe('conflict');

    // Rename colliding with existing active department -> 422 on `name`.
    const clash = await request(baseUrl)
      .patch(`/v1/admin/departments/${created.id}`)
      .send({ name: 'sales', expectedVersion: after.version });
    expect(clash.status).toBe(422);
    expect(errorOf(clash.body).details?.name).toBeDefined();

    const events = await auditEventsOf(scope1A, created.id);
    expect(events.map((e) => e.action)).toContain('department.renamed');
  });

  it('retires empty and populated departments, preserves historical records, and blocks restore on active name clash', async () => {
    const emptyDept = AdminDepartmentDetailSchema.parse(
      (await request(baseUrl).post('/v1/admin/departments').send({ name: 'Temporary Team' })).body,
    );

    // Retiring an empty department works without moveMembersTo.
    const retireEmpty = await request(baseUrl)
      .post(`/v1/admin/departments/${emptyDept.id}/retire`)
      .send({ expectedVersion: emptyDept.version });
    expect(retireEmpty.status).toBe(200);
    const retiredEmpty = AdminDepartmentDetailSchema.parse(retireEmpty.body);
    expect(retiredEmpty.status).toBe('retired');
    expect(retiredEmpty.retiredAt).not.toBeNull();
    expect(retiredEmpty.version).toBe(2);

    // Hidden from default list (active), visible when status=retired.
    const activeOnly = AdminDepartmentListSchema.parse(
      (await request(baseUrl).get('/v1/admin/departments')).body,
    );
    expect(activeOnly.items.some((d) => d.id === emptyDept.id)).toBe(false);
    const retiredOnly = AdminDepartmentListSchema.parse(
      (await request(baseUrl).get('/v1/admin/departments?status=retired')).body,
    );
    expect(retiredOnly.items.some((d) => d.id === emptyDept.id)).toBe(true);

    // Create a new active department with the same name -> restoring the retired one now fails 422.
    const replacement = AdminDepartmentDetailSchema.parse(
      (await request(baseUrl).post('/v1/admin/departments').send({ name: 'temporary team' })).body,
    );
    const restoreClash = await request(baseUrl)
      .post(`/v1/admin/departments/${emptyDept.id}/restore`)
      .send({ expectedVersion: retiredEmpty.version });
    expect(restoreClash.status).toBe(422);
    expect(errorOf(restoreClash.body).details?.name).toBeDefined();

    // Retire the replacement, then restore the original cleanly.
    await request(baseUrl)
      .post(`/v1/admin/departments/${replacement.id}/retire`)
      .send({ expectedVersion: replacement.version });
    const restoreOk = await request(baseUrl)
      .post(`/v1/admin/departments/${emptyDept.id}/restore`)
      .send({ expectedVersion: retiredEmpty.version });
    expect(restoreOk.status).toBe(200);
    const restored = AdminDepartmentDetailSchema.parse(restoreOk.body);
    expect(restored.status).toBe('active');
    expect(restored.retiredAt).toBeNull();
    expect(restored.version).toBe(3);
    expect((await auditEventsOf(scope1A, emptyDept.id)).map((e) => e.action)).toEqual(
      expect.arrayContaining(['department.retired', 'department.restored']),
    );

    // Populated department: retiring without moveMembersTo is refused with 422.
    const destDept = AdminDepartmentDetailSchema.parse(
      (
        await request(baseUrl)
          .post('/v1/admin/departments')
          .send({ name: 'Destination Ops', headUserId: nishaId })
      ).body,
    );
    const retiringDept = AdminDepartmentDetailSchema.parse(
      (
        await request(baseUrl)
          .post('/v1/admin/departments')
          .send({ name: 'Retiring Ops', headUserId: bikashId })
      ).body,
    );

    // Stamp a historical lead under retiringDept to verify it stays on the retired department.
    const leadId = randomUUID();
    await withTx(db, scope1A, systemActor('test-seed'), (tx) =>
      tx.execute(
        sql`INSERT INTO app.leads (id, tenant_id, organization_id, number, title, source, owner_user_id, department_id, company_name, contact_name)
            VALUES (${leadId}::uuid, ${scope1A.tenantId}::uuid, ${scope1A.organizationId}::uuid, 'LD-RET-1', 'Old lead', 'referral', ${bikashId}::uuid, ${retiringDept.id}::uuid, 'Acme', 'Sita')`,
      ),
    );

    const refusedRetire = await request(baseUrl)
      .post(`/v1/admin/departments/${retiringDept.id}/retire`)
      .send({ expectedVersion: retiringDept.version });
    expect(refusedRetire.status).toBe(422);
    expect(errorOf(refusedRetire.body).details?.moveMembersTo).toBeDefined();

    // Retire with moveMembersTo = destDept.id: moves Bikash, demotes him from head to manager
    // so Nisha remains head of destDept, and preserves the historical lead's department_id.
    invalidateSpy.mockClear();
    const movedRetire = await request(baseUrl)
      .post(`/v1/admin/departments/${retiringDept.id}/retire`)
      .send({ expectedVersion: retiringDept.version, moveMembersTo: destDept.id });
    expect(movedRetire.status, JSON.stringify(movedRetire.body)).toBe(200);
    const afterRetire = AdminDepartmentDetailSchema.parse(movedRetire.body);
    expect(afterRetire.status).toBe('retired');
    expect(afterRetire.head).toBeNull();
    expect(afterRetire.memberCount).toBe(0);
    expect(invalidateSpy).toHaveBeenCalledWith(scope1A.tenantId, scope1A.organizationId);

    const destAfter = AdminDepartmentDetailSchema.parse(
      (await request(baseUrl).get(`/v1/admin/departments/${destDept.id}`)).body,
    );
    expect(destAfter.head).toEqual({ id: nishaId, name: 'Nisha Gurung' });
    expect(destAfter.members.find((m) => m.userId === bikashId)?.level).toBe('manager');

    const [leadRow] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(leadRow?.departmentId).toBe(retiringDept.id);

    // Retire destDept with explicit moveMembersTo: null -> unassigns both Nisha and Bikash.
    const unassignRetire = await request(baseUrl)
      .post(`/v1/admin/departments/${destDept.id}/retire`)
      .send({ expectedVersion: destAfter.version, moveMembersTo: null });
    expect(unassignRetire.status, JSON.stringify(unassignRetire.body)).toBe(200);
    const unassignedNow = UnassignedPeopleResponseSchema.parse(
      (await request(baseUrl).get('/v1/admin/departments/unassigned')).body,
    );
    expect(unassignedNow.items.map((u) => u.userId)).toEqual(
      expect.arrayContaining([nishaId, bikashId]),
    );
  });
});

describe('Retiring a department with invited members', () => {
  async function seedMember(
    departmentId: string,
    level: 'staff' | 'manager',
    status: 'invited' | 'inactive',
  ): Promise<{ userId: string; zitadelUserId: string }> {
    const { userId } = await createStaffUser(appPool, { ...tenant1, roleKeys: ['sales'] });
    await withTx(db, scope1A, systemActor('test-seed'), async (tx) => {
      await tx.execute(
        sql`UPDATE app.users SET status = ${status}
             WHERE tenant_id = ${tenant1.tenantId}::uuid AND id = ${userId}::uuid`,
      );
      await tx.execute(
        sql`UPDATE app.user_entities SET department_id = ${departmentId}::uuid, level = ${level}
             WHERE tenant_id = ${tenant1.tenantId}::uuid AND organization_id = ${tenant1.organizationId}::uuid
               AND user_id = ${userId}::uuid`,
      );
    });
    const res = await ownerPool.query<{ zitadel_user_id: string }>(
      'SELECT zitadel_user_id FROM app.users WHERE id = $1',
      [userId],
    );
    return { userId, zitadelUserId: res.rows[0]!.zitadel_user_id };
  }

  async function membershipRow(
    userId: string,
  ): Promise<{ department_id: string | null; level: string }> {
    const res = await ownerPool.query<{ department_id: string | null; level: string }>(
      `SELECT department_id, level FROM app.user_entities
        WHERE tenant_id = $1 AND organization_id = $2 AND user_id = $3`,
      [tenant1.tenantId, tenant1.organizationId, userId],
    );
    return res.rows[0]!;
  }

  // The first-login path: the tenancy interceptor resolves the user (an invited row turns active) and
  // takes the department and level of the acting membership as the principal's reach.
  function mirror(): UserMirror {
    return new UserMirror(
      db,
      new SqlUsersStore(db),
      {} as unknown as ZitadelAdminClient,
      { add: () => Promise.resolve() } as unknown as Queue<UsersSyncData>,
    );
  }

  async function principalAtLogin(zitadelUserId: string): Promise<Principal> {
    const resolved = await mirror().resolve({
      zitadelUserId,
      tenantId: tenant1.tenantId,
      idpOrgId: tenant1.idpOrgId,
    });
    const membership = resolved.memberships.find(
      (m) => m.organizationId === tenant1.organizationId,
    );
    return {
      userId: resolved.userId,
      zitadelUserId,
      tenantId: tenant1.tenantId,
      organizationId: tenant1.organizationId,
      idpOrgId: tenant1.idpOrgId,
      orgKind: 'staff',
      partyId: null,
      status: resolved.status,
      roles: ['sales'],
      departmentId: membership?.departmentId ?? null,
      level: membership?.level ?? 'staff',
      grants: new Map<Permission, Scope>([['crm.lead.read', 'department']]),
    };
  }

  const leadIn = (departmentId: string): ResourceRef => ({
    tenantId: tenant1.tenantId,
    organizationId: tenant1.organizationId,
    ownerUserId: ashaId,
    departmentId,
  });

  it('unassigns invited members on retire without a destination, so their first login has no reach over the retired department', async () => {
    const dept = AdminDepartmentDetailSchema.parse(
      (await request(baseUrl).post('/v1/admin/departments').send({ name: 'Invite Desk' })).body,
    );
    const invited = await seedMember(dept.id, 'manager', 'invited');

    // Before the retire the membership reaches the department's leads.
    const before = await new SqlUsersStore(db).membershipsOf(db, tenant1.tenantId, invited.userId);
    expect(before[0]).toMatchObject({ departmentId: dept.id, level: 'manager' });

    // Only invited people: no destination is required, they are unassigned.
    const retired = await request(baseUrl)
      .post(`/v1/admin/departments/${dept.id}/retire`)
      .send({ expectedVersion: dept.version });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(await membershipRow(invited.userId)).toEqual({ department_id: null, level: 'staff' });
    const events = await auditEventsOf(scope1A, dept.id);
    expect(
      events.some(
        (e) => e.action === 'department.member.removed' && e.meta?.userId === invited.userId,
      ),
    ).toBe(true);

    const principal = await principalAtLogin(invited.zitadelUserId);
    expect(principal.status).toBe('active');
    expect(principal.departmentId).toBeNull();
    expect(principal.level).toBe('staff');
    expect(can(principal, 'crm.lead.read', leadIn(dept.id)).allowed).toBe(false);
  });

  it('moves invited members to the destination department on retire', async () => {
    const dest = AdminDepartmentDetailSchema.parse(
      (await request(baseUrl).post('/v1/admin/departments').send({ name: 'Invite Landing' })).body,
    );
    const dept = AdminDepartmentDetailSchema.parse(
      (await request(baseUrl).post('/v1/admin/departments').send({ name: 'Invite Source' })).body,
    );
    const invited = await seedMember(dept.id, 'manager', 'invited');

    const retired = await request(baseUrl)
      .post(`/v1/admin/departments/${dept.id}/retire`)
      .send({ expectedVersion: dept.version, moveMembersTo: dest.id });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(await membershipRow(invited.userId)).toEqual({
      department_id: dest.id,
      level: 'manager',
    });

    const principal = await principalAtLogin(invited.zitadelUserId);
    expect(principal.departmentId).toBe(dest.id);
    expect(can(principal, 'crm.lead.read', leadIn(dept.id)).allowed).toBe(false);
    expect(can(principal, 'crm.lead.read', leadIn(dest.id)).allowed).toBe(true);
  });

  it('gives no department reach from a membership still pointing at a retired department', async () => {
    const dept = AdminDepartmentDetailSchema.parse(
      (await request(baseUrl).post('/v1/admin/departments').send({ name: 'Dormant Desk' })).body,
    );
    // Inactive members are left in place by the retire; one coming back must not regain the reach.
    const dormant = await seedMember(dept.id, 'manager', 'inactive');
    const retired = await request(baseUrl)
      .post(`/v1/admin/departments/${dept.id}/retire`)
      .send({ expectedVersion: dept.version });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(await membershipRow(dormant.userId)).toEqual({
      department_id: dept.id,
      level: 'manager',
    });

    await withTx(db, scope1A, systemActor('test-seed'), (tx) =>
      tx.execute(
        sql`UPDATE app.users SET status = 'invited'
             WHERE tenant_id = ${tenant1.tenantId}::uuid AND id = ${dormant.userId}::uuid`,
      ),
    );
    const principal = await principalAtLogin(dormant.zitadelUserId);
    expect(principal.departmentId).toBeNull();
    expect(principal.level).toBe('staff');
    expect(can(principal, 'crm.lead.read', leadIn(dept.id)).allowed).toBe(false);
  });
});

describe('Tenant and legal entity isolation', () => {
  it('returns 404 across legal entities of the same tenant and across tenants, and never leaks lists', async () => {
    const dept1A = AdminDepartmentDetailSchema.parse(
      (await request(baseUrl).post('/v1/admin/departments').send({ name: 'Entity 1A Secret' }))
        .body,
    );

    // Caller in Entity 1B (same tenant, different legal entity).
    asRole('founder', { scope: scope1B, userId: entity1BUserId });
    expect((await request(baseUrl).get(`/v1/admin/departments/${dept1A.id}`)).status).toBe(404);
    expect(
      (
        await request(baseUrl)
          .patch(`/v1/admin/departments/${dept1A.id}`)
          .send({ name: 'Hijacked', expectedVersion: dept1A.version })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(baseUrl)
          .post(`/v1/admin/departments/${dept1A.id}/retire`)
          .send({ expectedVersion: dept1A.version })
      ).status,
    ).toBe(404);

    const list1B = AdminDepartmentListSchema.parse(
      (await request(baseUrl).get('/v1/admin/departments')).body,
    );
    expect(list1B.items).toHaveLength(0);
    expect(list1B.unassigned).toBe(1);

    // Caller in Tenant 2.
    asRole('founder', { scope: scope2A, userId: tenant2UserId });
    expect((await request(baseUrl).get(`/v1/admin/departments/${dept1A.id}`)).status).toBe(404);
    const list2A = AdminDepartmentListSchema.parse(
      (await request(baseUrl).get('/v1/admin/departments')).body,
    );
    expect(list2A.items).toHaveLength(0);
    expect(list2A.unassigned).toBe(1);
  });
});
