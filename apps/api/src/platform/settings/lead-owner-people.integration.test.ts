// The Settings > Sales "Lead owner" card (crm.default_lead_owner, R4a Q10) end to end over HTTP against real Postgres.
// The card used to read its people from GET /v1/leads/owners, which needs crm.lead.write, so a role edited to hold
// admin.settings.write without lead access got an error on the card. It now reads GET
// /v1/admin/settings/crm.default_lead_owner/people, gated like the setting itself, and the save refuses a person the
// lead fallback would skip.
// Real: Postgres (createTestDatabase, all migrations, queries as bos_app), SettingsService, RoleCache over the
// tenant's own role_permissions rows (the caller's grants are what RoleCache gives their roles), the controllers
// behind the production body parser and ErrorBodyFilter, the request store, requestTx and withTx. The route marker is
// enforced by a guard making the same decision as TenancyInterceptor.enforce (@Can, else @AnyAuthenticated, else
// deny). "Custom role" here is a built-in role key whose grants the tenant edited (the access settings model).
// Fakes: MoneyService and LeadsService (never reached on the leads route: the guard refuses first).
// Run: pnpm --filter @bos/api exec vitest run src/platform/settings/lead-owner-people.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  type Permission,
  ROLE_KEYS,
  type RoleKey,
} from '@bos/contracts';
import {
  createDepartment,
  createParty,
  createPortalUser,
  createStaffUser,
  createTenantWithEntity,
  userEntities,
  users,
} from '@bos/db';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { LeadsController } from '../../modules/leads/leads.controller';
import { LeadsService } from '../../modules/leads/leads.service';
import { can, type DenyReason, type Principal } from '../authz/can';
import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../authz/decorators';
import { principal } from '../authz/principal';
import { RoleCache } from '../authz/role-cache';
import { DB, type Db } from '../db/db.module';
import { systemActor, withTx, type TxScope } from '../db/tx';
import { ErrorBodyFilter } from '../tenancy/error-body.filter';
import { bindIdentity, bindPrincipal, runWithRequestStore } from '../tenancy/request-context';
import { MoneyService } from './money.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const KEY = 'crm.default_lead_owner';
/** The built-in role this tenant edited into a settings-only role: admin.settings.write, no crm.lead.*. */
const CUSTOM_ROLE: RoleKey = 'warehouse';

let testDb: TestDatabase;
let pool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
let roleCache: RoleCache;
let scope: TxScope;
let idpOrgId: string;

interface Person {
  userId: string;
  roles: RoleKey[];
  departmentId: string | null;
}

/** The principal every following HTTP request runs as. */
let caller: Principal;

/** The person as the tenancy interceptor would bind them: their roles' grants from RoleCache. */
async function principalOf(person: Person, at: TxScope = scope): Promise<Principal> {
  const grants = await roleCache.grantsFor(at.tenantId, at.organizationId, person.roles, 'staff');
  return {
    userId: person.userId,
    zitadelUserId: `zitadel-${person.userId}`,
    tenantId: at.tenantId,
    organizationId: at.organizationId,
    orgKind: 'staff',
    partyId: null,
    idpOrgId,
    roles: person.roles,
    departmentId: person.departmentId,
    level: 'staff',
    status: 'active',
    grants: new Map(grants),
  };
}

const forbidden = (reason: DenyReason) =>
  new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason });

/** The same route-level decision as TenancyInterceptor.enforce. */
class RouteMarkerGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const action = this.reflector.getAllAndOverride<Permission | undefined>(CAN_KEY, targets);
    if (action !== undefined) {
      const decision = can(principal(), action);
      if (!decision.allowed) throw forbidden(decision.reason);
      return true;
    }
    const anyAuthenticated = this.reflector.getAllAndOverride<boolean | undefined>(
      ANY_AUTHENTICATED_KEY,
      targets,
    );
    if (anyAuthenticated === true) {
      if (principal().status !== 'active') throw forbidden('inactive_user');
      return true;
    }
    throw forbidden('no_permission');
  }
}

function bindRequest(_req: Request, _res: Response, next: NextFunction): void {
  const p = caller;
  runWithRequestStore(`it-lead-owner-${randomUUID()}`, () => {
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
    next();
  });
}

/** The tenant's role table: every code default, with CUSTOM_ROLE replaced by admin.settings.write alone. */
async function seedPolicy(at: TxScope): Promise<void> {
  await withTx(db, at, systemActor('test-seed'), async (tx) => {
    for (const role of ROLE_KEYS) {
      const grants: [string, string | undefined][] =
        role === CUSTOM_ROLE
          ? [['admin.settings.write', 'all']]
          : Object.entries(DEFAULT_ROLE_PERMISSIONS[role]);
      for (const [permission, grantScope] of grants) {
        if (grantScope === undefined) continue;
        await tx.execute(sql`
          INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
          VALUES (${at.tenantId}, ${role}, ${permission}, ${grantScope}, ${role !== CUSTOM_ROLE})
        `);
      }
    }
  });
}

