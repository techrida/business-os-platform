// Integration test for migration 0123 (U20a2-Q4): Finance and Accountant read every lead and opportunity again,
// their meaningless department level rows go, and PMO keeps its own read and its managers' and heads' department
// reach (D51). Only seeded rows change; a Founder's rows, a tenant on the code defaults and a tenant whose level
// rules are materialised are handled the 0088 way.
// Needs Docker: a database of its own in the run's shared postgres:16-alpine container (no compose stack is
// involved). Run with:
//   pnpm --filter @bos/db exec vitest run src/finance-accountant-read-all-migration.test.ts
//
// The database is migrated with the real SQL up to the migration before 0123, seeded the way 0088 and the seed
// left running tenants, then migrated with the real runner, which applies 0123 and anything later. The contracts
// test compares the rows 0123 embeds with DEFAULT_ROLE_PERMISSIONS and DEFAULT_ROLE_PERMISSION_LEVELS.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { createTenantWithEntity, type TenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const TAG = '0123_finance_accountant_read_all_crm';
const LEAD = 'crm.lead.read';
const OPP = 'crm.opportunity.read';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

type Grant = readonly [role: string, permission: string, scope: string, seeded: boolean];
type Level = readonly [
  role: string,
  permission: string,
  minLevel: 'manager' | 'head',
  scope: string,
  seeded: boolean,
];

let testDb: TestDatabase;
let owner: Pool;
let beforeFolder: string;
let sql0123: string[];

/** Seeded like 0088 left it, plus a Founder's opportunity read for Accountant and a Founder-made level row. */
let tenantSeeded: TenantWithEntity;
/** A Founder already set Finance and Accountant's reads by hand: nothing to change, no version bump. */
let tenantFounder: TenantWithEntity;
/** Settings > Access saved: one seeded and one Founder-made Finance level row. */
let tenantMaterialized: TenantWithEntity;
/** Rows only for other roles: untouched. */
let tenantOtherRoles: TenantWithEntity;
/** No role_permissions rows: still on the code defaults. */
let tenantDefaults: TenantWithEntity;

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
              set_config('bos.actor_id', 'finance-read-all-migration-test', true),
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

