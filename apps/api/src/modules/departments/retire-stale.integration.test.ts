// Integration tests for the retire dialog's member check (U20b-Q6): the dialog sends the active member
// ids it showed as `expectedMemberIds`, and the API refuses with 409 `members_changed` (moving nobody)
// when the department's active members differ. Real Postgres 16 container (Testcontainers, needs
// Docker), real migrations, real bos_app role, real DepartmentsAdminController + service +
// AuditService + AccessRevisionTableStore + ErrorBodyFilter.
// Run: pnpm --filter @bos/api exec vitest run src/modules/departments/retire-stale.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  AdminDepartmentDetailSchema,
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  type Permission,
  type Scope,
} from '@bos/contracts';
import {
  createStaffUser,
  createTenantWithEntity,
  runMigrations,
  type TenantWithEntity,
} from '@bos/db';
import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import type { Principal, ResourceRef } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { type Actor, systemActor, type TxScope, withTx } from '../../platform/db/tx';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
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
let scope1: TxScope;
let tenant2: TenantWithEntity;
let founderUserId: string;
let tenant2UserId: string;

const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;

function founderPrincipal(): Principal {
  return {
    userId: founderUserId,
    zitadelUserId: `test-sub-${founderUserId}`,
    tenantId: scope1.tenantId,
    organizationId: scope1.organizationId,
    idpOrgId: tenant1.idpOrgId,
    orgKind: 'staff',
    partyId: null,
    status: 'active',
    roles: [],
    departmentId: null,
    grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS.founder) as [Permission, Scope][]),
  };
}

/** Puts a person into a department (or none) directly, as another admin's save would. */
async function placeIn(userId: string, departmentId: string | null): Promise<void> {
  await withTx(db, scope1, systemActor('test-seed'), (tx) =>
    tx.execute(
      sql`UPDATE app.user_entities SET department_id = ${departmentId}::uuid, level = 'staff'
           WHERE tenant_id = ${tenant1.tenantId}::uuid AND organization_id = ${tenant1.organizationId}::uuid
             AND user_id = ${userId}::uuid`,
    ),
  );
}

/** A new staff member of tenant 1 (active unless told otherwise) placed into a department. */
async function seedMember(
  departmentId: string,
  status: 'active' | 'invited' = 'active',
): Promise<string> {
  const { userId } = await createStaffUser(appPool, { ...tenant1, roleKeys: ['sales'] });
  await withTx(db, scope1, systemActor('test-seed'), (tx) =>
    tx.execute(
      sql`UPDATE app.users SET status = ${status}
           WHERE tenant_id = ${tenant1.tenantId}::uuid AND id = ${userId}::uuid`,
    ),
  );
  await placeIn(userId, departmentId);
  return userId;
}

async function departmentOf(userId: string): Promise<string | null> {
  const res = await ownerPool.query<{ department_id: string | null }>(
    `SELECT department_id FROM app.user_entities
      WHERE tenant_id = $1 AND organization_id = $2 AND user_id = $3`,
    [tenant1.tenantId, tenant1.organizationId, userId],
  );
  return res.rows[0]!.department_id;
}

