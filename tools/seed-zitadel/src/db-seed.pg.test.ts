// The kernel seed against a database of the shared test cluster (vitest-global-setup.ts, needs Docker), migrated
// to the latest migration. The fake-client tests in db-seed.test.ts pin the SQL; these prove what the fakes cannot: the 0079
// department-head triggers agree with what the seed files, a re-run writes nothing (not even an audit row), and a
// reseed leaves the Founder's own grants and level rows alone.
// Run with: pnpm --filter ./tools/seed-zitadel exec vitest run src/db-seed.pg.test.ts
import { randomUUID } from 'node:crypto';

import { DEFAULT_ROLE_PERMISSIONS } from '@bos/contracts';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createParty, createTenantWithEntity } from '../../../packages/db/src/testing/fixtures.js';
import {
  DEV_CUSTOMER_NAME_NORM,
  DEV_CUSTOMER_PARTY_CODE,
  DEV_VENDOR_PARTY_CODE,
  type DevPersona,
  type SeedScope,
  seedKernelRows,
} from './db-seed.js';

/** A copy of the migrated template database. */
const SETUP_TIMEOUT = 180_000;
const TEST_TIMEOUT = 60_000;

let testDb: TestDatabase;
let owner: Pool;

beforeAll(async () => {
  testDb = await createTestDatabase();
  // The seed runs as the table owner, like the real tool.
  owner = new Pool({ connectionString: testDb.ownerUrl, max: 3 });
}, SETUP_TIMEOUT);

afterAll(async () => {
  await owner?.end();
  await testDb?.drop();
}, 60_000);

/** A tenant with its TR-like entity, staff IdP org and the VEND-DEV and CUST-DEV parties the tenancy step creates. */
async function devTenant(): Promise<SeedScope & { idpOrgId: string }> {
  const tenant = await createTenantWithEntity(owner);
  await createParty(owner, {
    tenantId: tenant.tenantId,
    kind: 'vendor',
    code: DEV_VENDOR_PARTY_CODE,
  });
  await createParty(owner, {
    tenantId: tenant.tenantId,
    kind: 'customer',
    code: DEV_CUSTOMER_PARTY_CODE,
  });
  return { ...tenant, correlationId: `pg-test-${randomUUID()}` };
}

/** seedKernelRows runs its own BEGIN/COMMIT, so it gets one dedicated connection. */
async function seed(scope: SeedScope, personas?: readonly DevPersona[]): Promise<number> {
  const client = await owner.connect();
  try {
    return await seedKernelRows(client, scope, personas);
  } finally {
    client.release();
  }
}