async function seed(
  org: TenantWithEntity,
  grants: readonly Grant[],
  levels: readonly Level[],
  version?: number,
): Promise<void> {
  await writeAs(org, async (c) => {
    for (const [role, permission, scope, seeded] of grants) {
      await c.query(
        'INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded) VALUES ($1, $2, $3, $4, $5)',
        [org.tenantId, role, permission, scope, seeded],
      );
    }
    for (const [role, permission, minLevel, scope, seeded] of levels) {
      await c.query(
        `INSERT INTO app.role_permission_levels (tenant_id, role_key, permission, min_level, scope, seeded)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [org.tenantId, role, permission, minLevel, scope, seeded],
      );
    }
    if (version !== undefined) {
      await c.query('INSERT INTO app.authz_versions (tenant_id, version) VALUES ($1, $2)', [
        org.tenantId,
        version,
      ]);
    }
  });
}

/** `role permission` to `scope seeded` for one tenant. */
async function grantsOf(tenantId: string): Promise<Record<string, string>> {
  const { rows } = await owner.query<{
    role_key: string;
    permission: string;
    scope: string;
    seeded: boolean;
  }>('SELECT role_key, permission, scope, seeded FROM app.role_permissions WHERE tenant_id = $1', [
    tenantId,
  ]);
  return Object.fromEntries(
    rows.map((row) => [`${row.role_key} ${row.permission}`, `${row.scope} ${row.seeded}`]),
  );
}

/** Every level row of one tenant as `role permission min_level scope seeded`, sorted. */
async function levelsOf(tenantId: string): Promise<string[]> {
  const { rows } = await owner.query<{
    role_key: string;
    permission: string;
    min_level: string;
    scope: string;
    seeded: boolean;
  }>(
    `SELECT role_key, permission, min_level, scope, seeded
       FROM app.role_permission_levels WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows
    .map((r) => `${r.role_key} ${r.permission} ${r.min_level} ${r.scope} ${r.seeded}`)
    .sort();
}

async function authzVersion(tenantId: string): Promise<number | undefined> {
  const { rows } = await owner.query<{ version: string }>(
    'SELECT version FROM app.authz_versions WHERE tenant_id = $1',
    [tenantId],
  );
  return rows[0] === undefined ? undefined : Number(rows[0].version);
}

/** The four department level rows 0088 seeded for one role on leads and opportunities. */
const departmentRows = (role: string, seeded = true): Level[] =>
  [LEAD, OPP].flatMap((permission) =>
    (['manager', 'head'] as const).map((minLevel): Level => [
      role,
      permission,
      minLevel,
      'department',
      seeded,
    ]),
  );

const levelKey = ([role, permission, minLevel, scope, seeded]: Level): string =>
  `${role} ${permission} ${minLevel} ${scope} ${seeded}`;

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: false });
  const ownerUrl = testDb.ownerUrl;
  owner = new Pool({ connectionString: ownerUrl, max: 2 });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const index = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(index, `${TAG} is in the journal`).toBeGreaterThan(0);
  beforeFolder = await mkdtemp(join(tmpdir(), 'bos-before-0123-'));
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
  sql0123 = (await readFile(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8')).split(
    '--> statement-breakpoint',
  );
  await runMigrations(ownerUrl, beforeFolder);

  // As 0088 and the seed left a running tenant: Finance, Accountant and PMO read their own leads and
  // opportunities, and their managers and heads the department. A Founder set Accountant's opportunity read to
  // own by hand (seeded false), and made one Finance level row of their own.
  tenantSeeded = await createTenantWithEntity(owner);
  await seed(
    tenantSeeded,
    [
      ['founder', 'memo.read', 'all', true],
      ['finance', LEAD, 'own', true],
      ['finance', OPP, 'own', true],
      ['finance', 'quotation.read', 'all', true],
      ['finance', 'crm.lead.write', 'own', true],
      ['accountant', LEAD, 'own', true],
      ['accountant', OPP, 'own', false],
      ['pmo', LEAD, 'own', true],
      ['pmo', OPP, 'own', true],
      ['sales', LEAD, 'own', true],
    ],
    [
      ...departmentRows('finance').filter(([, p, l]) => !(p === OPP && l === 'head')),
      ['finance', OPP, 'head', 'department', false],
      ...departmentRows('accountant'),
      ...departmentRows('pmo'),
      ['sales', LEAD, 'manager', 'department', true],
    ],
    3,
  );

  // A Founder already chose: Finance reads the department's leads (seeded, but not own) and every opportunity by
  // hand; Accountant reads only its own leads by hand. Nothing is still the 0088 value.
  tenantFounder = await createTenantWithEntity(owner);
  await seed(
    tenantFounder,
    [
      ['finance', LEAD, 'department', true],
      ['finance', OPP, 'all', false],
      ['accountant', LEAD, 'own', false],
    ],
    [['accountant', LEAD, 'manager', 'department', true]],
    2,
  );

  tenantMaterialized = await createTenantWithEntity(owner);
  await seed(
    tenantMaterialized,
    [['finance', LEAD, 'own', true]],
    [
      ['finance', LEAD, 'manager', 'department', true],
      ['finance', LEAD, 'head', 'department', false],
    ],
    1,
  );
  await writeAs(tenantMaterialized, (c) =>
    c.query(
      'INSERT INTO app.access_revisions (tenant_id, revision, level_rules_materialized) VALUES ($1, 1, true)',
      [tenantMaterialized.tenantId],
    ),
  );

  tenantOtherRoles = await createTenantWithEntity(owner);
  await seed(
    tenantOtherRoles,
    [
      ['pmo', LEAD, 'own', true],
      ['sales', LEAD, 'own', true],
    ],
    departmentRows('pmo'),
    5,
  );

  tenantDefaults = await createTenantWithEntity(owner);

  // The real runner now applies 0123 and everything after it.
  await runMigrations(ownerUrl);
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await testDb?.drop();
  if (beforeFolder) await rm(beforeFolder, { recursive: true, force: true });
});

describe('0123 Finance and Accountant base reads', () => {
  it('moves the seeded own lead and opportunity reads of Finance and Accountant to every record', async () => {
    const grants = await grantsOf(tenantSeeded.tenantId);
    expect(grants[`finance ${LEAD}`]).toBe('all true');
    expect(grants[`finance ${OPP}`]).toBe('all true');
    expect(grants[`accountant ${LEAD}`]).toBe('all true');
  });

  it('keeps a read a Founder set by hand, and every other row', async () => {
    const grants = await grantsOf(tenantSeeded.tenantId);
    expect(grants[`accountant ${OPP}`]).toBe('own false');
    expect(grants['finance quotation.read']).toBe('all true');
    expect(grants['finance crm.lead.write']).toBe('own true');
    expect(grants['founder memo.read']).toBe('all true');
    expect(grants[`sales ${LEAD}`]).toBe('own true');
  });

  it('leaves PMO on its own reads (D51)', async () => {
    const grants = await grantsOf(tenantSeeded.tenantId);
    expect(grants[`pmo ${LEAD}`]).toBe('own true');
    expect(grants[`pmo ${OPP}`]).toBe('own true');
    expect((await grantsOf(tenantOtherRoles.tenantId))[`pmo ${LEAD}`]).toBe('own true');
  });

  it('changes nothing that no longer holds the 0088 value, seeded or not', async () => {
    expect(await grantsOf(tenantFounder.tenantId)).toEqual({
      [`finance ${LEAD}`]: 'department true',
      [`finance ${OPP}`]: 'all false',
      [`accountant ${LEAD}`]: 'own false',
      // 0104, 0127, 0128 and 0155 seed these rows to a tenant that stores grants.
      'finance credit.override': 'all true',
      'founder credit.override': 'all true',
      'management credit.override': 'all true',
      'finance customers.credit_limit.write': 'all true',
      'founder customers.credit_limit.write': 'all true',
      'founder customers.owner.write': 'all true',
      'management customers.owner.write': 'all true',
      'finance sales_order.delivery_release': 'all true',
      'founder sales_order.delivery_release': 'all true',
      'management sales_order.delivery_release': 'all true',
      'founder approvals.definitions.publish': 'all true',
      'founder email_delivery.read': 'all true',
      'founder email_delivery.resend': 'all true',
      'management approvals.definitions.publish': 'all true',
      'management approvals.definitions.read': 'all true',
    });
  });
});

describe('0123 level rows', () => {
  it('drops the seeded Finance and Accountant rows the base read now covers, keeps PMO, Sales and a Founder row', async () => {
    expect(await levelsOf(tenantSeeded.tenantId)).toEqual(
      [
        // Accountant's opportunity read stayed own (a Founder's row), so its department rows still widen it.
        ...departmentRows('accountant').filter(([, permission]) => permission === OPP),
        ['finance', OPP, 'head', 'department', false] as const,
        ...departmentRows('pmo'),
        ['sales', LEAD, 'manager', 'department', true] as const,
      ]
        .map(levelKey)
        .sort(),
    );
  });

  it('keeps a seeded row where the role still reads below the department', async () => {
    expect(await levelsOf(tenantFounder.tenantId)).toEqual([
      `accountant ${LEAD} manager department true`,
    ]);
  });

  it('on a materialised tenant drops only the seeded row and keeps the Founder row', async () => {
    expect((await grantsOf(tenantMaterialized.tenantId))[`finance ${LEAD}`]).toBe('all true');
    expect(await levelsOf(tenantMaterialized.tenantId)).toEqual([
      `finance ${LEAD} head department false`,
    ]);
  });

  it('leaves PMO department reach alone in a tenant without Finance or Accountant rows', async () => {
    expect(await levelsOf(tenantOtherRoles.tenantId)).toEqual(
      departmentRows('pmo').map(levelKey).sort(),
    );
  });

  it('audits every change as the migration', async () => {
    const { rows } = await owner.query<{ entity_type: string; n: string }>(
      `SELECT entity_type, count(*) AS n FROM audit.audit_events
        WHERE tenant_id = $1 AND actor_id = 'system:migration-0123'
        GROUP BY entity_type ORDER BY entity_type`,
      [tenantSeeded.tenantId],
    );
    expect(rows.map((row) => [row.entity_type, Number(row.n)])).toEqual([
      ['role_permission_levels', 5],
      ['role_permissions', 3],
    ]);
  });
});

describe('0123 tenants and versions', () => {
  it('bumps the authz version once for each tenant whose rows changed, and only those (0104, 0127, 0128, 0150, 0155 and 0178 add six more bumps where they seed rows)', async () => {
    expect(await authzVersion(tenantSeeded.tenantId)).toBe(10);
    expect(await authzVersion(tenantMaterialized.tenantId)).toBe(8);
    expect(await authzVersion(tenantFounder.tenantId)).toBe(8);
    expect(await authzVersion(tenantOtherRoles.tenantId)).toBe(11);
  });

  it('leaves a tenant with no role rows on the code defaults: no grant, no level row, no version', async () => {
    expect(await grantsOf(tenantDefaults.tenantId)).toEqual({});
    expect(await levelsOf(tenantDefaults.tenantId)).toEqual([]);
    expect(await authzVersion(tenantDefaults.tenantId)).toBeUndefined();
  });

  it('changes nothing and bumps nothing when it runs again', async () => {
    const snapshot = async () => ({
      grants: (
        await owner.query(
          'SELECT tenant_id, role_key, permission, scope, seeded FROM app.role_permissions ORDER BY 1, 2, 3',
        )
      ).rows,
      levels: (
        await owner.query(
          'SELECT tenant_id, role_key, permission, min_level, scope, seeded FROM app.role_permission_levels ORDER BY 1, 2, 3, 4',
        )
      ).rows,
      versions: (await owner.query('SELECT tenant_id, version FROM app.authz_versions ORDER BY 1'))
        .rows,
    });
    const before = await snapshot();
    expect(sql0123).toHaveLength(3);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const statement of sql0123) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    expect(await snapshot()).toEqual(before);
  });
});
