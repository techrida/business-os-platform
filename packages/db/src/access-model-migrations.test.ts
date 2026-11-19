// Integration test for migrations 0079 to 0083 (the default access model, D50 and D51): levels on department
// memberships with the head kept in step, the department stamped on leads and opportunities, the `seeded`
// marker, the `assigned` scope and level grants, and the Marketing role rows.
// Needs Docker: a real postgres:16-alpine from Testcontainers (its own database, so no compose stack is
// involved). Run with:
//   pnpm --filter @bos/db exec vitest run src/access-model-migrations.test.ts
//
// The database is migrated with the real SQL up to 0078's slot (everything before 0079), seeded like a tenant
// that has been running, then migrated with the real runner, which applies 0079 to 0083 and anything later.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import {
  createDepartment,
  createParty,
  createStaffUser,
  createTenantWithEntity,
  type TenantWithEntity,
} from './testing/fixtures.js';

const OWNER_PW = 'owner-test-pw';
const FIRST_TAG = '0079_access_levels';

/** The grants migration 0083 inserts: `DEFAULT_ROLE_PERMISSIONS.marketing` in packages/contracts, by value. */
const MARKETING_GRANTS: Record<string, string> = {
  'memo.create': 'own',
  'memo.update': 'own',
  'memo.read': 'own',
  'documents.upload': 'own',
  'documents.read': 'own',
  'approvals.requests.read': 'own',
  'crm.lead.read': 'own',
  'crm.lead.write': 'own',
};

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

let container: StartedPostgreSqlContainer;
let admin: Pool;
let owner: Pool;
let beforeFolder: string;
let sqlOfMarketing: string[];

let tenantA: TenantWithEntity;
let tenantB: TenantWithEntity;

let salesDept: string;
let headUser: string;
let memberUser: string;
let unplacedUser: string;
let leadOfMember: string;
let leadOfUnplaced: string;
let leadWithoutOwner: string;
let oppOfMember: string;
let customerId: string;

/** One transaction as bos_owner with the audit settings the triggers demand. */
async function writeAs<T>(
  org: TenantWithEntity,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'access-model-migration-test', true),
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

async function insertLead(
  org: TenantWithEntity,
  number: string,
  ownerUserId: string | null,
): Promise<string> {
  return writeAs(org, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.leads (tenant_id, organization_id, number, title, source, owner_user_id, company_name, contact_name)
       VALUES ($1, $2, $3, 'Lead', 'website', $4, 'Acme', 'Asha') RETURNING id`,
      [org.tenantId, org.organizationId, number, ownerUserId],
    );
    return rows[0]!.id;
  });
}

async function insertOpportunity(
  org: TenantWithEntity,
  number: string,
  ownerUserId: string | null,
): Promise<string> {
  return writeAs(org, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.opportunities (tenant_id, organization_id, number, name, customer_id, owner_user_id)
       VALUES ($1, $2, $3, 'Deal', $4, $5) RETURNING id`,
      [org.tenantId, org.organizationId, number, customerId, ownerUserId],
    );
    return rows[0]!.id;
  });
}

const one = async <T>(sql: string, values: unknown[]): Promise<T> => {
  const { rows } = await owner.query(sql, values);
  return rows[0] as T;
};

const leadDepartment = async (id: string): Promise<string | null> =>
  (
    await one<{ department_id: string | null }>(
      'SELECT department_id FROM app.leads WHERE id = $1',
      [id],
    )
  ).department_id;

const oppDepartment = async (id: string): Promise<string | null> =>
  (
    await one<{ department_id: string | null }>(
      'SELECT department_id FROM app.opportunities WHERE id = $1',
      [id],
    )
  ).department_id;

const levelOf = async (userId: string): Promise<string> =>
  (await one<{ level: string }>('SELECT level FROM app.user_entities WHERE user_id = $1', [userId]))
    .level;

