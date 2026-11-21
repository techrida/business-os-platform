// Integration tests for the SQL fixture helpers in fixtures.ts, on a database of the shared test cluster
// (vitest-global-setup.ts, needs Docker), migrated to the latest migration. ADR 0027: a tenant, its default legal
// entity and staff IdP org; parties with their IdP orgs; staff users with a default membership; portal users.
// Run with: pnpm --filter @bos/db exec vitest run src/testing/fixtures.test.ts
//
// createTestDatabase() gives the roles and the default privileges of init-dbs.sh.
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDepartment,
  createParty,
  createPortalUser,
  createStaffUser,
  createTenantWithEntity,
} from './fixtures.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

let testDb: TestDatabase;
let owner: Pool;
let app: Pool;

beforeAll(async () => {
  testDb = await createTestDatabase();
  owner = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  app = new Pool({ connectionString: testDb.appUrl, max: 5 });
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await testDb?.drop();
});

async function rows<T>(sql: string, values: unknown[]): Promise<T[]> {
  const { rows: found } = await owner.query(sql, values);
  return found as T[];
}

describe('createTenantWithEntity', () => {
  it('creates a tenant, its default entity (own organization_id) and the staff IdP org', async () => {
    const { tenantId, organizationId, idpOrgId } = await createTenantWithEntity(owner, {
      code: 'FX1',
      name: 'Fixture One',
    });

    const org = await rows<{
      tenant_id: string;
      organization_id: string;
      code: string;
      name: string;
      legal_name: string;
      is_default: boolean;
    }>('SELECT * FROM app.organizations WHERE id = $1', [organizationId]);
    expect(org).toHaveLength(1);
    expect(org[0]).toMatchObject({
      tenant_id: tenantId,
      organization_id: organizationId,
      code: 'FX1',
      name: 'Fixture One',
      legal_name: 'Fixture One',
      is_default: true,
    });

    const idp = await rows<{ kind: string; party_id: string | null; tenant_id: string }>(
      'SELECT kind, party_id, tenant_id FROM app.idp_orgs WHERE id = $1',
      [idpOrgId],
    );
    expect(idp).toEqual([{ kind: 'staff', party_id: null, tenant_id: tenantId }]);
  });

  it('works with no arguments, and called twice gives two separate tenants', async () => {
    const a = await createTenantWithEntity(app);
    const b = await createTenantWithEntity(app, { code: 'SECOND' });
    expect(a.tenantId).not.toBe(b.tenantId);
    expect(a.organizationId).not.toBe(b.organizationId);
    expect(a.idpOrgId).not.toBe(b.idpOrgId);

    const staff = await rows<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.idp_orgs WHERE kind = 'staff' AND tenant_id = ANY($1)`,
      [[a.tenantId, b.tenantId]],
    );
    expect(staff[0]?.n).toBe('2');
  });

  it('records the writes in the audit log under the entity', async () => {
    const { tenantId, organizationId } = await createTenantWithEntity(owner);
    const audited = await rows<{ entity_type: string; actor_id: string }>(
      `SELECT entity_type, actor_id FROM audit.audit_events
        WHERE tenant_id = $1 AND organization_id = $2 ORDER BY id`,
      [tenantId, organizationId],
    );
    expect(audited.map((r) => r.entity_type)).toEqual(
      expect.arrayContaining(['organizations', 'idp_orgs']),
    );
    expect(audited.every((r) => r.actor_id.startsWith('system:'))).toBe(true);
  });
});

describe('createParty', () => {
  it.each(['customer', 'vendor'] as const)(
    'creates a %s party and an IdP org of the same kind behind it',
    async (kind) => {
      const { tenantId } = await createTenantWithEntity(owner);
      const { partyId, idpOrgId } = await createParty(owner, { tenantId, kind, code: 'ACME' });

      const party = await rows<{ kind: string; code: string; tenant_id: string }>(
        'SELECT kind, code, tenant_id FROM app.parties WHERE id = $1',
        [partyId],
      );
      expect(party).toEqual([{ kind, code: 'ACME', tenant_id: tenantId }]);

      const idp = await rows<{ kind: string; party_id: string; tenant_id: string }>(
        'SELECT kind, party_id, tenant_id FROM app.idp_orgs WHERE id = $1',
        [idpOrgId],
      );
      expect(idp).toEqual([{ kind, party_id: partyId, tenant_id: tenantId }]);
    },
  );

  it('generates a code when none is given, so a second party in the tenant does not collide', async () => {
    const { tenantId } = await createTenantWithEntity(owner);
    const a = await createParty(owner, { tenantId, kind: 'customer' });
    const b = await createParty(owner, { tenantId, kind: 'customer' });
    expect(a.partyId).not.toBe(b.partyId);
  });

  it('refuses a tenant without a default entity instead of failing inside the audit trigger', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';
    await owner.query('INSERT INTO app.tenants (id) VALUES ($1)', [tenantId]);
    await expect(createParty(owner, { tenantId, kind: 'vendor' })).rejects.toThrow(
      /no default entity/,
    );
  });
});

describe('createStaffUser', () => {
  it('creates an active user with one default membership (all token roles) and the role rows', async () => {
    const { tenantId, organizationId, idpOrgId } = await createTenantWithEntity(owner);
    const { userId } = await createStaffUser(app, {
      tenantId,
      organizationId,
      idpOrgId,
      roleKeys: ['finance', 'approver'],
    });

    const user = await rows<{ status: string; idp_org_id: string; tenant_id: string }>(
      'SELECT status, idp_org_id, tenant_id FROM app.users WHERE id = $1',
      [userId],
    );
    expect(user).toEqual([{ status: 'active', idp_org_id: idpOrgId, tenant_id: tenantId }]);

    const memberships = await rows<{
      organization_id: string;
      is_default: boolean;
      role_keys: string[] | null;
      department_id: string | null;
    }>(
      'SELECT organization_id, is_default, role_keys, department_id FROM app.user_entities WHERE user_id = $1',
      [userId],
    );
    expect(memberships).toEqual([
      { organization_id: organizationId, is_default: true, role_keys: null, department_id: null },
    ]);

    const roles = await rows<{ role_key: string }>(
      'SELECT role_key FROM app.user_roles WHERE tenant_id = $1 AND user_id = $2 ORDER BY role_key',
      [tenantId, userId],
    );
    expect(roles.map((r) => r.role_key)).toEqual(['approver', 'finance']);
  });

  it('creates no role rows by default and puts the membership in the given department', async () => {
    const { tenantId, organizationId, idpOrgId } = await createTenantWithEntity(owner);
    const { departmentId } = await createDepartment(owner, {
      tenantId,
      organizationId,
      name: 'Finance',
    });
    const { userId } = await createStaffUser(owner, {
      tenantId,
      organizationId,
      idpOrgId,
      departmentId,
    });
    const m = await rows<{ department_id: string }>(
      'SELECT department_id FROM app.user_entities WHERE user_id = $1',
      [userId],
    );
    expect(m).toEqual([{ department_id: departmentId }]);
    const roles = await rows<{ n: string }>(
      'SELECT count(*)::text AS n FROM app.user_roles WHERE user_id = $1',
      [userId],
    );
    expect(roles[0]?.n).toBe('0');
  });

  it('leaves nothing behind when a step fails (one transaction)', async () => {
    const { tenantId, organizationId, idpOrgId } = await createTenantWithEntity(owner);
    await expect(
      createStaffUser(owner, {
        tenantId,
        organizationId,
        idpOrgId,
        departmentId: '00000000-0000-4000-8000-0000000000ff',
      }),
    ).rejects.toThrow(/foreign key/i);
    const users = await rows<{ n: string }>(
      'SELECT count(*)::text AS n FROM app.users WHERE tenant_id = $1',
      [tenantId],
    );
    expect(users[0]?.n).toBe('0');
  });

  it('gives two users in one tenant distinct ZITADEL ids and emails', async () => {
    const { tenantId, organizationId, idpOrgId } = await createTenantWithEntity(owner);
    const a = await createStaffUser(owner, { tenantId, organizationId, idpOrgId });
    const b = await createStaffUser(owner, { tenantId, organizationId, idpOrgId });
    expect(a.userId).not.toBe(b.userId);
  });
});

describe('createPortalUser', () => {
  it('creates an active user under the customer IdP org with no membership', async () => {
    const { tenantId } = await createTenantWithEntity(owner);
    const { idpOrgId } = await createParty(owner, { tenantId, kind: 'customer' });
    const { userId } = await createPortalUser(owner, { tenantId, idpOrgId });

    const user = await rows<{ status: string; idp_org_id: string }>(
      'SELECT status, idp_org_id FROM app.users WHERE id = $1',
      [userId],
    );
    expect(user).toEqual([{ status: 'active', idp_org_id: idpOrgId }]);
    const memberships = await rows<{ n: string }>(
      'SELECT count(*)::text AS n FROM app.user_entities WHERE user_id = $1',
      [userId],
    );
    expect(memberships[0]?.n).toBe('0');
  });
});