async function staff(
  at: TxScope & { idpOrgId: string },
  roles: RoleKey[],
  displayName: string,
  departmentId: string | null = null,
): Promise<Person> {
  const { userId } = await createStaffUser(pool, {
    ...at,
    roleKeys: roles,
    ...(departmentId === null ? {} : { departmentId }),
  });
  await withTx(db, at, systemActor('test'), (tx) =>
    tx.update(users).set({ displayName }).where(eq(users.id, userId)),
  );
  return { userId, roles, departmentId };
}

let founder: Person;
let salesInDept: Person;
let salesNoDept: Person;
let marketing: Person;
let management: Person;
let settingsOnly: Person;
let inactiveSales: Person;
let portalUserId: string;
let foreignSales: Person;
let foreignScope: TxScope;
let foreignIdpOrgId: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  pool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  pool.on('error', () => undefined);
  db = drizzle({ client: pool });

  const tenant = await createTenantWithEntity(pool);
  scope = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  idpOrgId = tenant.idpOrgId;
  await seedPolicy(scope);
  const { departmentId: salesDept } = await createDepartment(pool, {
    ...scope,
    name: 'Sales',
  });

  founder = await staff(tenant, ['founder'], 'Fulmaya Founder');
  salesInDept = await staff(tenant, ['sales'], 'Ram Thapa', salesDept);
  salesNoDept = await staff(tenant, ['sales'], 'Sita Rai');
  marketing = await staff(tenant, ['marketing'], 'Maya Gurung', salesDept);
  management = await staff(tenant, ['management'], 'Manish Shrestha', salesDept);
  settingsOnly = await staff(tenant, [CUSTOM_ROLE], 'Suman Settings', salesDept);
  inactiveSales = await staff(tenant, ['sales'], 'Inactive Sales', salesDept);
  await withTx(db, scope, systemActor('test'), (tx) =>
    tx.update(users).set({ status: 'inactive' }).where(eq(users.id, inactiveSales.userId)),
  );
  const customer = await createParty(pool, { tenantId: scope.tenantId, kind: 'customer' });
  portalUserId = (
    await createPortalUser(pool, {
      tenantId: scope.tenantId,
      idpOrgId: customer.idpOrgId,
    })
  ).userId;

  const other = await createTenantWithEntity(pool);
  foreignScope = { tenantId: other.tenantId, organizationId: other.organizationId };
  foreignIdpOrgId = other.idpOrgId;
  const { departmentId: foreignDept } = await createDepartment(pool, {
    ...foreignScope,
    name: 'Sales',
  });
  foreignSales = await staff(other, ['sales'], 'Foreign Sales', foreignDept);

  // Built after the seed, so its first read is the tenant's own rows, not the code defaults.
  roleCache = new RoleCache(db);

  const moduleRef = await Test.createTestingModule({
    controllers: [SettingsController, LeadsController],
    providers: [
      { provide: DB, useValue: db },
      { provide: RoleCache, useValue: roleCache },
      SettingsService,
      { provide: MoneyService, useValue: {} },
      { provide: LeadsService, useValue: { owners: () => Promise.resolve([]) } },
      {
        provide: APP_GUARD,
        useFactory: (r: Reflector) => new RouteMarkerGuard(r),
        inject: [Reflector],
      },
    ],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  app.use(bindRequest);
  configureApp(app);
  app.useGlobalFilters(new ErrorBodyFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await testDb?.drop();
});

const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;

const people = () => request(baseUrl).get(`/v1/admin/settings/${KEY}/people`);
const save = (value: unknown) => request(baseUrl).put(`/v1/admin/settings/${KEY}`).send({ value });
const stored = async () =>
  (await request(baseUrl).get(`/v1/admin/settings/${KEY}`)).body as unknown;

describe('GET /v1/admin/settings/crm.default_lead_owner/people', () => {
  it('lists only the people a new lead may fall back to, by id, name and role alone (BOS-UI-001)', async () => {
    caller = await principalOf(founder);
    const res = await people();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Not the Founder or Marketing (an intake lead goes to Sales), not a Sales user without a department, not
    // Management (no lead write), not the settings-only role, the inactive user, a portal user or another tenant.
    expect(res.body).toEqual([{ userId: salesInDept.userId, displayName: 'Ram Thapa', role: 'Sales' }]);
    expect(JSON.stringify(res.body)).not.toContain(portalUserId);
  });

  it('marks the Sales head, the person an unset setting stands for, so the card names them (BOS-UI-001)', async () => {
    const setLevel = (level: 'head' | 'staff') =>
      withTx(db, scope, systemActor('test'), (tx) =>
        tx
          .update(userEntities)
          .set({ level })
          .where(eq(userEntities.userId, salesInDept.userId)),
      );
    caller = await principalOf(founder);
    await setLevel('head');
    try {
      const res = await people();
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual([
        { userId: salesInDept.userId, displayName: 'Ram Thapa', role: 'Sales', salesHead: true },
      ]);
    } finally {
      await setLevel('staff');
    }
    // No head: nobody is marked, so the card has no one to name.
    expect(JSON.stringify((await people()).body)).not.toContain('salesHead');
  });

  it('answers 403 to a caller who may not edit the setting, lead access or not', async () => {
    caller = await principalOf(salesInDept);
    expect(caller.grants.has('crm.lead.write')).toBe(true);
    const res = await people();
    expect(res.status).toBe(403);
    expect(errorOf(res.body)).toMatchObject({ code: 'forbidden', reason: 'no_permission' });
  });

  it("lists another tenant's own people to its Founder, never this tenant's", async () => {
    const foreignFounder = await staff(
      { ...foreignScope, idpOrgId: foreignIdpOrgId },
      ['founder'],
      'Foreign Founder',
    );
    caller = await principalOf(foreignFounder, foreignScope);
    const res = await people();
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ userId: foreignSales.userId, displayName: 'Foreign Sales', role: 'Sales' }]);

    // Nor may it save one of this tenant's people as its default.
    const refused = await save(salesInDept.userId);
    expect(refused.status).toBe(400);
    expect(errorOf(refused.body).details).toEqual({ assignmentReason: 'not_active_staff' });
  });
});