const headOf = async (departmentId: string): Promise<string | null> =>
  (
    await one<{ head_user_id: string | null }>(
      'SELECT head_user_id FROM app.departments WHERE id = $1',
      [departmentId],
    )
  ).head_user_id;

async function setLevel(userId: string, level: string): Promise<void> {
  await writeAs(tenantA, (c) =>
    c.query('UPDATE app.user_entities SET level = $2 WHERE user_id = $1', [userId, level]),
  );
}

async function setHead(departmentId: string, userId: string | null): Promise<void> {
  await writeAs(tenantA, (c) =>
    c.query('UPDATE app.departments SET head_user_id = $2 WHERE id = $1', [departmentId, userId]),
  );
}

async function newDepartment(): Promise<{ departmentId: string; a: string; b: string }> {
  const { departmentId } = await createDepartment(owner, tenantA);
  const a = (await createStaffUser(owner, { ...tenantA, departmentId })).userId;
  const b = (await createStaffUser(owner, { ...tenantA, departmentId })).userId;
  return { departmentId, a, b };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query('CREATE ROLE bos_app');
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  const url = new URL(container.getConnectionUri());
  url.username = 'bos_owner';
  url.password = OWNER_PW;
  url.pathname = '/bos';
  const ownerUrl = url.toString();
  owner = new Pool({ connectionString: ownerUrl, max: 2 });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const index = journal.entries.findIndex((entry) => entry.tag === FIRST_TAG);
  expect(index, `${FIRST_TAG} is in the journal`).toBeGreaterThan(0);
  beforeFolder = await mkdtemp(join(tmpdir(), 'bos-before-0079-'));
  await mkdir(join(beforeFolder, 'meta'));
  const entries = journal.entries.slice(0, index);
  await writeFile(
    join(beforeFolder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    await copyFile(
      join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      join(beforeFolder, `${entry.tag}.sql`),
    );
  }
  sqlOfMarketing = (
    await readFile(join(MIGRATIONS_FOLDER, '0083_marketing_role.sql'), 'utf8')
  ).split('--> statement-breakpoint');
  await runMigrations(ownerUrl, beforeFolder);

  // A tenant that has been running: a department with a named head, a member, a person without a department,
  // leads and an opportunity owned by each, and role grants written by the old seed.
  tenantA = await createTenantWithEntity(owner);
  salesDept = (await createDepartment(owner, tenantA)).departmentId;
  headUser = (await createStaffUser(owner, { ...tenantA, departmentId: salesDept })).userId;
  memberUser = (await createStaffUser(owner, { ...tenantA, departmentId: salesDept })).userId;
  unplacedUser = (await createStaffUser(owner, tenantA)).userId;
  await writeAs(tenantA, (c) =>
    c.query('UPDATE app.departments SET head_user_id = $2 WHERE id = $1', [salesDept, headUser]),
  );
  customerId = (await createParty(owner, { tenantId: tenantA.tenantId, kind: 'customer' })).partyId;
  await writeAs(tenantA, (c) =>
    c.query(
      `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
       VALUES ($1, $2, 'CUS-1', 'Acme Pvt. Ltd.', 'acme', $3::jsonb)`,
      [
        customerId,
        tenantA.tenantId,
        JSON.stringify({ line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' }),
      ],
    ),
  );
  leadOfMember = await insertLead(tenantA, 'LD-1', memberUser);
  leadOfUnplaced = await insertLead(tenantA, 'LD-2', unplacedUser);
  leadWithoutOwner = await insertLead(tenantA, 'LD-3', null);
  oppOfMember = await insertOpportunity(tenantA, 'DEAL-1', memberUser);
  await writeAs(tenantA, async (c) => {
    await c.query(
      `INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope)
       VALUES ($1, 'sales', 'quotation.read', 'own'), ($1, 'sales', 'crm.lead.read', 'own')`,
      [tenantA.tenantId],
    );
    await c.query('INSERT INTO app.authz_versions (tenant_id, version) VALUES ($1, 3)', [
      tenantA.tenantId,
    ]);
  });
  tenantB = await createTenantWithEntity(owner);

  // The real runner now applies 0079 to 0083.
  await runMigrations(ownerUrl);
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await admin?.end();
  await container?.stop();
  if (beforeFolder) await rm(beforeFolder, { recursive: true, force: true });
});

describe('0079 levels', () => {
  it('makes the named head level head and everyone else staff', async () => {
    expect(await levelOf(headUser)).toBe('head');
    expect(await levelOf(memberUser)).toBe('staff');
    expect(await levelOf(unplacedUser)).toBe('staff');
  });

  it('refuses a level outside staff, manager and head, and a head without a department', async () => {
    await expect(setLevel(memberUser, 'director')).rejects.toThrow(/user_entities_level_check/);
    await expect(setLevel(unplacedUser, 'head')).rejects.toThrow(
      /user_entities_head_department_check/,
    );
  });
});

describe('0079 head and level stay in step', () => {
  it('naming a head on the department promotes that member and clears nothing else', async () => {
    const { departmentId, a, b } = await newDepartment();
    await setHead(departmentId, a);
    expect(await levelOf(a)).toBe('head');
    expect(await levelOf(b)).toBe('staff');
    expect(await headOf(departmentId)).toBe(a);
  });

  it('naming another head demotes the previous head to manager', async () => {
    const { departmentId, a, b } = await newDepartment();
    await setHead(departmentId, a);
    await setHead(departmentId, b);
    expect(await levelOf(a)).toBe('manager');
    expect(await levelOf(b)).toBe('head');
    expect(await headOf(departmentId)).toBe(b);
  });

  it('promoting a member to head names them and demotes the previous head', async () => {
    const { departmentId, a, b } = await newDepartment();
    await setLevel(a, 'head');
    expect(await headOf(departmentId)).toBe(a);
    await setLevel(b, 'head');
    expect(await headOf(departmentId)).toBe(b);
    expect(await levelOf(a)).toBe('manager');
    const heads = await owner.query(
      "SELECT 1 FROM app.user_entities WHERE department_id = $1 AND level = 'head'",
      [departmentId],
    );
    expect(heads.rowCount).toBe(1);
  });

  it('demoting the head clears the department head', async () => {
    const { departmentId, a } = await newDepartment();
    await setHead(departmentId, a);
    await setLevel(a, 'manager');
    expect(await headOf(departmentId)).toBeNull();
    expect(await levelOf(a)).toBe('manager');
  });

  it('clearing the department head demotes the old head to manager', async () => {
    const { departmentId, a } = await newDepartment();
    await setHead(departmentId, a);
    await setHead(departmentId, null);
    expect(await levelOf(a)).toBe('manager');
    expect(await headOf(departmentId)).toBeNull();
  });

  it('moving the head to another department clears the old department head, whatever the level', async () => {
    const first = await newDepartment();
    const second = await newDepartment();
    await setHead(first.departmentId, first.a);
    await writeAs(tenantA, (c) =>
      c.query(
        "UPDATE app.user_entities SET department_id = $2, level = 'staff' WHERE user_id = $1",
        [first.a, second.departmentId],
      ),
    );
    expect(await headOf(first.departmentId)).toBeNull();
    expect(await headOf(second.departmentId)).toBeNull();

    // Moved without a level change, a head stays head and so leads the department they join.
    const third = await newDepartment();
    await setHead(third.departmentId, third.a);
    await writeAs(tenantA, (c) =>
      c.query('UPDATE app.user_entities SET department_id = $2 WHERE user_id = $1', [
        third.a,
        second.departmentId,
      ]),
    );
    expect(await headOf(third.departmentId)).toBeNull();
    expect(await headOf(second.departmentId)).toBe(third.a);
    expect(await levelOf(third.a)).toBe('head');
  });

  it('deleting the head membership clears the department head', async () => {
    const { departmentId, a } = await newDepartment();
    await setHead(departmentId, a);
    await writeAs(tenantA, (c) => c.query('DELETE FROM app.user_entities WHERE user_id = $1', [a]));
    expect(await headOf(departmentId)).toBeNull();
  });

  it('makes a member head when the department already names them', async () => {
    // The department is written first (as an admin screen may), the membership arrives later.
    const departmentId = (await createDepartment(owner, tenantA)).departmentId;
    const lateUser = (await createStaffUser(owner, tenantA)).userId;
    await setHead(departmentId, lateUser);
    expect(await levelOf(lateUser)).toBe('staff');
    await writeAs(tenantA, (c) =>
      c.query('UPDATE app.user_entities SET department_id = $2 WHERE user_id = $1', [
        lateUser,
        departmentId,
      ]),
    );
    expect(await levelOf(lateUser)).toBe('head');
    expect(await headOf(departmentId)).toBe(lateUser);
  });

  it('keeps one head when two members are promoted at the same time', async () => {
    const { departmentId, a, b } = await newDepartment();
    await Promise.all([setLevel(a, 'head'), setLevel(b, 'head')]);
    const heads = await owner.query<{ user_id: string }>(
      "SELECT user_id FROM app.user_entities WHERE department_id = $1 AND level = 'head'",
      [departmentId],
    );
    expect(heads.rowCount).toBe(1);
    expect(await headOf(departmentId)).toBe(heads.rows[0]!.user_id);
  });

  it('leaves a head with no membership in that department alone', async () => {
    const { departmentId } = await newDepartment();
    await setHead(departmentId, unplacedUser);
    expect(await headOf(departmentId)).toBe(unplacedUser);
    expect(await levelOf(unplacedUser)).toBe('staff');
    await setHead(departmentId, null);
  });
});

describe('0080 department stamp', () => {
  it('backfills existing rows from their owner and leaves the rest empty', async () => {
    expect(await leadDepartment(leadOfMember)).toBe(salesDept);
    expect(await leadDepartment(leadOfUnplaced)).toBeNull();
    expect(await leadDepartment(leadWithoutOwner)).toBeNull();
    expect(await oppDepartment(oppOfMember)).toBe(salesDept);
    const created = await one<{ created_by_user_id: string | null }>(
      'SELECT created_by_user_id FROM app.leads WHERE id = $1',
      [leadOfMember],
    );
    expect(created.created_by_user_id).toBeNull();
  });

  it('stamps a new lead and opportunity from the owner, ignoring a department written by hand', async () => {
    const other = await newDepartment();
    const lead = await writeAs(tenantA, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO app.leads (tenant_id, organization_id, number, title, source, owner_user_id, department_id, company_name, contact_name)
         VALUES ($1, $2, 'LD-10', 'Lead', 'website', $3, $4, 'Acme', 'Asha') RETURNING id`,
        [tenantA.tenantId, tenantA.organizationId, memberUser, other.departmentId],
      );
      return rows[0]!.id;
    });
    expect(await leadDepartment(lead)).toBe(salesDept);
    const opp = await writeAs(tenantA, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO app.opportunities (tenant_id, organization_id, number, name, customer_id, owner_user_id, department_id)
         VALUES ($1, $2, 'DEAL-10', 'Deal', $3, $4, $5) RETURNING id`,
        [tenantA.tenantId, tenantA.organizationId, customerId, memberUser, other.departmentId],
      );
      return rows[0]!.id;
    });
    expect(await oppDepartment(opp)).toBe(salesDept);
  });

  it('re-stamps when the owner changes and empties when the owner is removed or has no department', async () => {
    const other = await newDepartment();
    const lead = await insertLead(tenantA, 'LD-11', memberUser);
    const opp = await insertOpportunity(tenantA, 'DEAL-11', memberUser);
    for (const [table, id] of [
      ['leads', lead],
      ['opportunities', opp],
    ] as const) {
      await writeAs(tenantA, (c) =>
        c.query(`UPDATE app.${table} SET owner_user_id = $2 WHERE id = $1`, [id, other.a]),
      );
      const stamped = await one<{ department_id: string | null }>(
        `SELECT department_id FROM app.${table} WHERE id = $1`,
        [id],
      );
      expect(stamped.department_id, table).toBe(other.departmentId);
      await writeAs(tenantA, (c) =>
        c.query(`UPDATE app.${table} SET owner_user_id = $2 WHERE id = $1`, [id, unplacedUser]),
      );
      expect(
        (
          await one<{ department_id: string | null }>(
            `SELECT department_id FROM app.${table} WHERE id = $1`,
            [id],
          )
        ).department_id,
        table,
      ).toBeNull();
      await writeAs(tenantA, (c) =>
        c.query(`UPDATE app.${table} SET owner_user_id = $2 WHERE id = $1`, [id, memberUser]),
      );
      await writeAs(tenantA, (c) =>
        c.query(`UPDATE app.${table} SET owner_user_id = NULL WHERE id = $1`, [id]),
      );
      expect(
        (
          await one<{ department_id: string | null }>(
            `SELECT department_id FROM app.${table} WHERE id = $1`,
            [id],
          )
        ).department_id,
        table,
      ).toBeNull();
    }
  });

  it('keeps the stamp when something other than the owner changes', async () => {
    const lead = await insertLead(tenantA, 'LD-12', memberUser);
    await writeAs(tenantA, (c) =>
      c.query("UPDATE app.leads SET title = 'Renamed' WHERE id = $1", [lead]),
    );
    expect(await leadDepartment(lead)).toBe(salesDept);
  });

  it('replaces a department written by hand on an update that leaves the owner alone', async () => {
    const other = await newDepartment();
    const lead = await insertLead(tenantA, 'LD-13', memberUser);
    const opp = await insertOpportunity(tenantA, 'DEAL-13', memberUser);
    await writeAs(tenantA, async (c) => {
      await c.query('UPDATE app.leads SET department_id = $2 WHERE id = $1', [
        lead,
        other.departmentId,
      ]);
      await c.query('UPDATE app.opportunities SET department_id = NULL WHERE id = $1', [opp]);
    });
    expect(await leadDepartment(lead)).toBe(salesDept);
    expect(await oppDepartment(opp)).toBe(salesDept);
  });
});