/** A write outside the seed, as some other actor (the audit triggers refuse a write without one). */
async function asFounder<T>(scope: SeedScope, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.tenant_id', $1, true), set_config('bos.organization_id', $2, true),
              set_config('bos.actor_kind', 'system', true), set_config('bos.actor_id', 'system:pg-test', true),
              set_config('bos.correlation_id', $3, true), set_config('bos.ip', '', true),
              set_config('bos.user_agent', '', true)`,
      [scope.tenantId, scope.organizationId, `pg-test:${randomUUID()}`],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const DEPARTMENT_PEOPLE = [
  'procurement',
  'management',
  'depthead',
  'warehouse',
  'sales',
  'sales2',
  'salesmgr',
  'saleshead',
  'marketing',
  'marketingmgr',
  'marketinghead',
];

/** The personas the dev step needs. users.zitadel_user_id is unique across tenants, so each test has a prefix. */
const personasFor = (prefix: string): DevPersona[] =>
  DEPARTMENT_PEOPLE.map((key) => ({
    personaKey: key,
    zitadelUserId: `${prefix}-${key}`,
    email: `${key}@${prefix}.test`,
    displayName: `Dev ${key}`,
  }));

async function auditCount(tenantId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    'SELECT count(*) AS n FROM audit.audit_events WHERE tenant_id = $1',
    [tenantId],
  );
  return Number(rows[0]?.n);
}

describe('dev people step on Postgres', () => {
  it(
    'files every person at their level under the right head, keeps an existing dev database, and a re-run changes nothing',
    async () => {
      const scope = await devTenant();
      const prefix = `pg-people-${randomUUID().slice(0, 8)}`;
      const personas = personasFor(prefix);
      const zid = (key: string) => `${prefix}-${key}`;

      // A dev database from before phase 2: depthead heads Operations but is not filed in it, procurement is
      // Operations staff, and the user mirror already made `sales` (role_keys NULL keeps every token role).
      const before = await asFounder(scope, async (client) => {
        const ids: Record<string, string> = {};
        for (const key of ['depthead', 'procurement', 'sales']) {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO app.users (tenant_id, idp_org_id, zitadel_user_id, email, display_name, status)
             VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id`,
            [scope.tenantId, scope.idpOrgId, zid(key), `${key}@${prefix}.test`, `Dev ${key}`],
          );
          ids[key] = rows[0]?.id ?? '';
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO app.departments (tenant_id, organization_id, name, head_user_id)
           VALUES ($1, $2, 'Operations', $3) RETURNING id`,
          [scope.tenantId, scope.organizationId, ids['depthead']],
        );
        const operationsId = rows[0]?.id ?? '';
        await client.query(
          `INSERT INTO app.user_entities (tenant_id, organization_id, user_id, is_default, department_id)
           VALUES ($1, $2, $3, true, NULL), ($1, $2, $4, true, $5), ($1, $2, $6, true, NULL)`,
          [
            scope.tenantId,
            scope.organizationId,
            ids['depthead'],
            ids['procurement'],
            operationsId,
            ids['sales'],
          ],
        );
        return { operationsId };
      });

      expect(await seed(scope, personas)).toBeGreaterThan(0);

      const departments = await owner.query<{ id: string; name: string; head: string | null }>(
        `SELECT d.id, d.name, u.zitadel_user_id AS head
         FROM app.departments d LEFT JOIN app.users u ON u.id = d.head_user_id
         WHERE d.tenant_id = $1 ORDER BY d.name`,
        [scope.tenantId],
      );
      expect(departments.rows.map((d) => [d.name, d.head])).toEqual([
        ['Marketing', zid('marketinghead')],
        ['Operations', zid('depthead')],
        ['Sales', zid('saleshead')],
      ]);
      // The pre-phase-2 Operations row is reused, not duplicated.
      expect(departments.rows.find((d) => d.name === 'Operations')?.id).toBe(before.operationsId);

      const members = await owner.query<{
        zitadel_user_id: string;
        department: string | null;
        level: string;
        role_keys: string[] | null;
      }>(
        `SELECT u.zitadel_user_id, d.name AS department, ue.level, ue.role_keys
         FROM app.user_entities ue
         JOIN app.users u ON u.id = ue.user_id
         LEFT JOIN app.departments d ON d.id = ue.department_id
         WHERE ue.tenant_id = $1`,
        [scope.tenantId],
      );
      const filed = Object.fromEntries(
        members.rows.map((m) => [
          m.zitadel_user_id.slice(prefix.length + 1),
          [m.department, m.level],
        ]),
      );
      expect(filed).toEqual({
        procurement: ['Operations', 'staff'],
        depthead: ['Operations', 'head'],
        management: [null, 'staff'],
        warehouse: [null, 'staff'],
        sales: ['Sales', 'staff'],
        sales2: ['Sales', 'staff'],
        salesmgr: ['Sales', 'manager'],
        saleshead: ['Sales', 'head'],
        marketing: ['Marketing', 'staff'],
        marketingmgr: ['Marketing', 'manager'],
        marketinghead: ['Marketing', 'head'],
      });
      // The mirror-made membership keeps its role_keys; the seed only files it.
      expect(members.rows.find((m) => m.zitadel_user_id === zid('sales'))?.role_keys).toBeNull();
      expect(members.rows.find((m) => m.zitadel_user_id === zid('salesmgr'))?.role_keys).toEqual([
        'sales',
      ]);
      // Exactly one head per department: the triggers and the seed agree.
      const heads = await owner.query<{ name: string; n: string }>(
        `SELECT d.name, count(*) AS n FROM app.user_entities ue JOIN app.departments d ON d.id = ue.department_id
         WHERE ue.tenant_id = $1 AND ue.level = 'head' GROUP BY d.name ORDER BY d.name`,
        [scope.tenantId],
      );
      expect(heads.rows.map((r) => [r.name, Number(r.n)])).toEqual([
        ['Marketing', 1],
        ['Operations', 1],
        ['Sales', 1],
      ]);

      // CUST-DEV customer, primary contact, and TR party account are seeded with the party's id and name.
      const customers = await owner.query<{
        id: string;
        number: string;
        legal_name: string;
        name_norm: string;
        relationship: string;
        default_currency: string;
        owner_zid: string | null;
      }>(
        `SELECT c.id, c.number, c.legal_name, c.name_norm, c.relationship, c.default_currency,
                u.zitadel_user_id AS owner_zid
         FROM app.customers c
         LEFT JOIN app.users u ON u.id = c.owner_user_id
         WHERE c.tenant_id = $1`,
        [scope.tenantId],
      );
      expect(customers.rows).toHaveLength(1);
      expect(customers.rows[0]).toMatchObject({
        number: DEV_CUSTOMER_PARTY_CODE,
        name_norm: DEV_CUSTOMER_NAME_NORM,
        relationship: 'active',
        default_currency: 'NPR',
        owner_zid: zid('sales'),
      });
      const contacts = await owner.query<{
        full_name: string;
        email_norm: string | null;
        is_primary: boolean;
      }>(
        `SELECT full_name, email_norm, is_primary FROM app.customer_contacts WHERE tenant_id = $1`,
        [scope.tenantId],
      );
      expect(contacts.rows).toEqual([
        { full_name: 'Dev Customer', email_norm: 'customer@dev.bos.test', is_primary: true },
      ]);
      const partyAccounts = await owner.query<{
        party_id: string;
        default_currency: string | null;
        term_code: string | null;
      }>(
        `SELECT pa.party_id, pa.default_currency, pt.code AS term_code
         FROM app.party_accounts pa
         LEFT JOIN app.payment_terms pt ON pt.id = pa.payment_term_id
         WHERE pa.tenant_id = $1 AND pa.organization_id = $2`,
        [scope.tenantId, scope.organizationId],
      );
      expect(partyAccounts.rows).toEqual([
        { party_id: customers.rows[0]?.id, default_currency: 'NPR', term_code: 'NET30' },
      ]);

      // A re-run changes 0 rows, and no trigger writes behind the counts either.
      const audited = await auditCount(scope.tenantId);
      expect(await seed(scope, personas)).toBe(0);
      expect(await auditCount(scope.tenantId)).toBe(audited);
    },
    TEST_TIMEOUT,
  );
});

describe('reseed keeps Founder grants', () => {
  it(
    'leaves seeded = false grants and level rows alone, deletes only a seeded stale grant, and writes no level rows',
    async () => {
      const scope = await devTenant();
      await seed(scope);

      // Preconditions on the defaults the test leans on.
      expect(DEFAULT_ROLE_PERMISSIONS.sales['crm.lead.read']).toBe('own');
      const warehouse = new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS.warehouse));
      expect(warehouse.has('crm.lead.read')).toBe(false);
      expect(warehouse.has('crm.lead.write')).toBe(false);

      await asFounder(scope, async (client) => {
        // The Founder widened a default grant (Settings > Access saves it as their own row).
        await client.query(
          `UPDATE app.role_permissions SET scope = 'all', seeded = false
           WHERE tenant_id = $1 AND role_key = 'sales' AND permission = 'crm.lead.read'`,
          [scope.tenantId],
        );
        // The Founder added a grant the defaults do not have.
        await client.query(
          `INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
           VALUES ($1, 'warehouse', 'crm.lead.read', 'own', false)`,
          [scope.tenantId],
        );
        // A seeded grant the defaults no longer list (an earlier seed wrote it).
        await client.query(
          `INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
           VALUES ($1, 'warehouse', 'crm.lead.write', 'own', true)`,
          [scope.tenantId],
        );
        // The Founder's own level rule.
        await client.query(
          `INSERT INTO app.role_permission_levels (tenant_id, role_key, permission, min_level, scope, seeded)
           VALUES ($1, 'sales', 'crm.lead.read', 'manager', 'department', false)`,
          [scope.tenantId],
        );
      });

      // The stale seeded row goes (plus the authz bump); nothing else changes.
      expect(await seed(scope)).toBeGreaterThan(0);

      const grants = await owner.query<{
        role_key: string;
        permission: string;
        scope: string;
        seeded: boolean;
      }>(
        'SELECT role_key, permission, scope, seeded FROM app.role_permissions WHERE tenant_id = $1',
        [scope.tenantId],
      );
      const founderRows = grants.rows
        .filter((g) => !g.seeded)
        .map((g) => `${g.role_key}|${g.permission}|${g.scope}`)
        .sort();
      expect(founderRows).toEqual(['sales|crm.lead.read|all', 'warehouse|crm.lead.read|own']);
      expect(
        grants.rows.some((g) => g.role_key === 'warehouse' && g.permission === 'crm.lead.write'),
      ).toBe(false);

      // The seeded rows are exactly the current defaults, less the one the Founder now owns.
      const expected: string[] = [];
      for (const [role, defaults] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
        for (const [permission, grantScope] of Object.entries(defaults)) {
          if (role === 'sales' && permission === 'crm.lead.read') continue;
          expected.push(`${role}|${permission}|${grantScope}`);
        }
      }
      expect(
        grants.rows
          .filter((g) => g.seeded)
          .map((g) => `${g.role_key}|${g.permission}|${g.scope}`)
          .sort(),
      ).toEqual(expected.sort());

      // The seed never writes level rows: only the Founder's is there.
      const levels = await owner.query<{
        role_key: string;
        min_level: string;
        scope: string;
        seeded: boolean;
      }>(
        'SELECT role_key, min_level, scope, seeded FROM app.role_permission_levels WHERE tenant_id = $1',
        [scope.tenantId],
      );
      expect(levels.rows).toEqual([
        { role_key: 'sales', min_level: 'manager', scope: 'department', seeded: false },
      ]);

      // And the run after that is a no-op.
      expect(await seed(scope)).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