describe('PUT /v1/admin/settings/crm.default_lead_owner checks the person', () => {
  it.each([
    ['an inactive user', () => inactiveSales.userId, 'not_active_staff'],
    ['a portal user', () => portalUserId, 'not_active_staff'],
    ['an unknown id', () => randomUUID(), 'not_active_staff'],
    ['a Management user (not Sales)', () => management.userId, 'sales_owner_required'],
    ['a Marketing user', () => marketing.userId, 'sales_owner_required'],
    ['a Sales user without a department', () => salesNoDept.userId, 'no_department'],
  ])('refuses %s with 400 and keeps the stored value', async (_label, id, reason) => {
    caller = await principalOf(founder);
    const before = await stored();
    const res = await save(id());
    expect(res.status).toBe(400);
    expect(errorOf(res.body)).toMatchObject({
      code: 'bad_request',
      message: 'This person cannot be given new leads. Choose someone from the list.',
      details: { assignmentReason: reason },
    });
    expect(await stored()).toEqual(before);
  });

  it('refuses, and does not list, a Sales user whose role lost lead write', async () => {
    // A tenant whose Sales role was edited to read leads only. Edited before anything reads the tenant, so the
    // role cache's first load already holds the edit.
    const t = await createTenantWithEntity(pool);
    const at = { tenantId: t.tenantId, organizationId: t.organizationId };
    await seedPolicy(at);
    await withTx(db, at, systemActor('test'), (tx) =>
      tx.execute(sql`
        DELETE FROM app.role_permissions
         WHERE tenant_id = ${at.tenantId} AND role_key = 'sales' AND permission = 'crm.lead.write'
      `),
    );
    const { departmentId } = await createDepartment(pool, { ...at, name: 'Sales' });
    const readOnlySales = await staff(t, ['sales'], 'Read Only', departmentId);
    caller = await principalOf(await staff(t, ['founder'], 'Edited Founder'), at);

    const listed = await people();
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([]);
    const res = await save(readOnlySales.userId);
    expect(res.status).toBe(400);
    expect(errorOf(res.body).details).toEqual({ assignmentReason: 'cannot_read_subject' });
  });

  it('refuses a value that is not an id with 400 before any lookup', async () => {
    caller = await principalOf(founder);
    const res = await save('Ram Thapa');
    expect(res.status).toBe(400);
    expect(errorOf(res.body).code).toBe('bad_request');
  });

  it('saves a listed person, then clears back to the Sales head', async () => {
    caller = await principalOf(founder);
    expect((await save(salesInDept.userId)).status).toBe(200);
    expect(await stored()).toMatchObject({ value: salesInDept.userId });
    expect((await save(null)).status).toBe(200);
    expect(await stored()).toMatchObject({ value: null });
  });
});

describe('the Lead owner card for a role with admin.settings.write and no lead access', () => {
  it('reads the people and saves one, while the lead owner route stays refused', async () => {
    caller = await principalOf(settingsOnly);
    expect(caller.grants.has('admin.settings.write')).toBe(true);
    expect(caller.grants.has('crm.lead.write')).toBe(false);
    expect(caller.grants.has('crm.lead.read')).toBe(false);

    // What the card read before R4a Q10: refused for this role.
    expect((await request(baseUrl).get('/v1/leads/owners?context=create')).status).toBe(403);

    const res = await people();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([{ userId: salesInDept.userId, displayName: 'Ram Thapa', role: 'Sales' }]);
    expect((await request(baseUrl).get(`/v1/admin/settings/${KEY}`)).status).toBe(200);
    try {
      expect((await save(salesInDept.userId)).status).toBe(200);
      expect(await stored()).toMatchObject({ value: salesInDept.userId });
    } finally {
      await save(null);
    }
  });
});
