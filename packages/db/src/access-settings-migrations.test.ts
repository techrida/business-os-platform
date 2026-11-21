// Integration test for migrations 0084_access_revisions and 0085_assignment_rules (U20b):
// verifies tenancy rules, audit triggers, check constraints, unique constraints, and composite
// cross-tenant/cross-entity foreign keys on app.access_revisions, app.access_assignment_rules,
// and app.access_assignment_handovers.
// Needs Docker (a migrated database of its own on the run's shared postgres:16-alpine). Run with:
//   pnpm --filter @bos/db exec vitest run src/access-settings-migrations.test.ts
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertAudit } from './check-audit.js';
import { assertTenancy } from './check-tenancy.js';
import {
  createDepartment,
  createStaffUser,
  createTenantWithEntity,
  type TenantWithEntity,
} from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

let testDb: TestDatabase;
let owner: Pool;
let tenantA: TenantWithEntity;
let tenantB: TenantWithEntity;
let userA: string;
let userB: string;
let deptMarketingA: string;
let deptSalesA: string;
let deptSalesB: string;

async function writeAs<T>(
  org: TenantWithEntity,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'access-settings-migration-test', true),
              set_config('bos.correlation_id', $1, true),
              set_config('bos.organization_id', $2, true)`,
      [randomUUID(), org.organizationId],
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

beforeAll(async () => {
  testDb = await createTestDatabase();
  owner = new Pool({ connectionString: testDb.ownerUrl, max: 2 });

  tenantA = await createTenantWithEntity(owner);
  tenantB = await createTenantWithEntity(owner);
  userA = (await createStaffUser(owner, tenantA)).userId;
  userB = (await createStaffUser(owner, tenantB)).userId;
  deptMarketingA = (await createDepartment(owner, tenantA)).departmentId;
  deptSalesA = (await createDepartment(owner, tenantA)).departmentId;
  deptSalesB = (await createDepartment(owner, tenantB)).departmentId;
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await testDb?.drop();
});

describe('0084 and 0085 tenancy and audit compliance', () => {
  it('passes check-tenancy and check-audit across the whole migrated schema', async () => {
    await expect(assertTenancy(owner)).resolves.toBeUndefined();
    await expect(assertAudit(owner)).resolves.toBeUndefined();
  });
});

describe('0084 app.access_revisions', () => {
  it('stores one revision row per tenant, rejects negative revisions and cross-tenant updated_by_user_id, and audits writes', async () => {
    await writeAs(tenantA, (c) =>
      c.query(
        `INSERT INTO app.access_revisions (tenant_id, revision, updated_by_user_id)
         VALUES ($1, 1, $2)`,
        [tenantA.tenantId, userA],
      ),
    );

    await expect(
      writeAs(tenantA, (c) =>
        c.query('INSERT INTO app.access_revisions (tenant_id, revision) VALUES ($1, 2)', [
          tenantA.tenantId,
        ]),
      ),
    ).rejects.toThrow(/access_revisions_tenant_unique/);

    await expect(
      writeAs(tenantB, (c) =>
        c.query('INSERT INTO app.access_revisions (tenant_id, revision) VALUES ($1, -1)', [
          tenantB.tenantId,
        ]),
      ),
    ).rejects.toThrow(/access_revisions_revision_nonneg_check/);

    await expect(
      writeAs(tenantB, (c) =>
        c.query(
          'INSERT INTO app.access_revisions (tenant_id, revision, updated_by_user_id) VALUES ($1, 0, $2)',
          [tenantB.tenantId, userA],
        ),
      ),
    ).rejects.toThrow(/access_revisions_updated_by_user_fk/);

    const { rows } = await owner.query(
      "SELECT 1 FROM audit.audit_events WHERE entity_type LIKE '%access_revisions'",
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('0085 app.access_assignment_rules and app.access_assignment_handovers', () => {
  it('stores one rule row per entity and area, rejects invalid enum values, and audits writes', async () => {
    await writeAs(tenantA, (c) =>
      c.query(
        `INSERT INTO app.access_assignment_rules (tenant_id, organization_id, area, staff_rule, managers_rule)
         VALUES ($1, $2, 'leads', 'self_only', 'self_and_staff')`,
        [tenantA.tenantId, tenantA.organizationId],
      ),
    );

    await expect(
      writeAs(tenantA, (c) =>
        c.query(
          `INSERT INTO app.access_assignment_rules (tenant_id, organization_id, area)
           VALUES ($1, $2, 'leads')`,
          [tenantA.tenantId, tenantA.organizationId],
        ),
      ),
    ).rejects.toThrow(/access_assignment_rules_tenant_org_area_unique/);

    await expect(
      writeAs(tenantA, (c) =>
        c.query(
          `INSERT INTO app.access_assignment_rules (tenant_id, organization_id, area)
           VALUES ($1, $2, 'quotations')`,
          [tenantA.tenantId, tenantA.organizationId],
        ),
      ),
    ).rejects.toThrow(/access_assignment_rules_area_check/);

    await expect(
      writeAs(tenantA, (c) =>
        c.query(
          `INSERT INTO app.access_assignment_rules (tenant_id, organization_id, area, staff_rule)
           VALUES ($1, $2, 'opportunities', 'upward')`,
          [tenantA.tenantId, tenantA.organizationId],
        ),
      ),
    ).rejects.toThrow(/access_assignment_rules_staff_rule_check/);

    await expect(
      writeAs(tenantA, (c) =>
        c.query(
          `INSERT INTO app.access_assignment_rules (tenant_id, organization_id, area, managers_rule)
           VALUES ($1, $2, 'opportunities', 'anyone')`,
          [tenantA.tenantId, tenantA.organizationId],
        ),
      ),
    ).rejects.toThrow(/access_assignment_rules_managers_rule_check/);

    const { rows } = await owner.query(
      "SELECT 1 FROM audit.audit_events WHERE entity_type LIKE '%access_assignment_rules'",
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('stores directed department hand-over pairs and blocks self-pairs, duplicates, and cross-tenant departments', async () => {
    await writeAs(tenantA, (c) =>
      c.query(
        `INSERT INTO app.access_assignment_handovers (tenant_id, organization_id, area, from_department_id, to_department_id)
         VALUES ($1, $2, 'leads', $3, $4)`,
        [tenantA.tenantId, tenantA.organizationId, deptMarketingA, deptSalesA],
      ),
    );

    await expect(
      writeAs(tenantA, (c) =>
        c.query(
          `INSERT INTO app.access_assignment_handovers (tenant_id, organization_id, area, from_department_id, to_department_id)
           VALUES ($1, $2, 'leads', $3, $4)`,
          [tenantA.tenantId, tenantA.organizationId, deptMarketingA, deptSalesA],
        ),
      ),
    ).rejects.toThrow(/access_assignment_handovers_tenant_org_area_pair_unique/);

    await expect(
      writeAs(tenantA, (c) =>
        c.query(
          `INSERT INTO app.access_assignment_handovers (tenant_id, organization_id, area, from_department_id, to_department_id)
           VALUES ($1, $2, 'leads', $3, $3)`,
          [tenantA.tenantId, tenantA.organizationId, deptSalesA],
        ),
      ),
    ).rejects.toThrow(/access_assignment_handovers_distinct_departments_check/);

    await expect(
      writeAs(tenantA, (c) =>
        c.query(
          `INSERT INTO app.access_assignment_handovers (tenant_id, organization_id, area, from_department_id, to_department_id)
           VALUES ($1, $2, 'leads', $3, $4)`,
          [tenantA.tenantId, tenantA.organizationId, deptMarketingA, deptSalesB],
        ),
      ),
    ).rejects.toThrow(/access_assignment_handovers_to_department_fk/);

    expect(userB).toBeTruthy();

    const { rows } = await owner.query(
      "SELECT 1 FROM audit.audit_events WHERE entity_type LIKE '%access_assignment_handovers'",
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
