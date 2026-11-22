// Integration tests of portal access on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: every migration as bos_owner, queries as bos_app, the controller behind the production body parser and
// error filter, PortalAccessService, SqlPortalAccessStore, SqlUsersStore, the idempotency helper, AuditService,
// and then the tenancy path a token takes (IdpOrgResolver + UserMirror.resolve). Faked: ZITADEL (an in-memory
// client), the request context, and the users queue. Route-level @Can is the tenancy interceptor's job; the
// route-policy sweep (route-policy.check.test.ts) covers it now that AppModule imports PortalAccessModule.
// Run: pnpm --filter @bos/api exec vitest run src/modules/portal-access/portal-access.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DEFAULT_ROLE_PERMISSIONS, type Permission, type Scope } from '@bos/contracts';
import { createStaffUser, createTenantWithEntity } from '@bos/db';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { IdpOrgResolver } from '../../platform/tenancy/idp-org-resolver';
import { UserMirror } from '../../platform/users/user-mirror';
import type { UsersSyncData } from '../../platform/users/users.constants';
import { SqlUsersStore } from '../../platform/users/users.store';
import type {
  CreateHumanInput,
  ZitadelAdminClient,
  ZitadelUser,
} from '../../platform/users/zitadel-admin.client';
import { PortalAccessController } from './portal-access.controller';
import { PortalAccessService } from './portal-access.service';
import { SqlPortalAccessStore } from './portal-access.store';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const ADDRESS = { line: 'Durbar Marg 1', city: 'Kathmandu' };

/** In-memory ZITADEL with the calls PortalAccessService makes. */
class FakeZitadel {
  calls: string[] = [];
  orgs = new Map<string, string>();
  users: ZitadelUser[] = [];
  findOrganizationByName(name: string) {
    this.calls.push('findOrganizationByName');
    return Promise.resolve(this.orgs.get(name) ?? null);
  }
  createOrganization(name: string) {
    this.calls.push('createOrganization');
    const id = `z-org-${randomUUID()}`;
    this.orgs.set(name, id);
    return Promise.resolve(id);
  }
  ensureOrgLoginPolicy() {
    this.calls.push('ensureOrgLoginPolicy');
    return Promise.resolve('created' as const);
  }
  ensureProjectGrant() {
    this.calls.push('ensureProjectGrant');
    return Promise.resolve();
  }
  findHumanByUsername(orgId: string, username: string) {
    this.calls.push('findHumanByUsername');
    return Promise.resolve(
      this.users.find((u) => u.orgId === orgId && u.email === username) ?? null,
    );
  }
  createHuman(orgId: string, input: CreateHumanInput) {
    this.calls.push('createHuman');
    const id = `z-user-${randomUUID()}`;
    this.users.push({
      id,
      orgId,
      email: input.email,
      displayName: input.givenName,
      status: 'invited',
      createdAt: null,
    });
    return Promise.resolve(id);
  }
  setGrants() {
    this.calls.push('setGrants');
    return Promise.resolve();
  }
  sendInviteCode() {
    this.calls.push('sendInviteCode');
    return Promise.resolve();
  }
}

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
let scope: { tenantId: string; organizationId: string };
let scope2: { tenantId: string; organizationId: string };
let staffIdpOrgId: string;
let founder: string;
let sales: string;
const zitadel = new FakeZitadel();
const queue = { add: vi.fn().mockResolvedValue({}) } as unknown as Queue<UsersSyncData>;