async function createDepartment(name: string) {
  const res = await request(baseUrl).post('/v1/admin/departments').send({ name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return AdminDepartmentDetailSchema.parse(res.body);
}

/** What the retire dialog loads when it opens: the detail's active member ids and version. */
async function openDialog(id: string) {
  const res = await request(baseUrl).get(`/v1/admin/departments/${id}`);
  expect(res.status).toBe(200);
  const detail = AdminDepartmentDetailSchema.parse(res.body);
  return { version: detail.version, memberIds: detail.members.map((m) => m.userId) };
}

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

  tenant1 = await createTenantWithEntity(appPool);
  scope1 = { tenantId: tenant1.tenantId, organizationId: tenant1.organizationId };
  founderUserId = (await createStaffUser(appPool, { ...tenant1, roleKeys: ['founder'] })).userId;

  tenant2 = await createTenantWithEntity(appPool);
  tenant2UserId = (await createStaffUser(appPool, { ...tenant2, roleKeys: ['sales'] })).userId;

  const caller: DepartmentsCaller = {
    tx: () => ({
      scope: scope1,
      actor: {
        kind: 'user',
        id: founderUserId,
        correlationId: `test:${randomUUID()}`,
      } satisfies Actor,
    }),
    principal: () => founderPrincipal(),
  };
  const authz = {
    assert(action: Permission, ref?: ResourceRef): void {
      const decision = can(founderPrincipal(), action, ref);
      if (!decision.allowed) {
        throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden' });
      }
    },
    invalidate: vi.fn(() => Promise.resolve()),
  } as unknown as AuthzService;

  const service = new DepartmentsAdminService(
    db,
    caller,
    authz,
    new AuditService(db),
    new AccessRevisionTableStore(),
  );
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

describe('Retire checks the members the dialog showed', () => {
  it('refuses with 409 and moves nobody when someone joined after the dialog opened', async () => {
    const dept = await createDepartment('Field Ops');
    const destination = await createDepartment('Field Ops Destination');
    const shown = await seedMember(dept.id);
    const dialog = await openDialog(dept.id);
    expect(dialog.memberIds).toEqual([shown]);

    const latecomer = await seedMember(dept.id);

    const res = await request(baseUrl).post(`/v1/admin/departments/${dept.id}/retire`).send({
      expectedVersion: dialog.version,
      moveMembersTo: destination.id,
      expectedMemberIds: dialog.memberIds,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(errorOf(res.body).code).toBe('members_changed');

    expect(await departmentOf(shown)).toBe(dept.id);
    expect(await departmentOf(latecomer)).toBe(dept.id);
    const after = AdminDepartmentDetailSchema.parse(
      (await request(baseUrl).get(`/v1/admin/departments/${dept.id}`)).body,
    );
    expect(after.status).toBe('active');
    expect(after.version).toBe(dialog.version);
  });

  it('refuses an empty dialog list once someone has joined, instead of unassigning them', async () => {
    const dept = await createDepartment('Empty Then Not');
    const dialog = await openDialog(dept.id);
    expect(dialog.memberIds).toEqual([]);
    const latecomer = await seedMember(dept.id);

    const res = await request(baseUrl)
      .post(`/v1/admin/departments/${dept.id}/retire`)
      .send({ expectedVersion: dialog.version, moveMembersTo: null, expectedMemberIds: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(errorOf(res.body).code).toBe('members_changed');
    expect(await departmentOf(latecomer)).toBe(dept.id);
  });

  it('refuses when someone shown has left, or an id from another tenant is sent', async () => {
    const dept = await createDepartment('Leavers');
    const stays = await seedMember(dept.id);
    const leaves = await seedMember(dept.id);
    const dialog = await openDialog(dept.id);
    expect(new Set(dialog.memberIds)).toEqual(new Set([stays, leaves]));
    await placeIn(leaves, null);

    const left = await request(baseUrl).post(`/v1/admin/departments/${dept.id}/retire`).send({
      expectedVersion: dialog.version,
      moveMembersTo: null,
      expectedMemberIds: dialog.memberIds,
    });
    expect(left.status, JSON.stringify(left.body)).toBe(409);
    expect(errorOf(left.body).code).toBe('members_changed');

    const foreign = await request(baseUrl)
      .post(`/v1/admin/departments/${dept.id}/retire`)
      .send({
        expectedVersion: dialog.version,
        moveMembersTo: null,
        expectedMemberIds: [stays, tenant2UserId],
      });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(409);
    expect(errorOf(foreign.body).code).toBe('members_changed');
    expect(await departmentOf(stays)).toBe(dept.id);
  });

  it('retires and moves everyone when the list is unchanged, in any order', async () => {
    const dept = await createDepartment('Unchanged Ops');
    const destination = await createDepartment('Unchanged Destination');
    const first = await seedMember(dept.id);
    const second = await seedMember(dept.id);
    // Someone only invited is not in the dialog's list and does not make it stale; the retire still
    // takes them along, as before.
    const invited = await seedMember(dept.id, 'invited');
    const dialog = await openDialog(dept.id);
    expect(new Set(dialog.memberIds)).toEqual(new Set([first, second]));

    const res = await request(baseUrl)
      .post(`/v1/admin/departments/${dept.id}/retire`)
      .send({
        expectedVersion: dialog.version,
        moveMembersTo: destination.id,
        expectedMemberIds: [...dialog.memberIds].reverse(),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(AdminDepartmentDetailSchema.parse(res.body).status).toBe('retired');
    expect(await departmentOf(first)).toBe(destination.id);
    expect(await departmentOf(second)).toBe(destination.id);
    expect(await departmentOf(invited)).toBe(destination.id);
  });
});