describe('0081 seeded marker', () => {
  it('marks every row that existed as seeded and defaults new rows to not seeded', async () => {
    const { rows } = await owner.query<{ role_key: string; seeded: boolean }>(
      "SELECT role_key, seeded FROM app.role_permissions WHERE tenant_id = $1 AND role_key = 'sales'",
      [tenantA.tenantId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.seeded)).toBe(true);
    await writeAs(tenantA, (c) =>
      c.query(
        "INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope) VALUES ($1, 'founder_made', 'memo.read', 'all')",
        [tenantA.tenantId],
      ),
    );
    expect(
      (
        await one<{ seeded: boolean }>(
          "SELECT seeded FROM app.role_permissions WHERE role_key = 'founder_made'",
          [],
        )
      ).seeded,
    ).toBe(false);
  });
});

describe('0082 assigned scope and level grants', () => {
  it('accepts the assigned scope on a role grant and still refuses an unknown one', async () => {
    await writeAs(tenantA, (c) =>
      c.query(
        "INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope) VALUES ($1, 'assignee', 'crm.lead.read', 'assigned')",
        [tenantA.tenantId],
      ),
    );
    await expect(
      writeAs(tenantA, (c) =>
        c.query(
          "INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope) VALUES ($1, 'assignee', 'memo.read', 'everything')",
          [tenantA.tenantId],
        ),
      ),
    ).rejects.toThrow(/role_permissions_scope_check/);
  });

  it('stores a level grant, one per role, permission and level, for manager and head only', async () => {
    const insert = (level: string, scope: string) =>
      writeAs(tenantA, (c) =>
        c.query(
          "INSERT INTO app.role_permission_levels (tenant_id, role_key, permission, min_level, scope) VALUES ($1, 'sales', 'crm.lead.read', $2, $3)",
          [tenantA.tenantId, level, scope],
        ),
      );
    await insert('manager', 'department');
    await insert('head', 'department');
    await expect(insert('manager', 'all')).rejects.toThrow(
      /role_permission_levels_tenant_role_permission_level_unique/,
    );
    await expect(insert('staff', 'own')).rejects.toThrow(/role_permission_levels_min_level_check/);
    await expect(insert('head', 'galaxy')).rejects.toThrow(/role_permission_levels_scope_check/);
  });

  it('audits level grants', async () => {
    const { rows } = await owner.query(
      "SELECT 1 FROM audit.audit_events WHERE entity_type LIKE '%role_permission_levels'",
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('0083 marketing role', () => {
  const marketingOf = async (tenantId: string): Promise<Record<string, string>> => {
    const { rows } = await owner.query<{ permission: string; scope: string; seeded: boolean }>(
      "SELECT permission, scope, seeded FROM app.role_permissions WHERE tenant_id = $1 AND role_key = 'marketing' ORDER BY permission",
      [tenantId],
    );
    expect(rows.every((row) => row.seeded)).toBe(true);
    return Object.fromEntries(rows.map((row) => [row.permission, row.scope]));
  };

  it('gives a tenant that has role rows exactly the Marketing defaults', async () => {
    expect(await marketingOf(tenantA.tenantId)).toEqual(MARKETING_GRANTS);
  });

  it('leaves a tenant with no role rows on the code defaults: a lone Marketing row would hide every other role', async () => {
    expect(await marketingOf(tenantB.tenantId)).toEqual({});
    const { rows } = await owner.query('SELECT 1 FROM app.role_permissions WHERE tenant_id = $1', [
      tenantB.tenantId,
    ]);
    expect(rows).toHaveLength(0);
    const versions = await owner.query('SELECT 1 FROM app.authz_versions WHERE tenant_id = $1', [
      tenantB.tenantId,
    ]);
    expect(versions.rows).toHaveLength(0);
  });

  it('bumps the authz version for a tenant that gained rows and leaves a tenant with no role rows alone', async () => {
    const versionOf = async (tenantId: string) =>
      Number(
        (
          await one<{ version: string }>(
            'SELECT version FROM app.authz_versions WHERE tenant_id = $1',
            [tenantId],
          )
        ).version,
      );
    expect(await versionOf(tenantA.tenantId)).toBe(4);
  });

  it('is idempotent and keeps a Founder-edited marketing grant', async () => {
    const versionBefore = (
      await owner.query<{ version: string }>(
        'SELECT version FROM app.authz_versions WHERE tenant_id = $1',
        [tenantA.tenantId],
      )
    ).rows[0]!.version;
    await writeAs(tenantA, (c) =>
      c.query(
        "UPDATE app.role_permissions SET scope = 'department', seeded = false WHERE tenant_id = $1 AND role_key = 'marketing' AND permission = 'crm.lead.read'",
        [tenantA.tenantId],
      ),
    );
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const statement of sqlOfMarketing) await client.query(statement);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const { rows } = await owner.query(
      "SELECT scope, seeded FROM app.role_permissions WHERE tenant_id = $1 AND role_key = 'marketing' AND permission = 'crm.lead.read'",
      [tenantA.tenantId],
    );
    expect(rows[0]).toEqual({ scope: 'department', seeded: false });
    const versionAfter = (
      await owner.query<{ version: string }>(
        'SELECT version FROM app.authz_versions WHERE tenant_id = $1',
        [tenantA.tenantId],
      )
    ).rows[0]!.version;
    expect(versionAfter).toBe(versionBefore);
    const count = await one<{ n: string }>(
      "SELECT count(*) AS n FROM app.role_permissions WHERE tenant_id = $1 AND role_key = 'marketing'",
      [tenantA.tenantId],
    );
    expect(Number(count.n)).toBe(Object.keys(MARKETING_GRANTS).length);
  });
});