const principalNow = (): Principal => ({
  userId: founder,
  zitadelUserId: `z-${founder}`,
  ...scope,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: staffIdpOrgId,
  roles: ['founder'],
  departmentId: null,
  status: 'active',
  grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS.founder)) as Map<Permission, Scope>,
});
const caller = {
  current: () => ({
    scope,
    actor: { kind: 'user' as const, id: founder, correlationId: 'test-corr' },
    principal: principalNow(),
  }),
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
  const tenant2 = await createTenantWithEntity(appPool);
  scope2 = { tenantId: tenant2.tenantId, organizationId: tenant2.organizationId };
  founder = (await createStaffUser(appPool, { ...scope, idpOrgId: staffIdpOrgId })).userId;
  sales = (await createStaffUser(appPool, { ...scope, idpOrgId: staffIdpOrgId })).userId;

  const audit = new AuditService(db);
  const store = new SqlPortalAccessStore(db, new SqlUsersStore(db), audit);
  const service = new PortalAccessService(store, zitadel as unknown as ZitadelAdminClient, caller);
  const moduleRef = await Test.createTestingModule({
    controllers: [PortalAccessController],
    providers: [{ provide: PortalAccessService, useValue: service }],
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
});

// ---------------------------------------------------------------------------------------------- helpers

/**
 * A customer in `s`'s tenant with one contact, and its KYB case in `kyb` (none when null). No portal org yet:
 * the party is inserted here rather than with the `createParty` fixture, because that fixture also links an
 * idp_orgs row, which would make every grant take the reused-org path (no org created, linked or audited).
 */
async function newCustomer(
  kyb: 'approved' | 'submitted' | null,
  s = scope,
  email: string | null = `ana-${randomUUID().slice(0, 8)}@acme.test`,
  // F1-Q31: the account owner invites the first portal admin. The caller (founder) owns it unless a test says not.
  owner: string | null = s === scope ? founder : null,
): Promise<{ customerId: string; contactId: string }> {
  const partyId = randomUUID();
  const contactId = randomUUID();
  await withTx(db, s, systemActor('test'), async (tx) => {
    await tx.execute(
      sql`INSERT INTO app.parties (id, tenant_id, kind, code, name)
          VALUES (${partyId}, ${s.tenantId}, 'customer', ${`P-${partyId.slice(0, 8)}`}, 'Acme Pvt. Ltd.')`,
    );
    await tx.execute(
      sql`INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address_line, address_city, owner_user_id)
          VALUES (${partyId}, ${s.tenantId}, ${`CUS-${partyId.slice(0, 8)}`}, 'Acme Pvt. Ltd.', 'acme',
                  ${ADDRESS.line}, ${ADDRESS.city}, ${owner})`,
    );
    await tx.execute(
      sql`INSERT INTO app.customer_contacts (id, tenant_id, customer_id, full_name, email_norm)
          VALUES (${contactId}, ${s.tenantId}, ${partyId}, 'Ana Bista', ${email})`,
    );
    if (kyb !== null) {
      const decided = kyb === 'approved';
      await tx.execute(
        sql`INSERT INTO app.verification_cases
              (tenant_id, party_id, status, submitted_by_user_id, submitted_at, reviewer_user_id, decided_at)
            VALUES (${s.tenantId}, ${partyId}, ${kyb}, ${s === scope ? sales : null}, now(),
                    ${decided && s === scope ? founder : null}, ${decided ? sql`now()` : null})`,
      );
    }
  });
  return { customerId: partyId, contactId };
}

const grant = (customerId: string, contactId: string, key = randomUUID()) =>
  request(baseUrl)
    .post(`/v1/customers/${customerId}/portal-access`)
    .set('Idempotency-Key', key)
    .send({ contactId });

async function rows<T>(query: string, values: unknown[]): Promise<T[]> {
  return (await appPool.query(query, values)).rows as T[];
}

// ------------------------------------------------------------------------------------------------ tests

describe('POST /v1/customers/:id/portal-access', () => {
  it('writes the idp_orgs row and an invited customer_user, and the new user resolves as a customer principal', async () => {
    const { customerId, contactId } = await newCustomer('approved');
    const res = await grant(customerId, contactId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = res.body as { userId: string; idpOrgId: string; inviteSent: boolean };
    expect(body.inviteSent).toBe(true);

    const [org] = await rows<{
      id: string;
      kind: string;
      party_id: string;
      zitadel_org_id: string;
    }>(
      'SELECT id, kind, party_id, zitadel_org_id FROM app.idp_orgs WHERE tenant_id = $1 AND party_id = $2',
      [scope.tenantId, customerId],
    );
    expect(org).toMatchObject({ id: body.idpOrgId, kind: 'customer', party_id: customerId });
    const [user] = await rows<{
      id: string;
      idp_org_id: string;
      status: string;
      zitadel_user_id: string;
    }>('SELECT id, idp_org_id, status, zitadel_user_id FROM app.users WHERE id = $1', [
      body.userId,
    ]);
    expect(user).toMatchObject({ idp_org_id: body.idpOrgId, status: 'invited' });
    const roles = await rows<{ role_key: string }>(
      'SELECT role_key FROM app.user_roles WHERE tenant_id = $1 AND user_id = $2',
      [scope.tenantId, body.userId],
    );
    expect(roles.map((r) => r.role_key)).toEqual(['customer_user']);
    const audit = await ownerPool.query<{ action: string }>(
      `SELECT action FROM audit.audit_events
        WHERE entity_type = 'customer' AND entity_id = $1 AND action LIKE 'portal_access.%' ORDER BY id`,
      [customerId],
    );
    expect(audit.rows.map((a) => a.action)).toEqual([
      'portal_access.requested',
      'portal_access.org_linked',
      'portal_access.zitadel_org_created',
      'portal_access.login_policy_pinned',
      'portal_access.project_granted',
      'portal_access.zitadel_user_created',
      'portal_access.role_granted',
      'portal_access.invite_sent',
      'portal_access.granted',
    ]);

    // What the tenancy interceptor does with a token from the new org: the org resolves to the customer
    // party, and the user row is found (and turns active, as an accepted invite does).
    const resolved = await new IdpOrgResolver(db, () => Date.now()).resolve(org!.zitadel_org_id);
    expect(resolved).toMatchObject({
      kind: 'customer',
      partyId: customerId,
      tenantId: scope.tenantId,
    });
    const mirror = new UserMirror(
      db,
      new SqlUsersStore(db),
      zitadel as unknown as ZitadelAdminClient,
      queue,
    );
    const me = await mirror.resolve({
      zitadelUserId: user!.zitadel_user_id,
      tenantId: resolved.tenantId,
      idpOrgId: resolved.idpOrgId,
    });
    expect(me).toMatchObject({
      userId: body.userId,
      idpOrgId: body.idpOrgId,
      status: 'active',
      memberships: [],
    });
  });

  it('replays the same key and reuses the org and user on a new key', async () => {
    const { customerId, contactId } = await newCustomer('approved');
    const key = randomUUID();
    const first = await grant(customerId, contactId, key);
    expect(first.status).toBe(201);
    const replay = await grant(customerId, contactId, key);
    expect(replay.body).toEqual(first.body);
    zitadel.calls = [];
    const again = await grant(customerId, contactId);
    expect(again.status).toBe(201);
    expect((again.body as { userId: string }).userId).toBe(
      (first.body as { userId: string }).userId,
    );
    expect(zitadel.calls).not.toContain('createOrganization');
    expect(zitadel.calls).not.toContain('createHuman');
    expect(zitadel.calls).not.toContain('sendInviteCode');
    const orgs = await rows('SELECT 1 FROM app.idp_orgs WHERE party_id = $1', [customerId]);
    expect(orgs).toHaveLength(1);
  });

  it('answers 409 kyb_not_verified for a submitted case and for no case, writing nothing', async () => {
    for (const kyb of ['submitted', null] as const) {
      const { customerId, contactId } = await newCustomer(kyb);
      const res = await grant(customerId, contactId);
      expect(res.status).toBe(409);
      // ErrorBodyFilter keeps the code only because kyb_not_verified is in its CONFLICT_CODES.
      expect((res.body as { error: { code: string } }).error.code).toBe('kyb_not_verified');
      expect(
        await rows('SELECT 1 FROM app.idp_orgs WHERE party_id = $1', [customerId]),
      ).toHaveLength(0);
    }
  });

  it('answers 400 for a contact without an email', async () => {
    const { customerId, contactId } = await newCustomer('approved', scope, null);
    const res = await grant(customerId, contactId);
    // The error filter turns any 400 into code bad_request (contact_email_missing is not a known reason).
    expect(res.status).toBe(400);
  });

  describe('first portal admin (F1-Q31)', () => {
    const codeOf = (res: request.Response) => (res.body as { error: { code: string } }).error.code;

    it('refuses 409 first_admin_owner_only when the caller is not the account owner, writing nothing', async () => {
      const { customerId, contactId } = await newCustomer('approved', scope, undefined, sales);
      const before = zitadel.calls.length;
      const res = await grant(customerId, contactId);
      expect(res.status).toBe(409);
      expect(codeOf(res)).toBe('first_admin_owner_only');
      expect(zitadel.calls.length).toBe(before);
      expect(
        await rows('SELECT 1 FROM app.idp_orgs WHERE party_id = $1', [customerId]),
      ).toHaveLength(0);
    });

    it('refuses 409 account_owner_missing when the customer has no account owner', async () => {
      const { customerId, contactId } = await newCustomer('approved', scope, undefined, null);
      const res = await grant(customerId, contactId);
      expect(res.status).toBe(409);
      expect(codeOf(res)).toBe('account_owner_missing');
    });

    it('answers 404 for a contact of another customer in the same tenant, before ZITADEL', async () => {
      const { customerId } = await newCustomer('approved');
      const other = await newCustomer('approved');
      const before = zitadel.calls.length;
      const res = await grant(customerId, other.contactId);
      expect(res.status).toBe(404);
      expect((res.body as { error: { message: string } }).error.message).toContain(
        'existing contacts',
      );
      expect(zitadel.calls.length).toBe(before);
    });

    it('lets a non-owner holding customer.write grant again once the first admin exists', async () => {
      const { customerId, contactId } = await newCustomer('approved');
      expect((await grant(customerId, contactId)).status).toBe(201);
      await withTx(db, scope, systemActor('test'), (tx) =>
        tx.execute(sql`UPDATE app.customers SET owner_user_id = ${sales} WHERE id = ${customerId}`),
      );
      const again = await grant(customerId, contactId);
      expect(again.status).toBe(201);
    });
  });

  it('answers 404 for a customer of another tenant', async () => {
    const { customerId, contactId } = await newCustomer(null, scope2);
    expect((await grant(customerId, contactId)).status).toBe(404);
  });
});
