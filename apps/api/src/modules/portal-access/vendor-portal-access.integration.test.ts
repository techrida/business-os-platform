// Integration tests of the vendor portal grant (K4) on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: every migration as bos_owner, queries as bos_app, VendorPortalAccessService, SqlPortalAccessStore,
// SqlUsersStore, the idempotency helper, AuditService, the login policy reconciler's drizzle store, and the tenancy
// path a token takes (IdpOrgResolver). Faked: ZITADEL (an in-memory client) and the request context. There is no
// vendor route yet (the lead wires `POST /v1/vendors/:id/portal-access`), so the service is called directly.
// Run: pnpm --filter @bos/api exec vitest run src/modules/portal-access/vendor-portal-access.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { DEFAULT_ROLE_PERMISSIONS, type Permission, type Scope } from '@bos/contracts';
import { createStaffUser, createTenantWithEntity } from '@bos/db';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { IdpOrgResolver } from '../../platform/tenancy/idp-org-resolver';
import { SqlUsersStore } from '../../platform/users/users.store';
import type {
  CreateHumanInput,
  ZitadelAdminClient,
  ZitadelUser,
} from '../../platform/users/zitadel-admin.client';
import { VendorPortalAccessService } from './portal-access.service';
import { SqlPortalAccessStore } from './portal-access.store';
import { drizzleLoginPolicyStore } from './portal-login-policy.reconciler';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/** In-memory ZITADEL with the calls a grant makes. */
class FakeZitadel {
  calls: string[] = [];
  orgs = new Map<string, string>();
  users: ZitadelUser[] = [];
  grants = new Map<string, string[]>();
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
  setGrants(userId: string, _orgId: string, roles: readonly string[]) {
    this.calls.push('setGrants');
    this.grants.set(userId, [...roles]);
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
let scope: { tenantId: string; organizationId: string };
let scope2: { tenantId: string; organizationId: string };
let staffIdpOrgId: string;
let founder: string;
let procurement: string;
let service: VendorPortalAccessService;
const zitadel = new FakeZitadel();

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
  procurement = (await createStaffUser(appPool, { ...scope, idpOrgId: staffIdpOrgId })).userId;

  const store = new SqlPortalAccessStore(db, new SqlUsersStore(db), new AuditService(db));
  service = new VendorPortalAccessService(store, zitadel as unknown as ZitadelAdminClient, caller);
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

// ---------------------------------------------------------------------------------------------- helpers

type Status = 'draft' | 'pending_kyc' | 'approved' | 'blocked';

/**
 * A foreign vendor (no PAN, so no per-tenant PAN clash) in `s`'s tenant with one contact. No portal org yet. The
 * creator is the procurement user and an approved vendor names the founder as approver (maker-checker CHECK).
 */
async function newVendor(
  status: Status,
  s = scope,
): Promise<{ vendorId: string; contactId: string }> {
  const vendorId = randomUUID();
  const contactId = randomUUID();
  const creator =
    s === scope
      ? procurement
      : (await createStaffUser(appPool, { ...s, idpOrgId: await staffOrgOf(s.tenantId) })).userId;
  await withTx(db, s, systemActor('test'), async (tx) => {
    await tx.execute(
      sql`INSERT INTO app.parties (id, tenant_id, kind, code, name)
          VALUES (${vendorId}, ${s.tenantId}, 'vendor', ${`V-${vendorId.slice(0, 8)}`}, 'Himal Supplies')`,
    );
    await tx.execute(
      sql`INSERT INTO app.vendors (id, tenant_id, legal_name, kind, country, status, created_by, approved_by)
          VALUES (${vendorId}, ${s.tenantId}, 'Himal Supplies', 'foreign', 'US', ${status}, ${creator},
                  ${status === 'approved' ? founder : null})`,
    );
    await tx.execute(
      sql`INSERT INTO app.vendor_contacts (id, tenant_id, vendor_id, full_name, email_norm)
          VALUES (${contactId}, ${s.tenantId}, ${vendorId}, 'Bikash Thapa',
                  ${`bikash-${vendorId.slice(0, 8)}@supply.test`})`,
    );
  });
  return { vendorId, contactId };
}

async function staffOrgOf(tenantId: string): Promise<string> {
  const { rows } = await appPool.query<{ id: string }>(
    `SELECT id FROM app.idp_orgs WHERE tenant_id = $1 AND kind = 'staff'`,
    [tenantId],
  );
  return rows[0]!.id;
}

async function rows<T>(query: string, values: unknown[]): Promise<T[]> {
  return (await appPool.query(query, values)).rows as T[];
}

// ------------------------------------------------------------------------------------------------ tests

describe('VendorPortalAccessService.grant on a real database', () => {
  it('writes an idp_orgs row of kind vendor and an invited vendor_user that resolves as a vendor principal', async () => {
    const { vendorId, contactId } = await newVendor('approved');
    const result = await service.grant(vendorId, { contactId }, randomUUID());
    expect(result.status).toBe(201);
    expect(result.response).toMatchObject({
      vendorId,
      contactId,
      status: 'invited',
      inviteSent: true,
      capability: 'full',
    });

    const [org] = await rows<{
      id: string;
      kind: string;
      party_id: string;
      zitadel_org_id: string;
    }>(
      'SELECT id, kind, party_id, zitadel_org_id FROM app.idp_orgs WHERE tenant_id = $1 AND party_id = $2',
      [scope.tenantId, vendorId],
    );
    expect(org).toMatchObject({ id: result.response.idpOrgId, kind: 'vendor', party_id: vendorId });
    const roles = await rows<{ role_key: string }>(
      'SELECT role_key FROM app.user_roles WHERE tenant_id = $1 AND user_id = $2',
      [scope.tenantId, result.response.userId],
    );
    expect(roles.map((r) => r.role_key)).toEqual(['vendor_user']);
    const audit = await ownerPool.query<{ action: string }>(
      `SELECT action FROM audit.audit_events
        WHERE entity_type = 'vendor' AND entity_id = $1 AND action LIKE 'portal_access.%' ORDER BY id`,
      [vendorId],
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

    // A token from the new org resolves to the vendor party, so the caller is a vendor principal.
    const resolved = await new IdpOrgResolver(db, () => Date.now()).resolve(org!.zitadel_org_id);
    expect(resolved).toMatchObject({ kind: 'vendor', partyId: vendorId, tenantId: scope.tenantId });
  });

  it('grants a pending_kyc vendor with onboarding-only capability', async () => {
    const { vendorId, contactId } = await newVendor('pending_kyc');
    const result = await service.grant(vendorId, { contactId }, randomUUID());
    expect(result.response.capability).toBe('onboarding_only');
  });

  it.each<Status>(['draft', 'blocked'])(
    'answers 409 for a %s vendor and writes nothing',
    async (status) => {
      const { vendorId, contactId } = await newVendor(status);
      const error = await service
        .grant(vendorId, { contactId }, randomUUID())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'invalid_transition',
      });
      expect(
        await rows('SELECT id FROM app.idp_orgs WHERE party_id = $1', [vendorId]),
      ).toHaveLength(0);
      const audit = await ownerPool.query(
        `SELECT id FROM audit.audit_events WHERE entity_id = $1 AND action LIKE 'portal_access.%'`,
        [vendorId],
      );
      expect(audit.rowCount).toBe(0);
    },
  );

  it('replays the same key and reuses the org and user on a new key', async () => {
    const { vendorId, contactId } = await newVendor('approved');
    const key = randomUUID();
    const first = await service.grant(vendorId, { contactId }, key);
    const replay = await service.grant(vendorId, { contactId }, key);
    expect(replay.response).toEqual(first.response);
    const again = await service.grant(vendorId, { contactId }, randomUUID());
    expect(again.response).toMatchObject({
      userId: first.response.userId,
      idpOrgId: first.response.idpOrgId,
      inviteSent: false,
    });
    const orgs = await rows('SELECT id FROM app.idp_orgs WHERE party_id = $1', [vendorId]);
    expect(orgs).toHaveLength(1);
  });

  it('answers 404 for a vendor of another tenant', async () => {
    const { vendorId, contactId } = await newVendor('pending_kyc', scope2);
    await expect(service.grant(vendorId, { contactId }, randomUUID())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('the login policy reconciler reads vendor orgs as well as customer orgs', async () => {
    const { vendorId, contactId } = await newVendor('approved');
    await service.grant(vendorId, { contactId }, randomUUID());
    const orgs = await drizzleLoginPolicyStore(db).customerOrgs();
    expect(orgs).toContainEqual(
      expect.objectContaining({ tenantId: scope.tenantId, partyId: vendorId, kind: 'vendor' }),
    );
    expect(orgs.every((o) => o.kind === 'customer' || o.kind === 'vendor')).toBe(true);
  });
});
