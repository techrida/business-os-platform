// Integration test for migration 0088 (the default access model, phase 2): Marketing's missing defaults, the D50
// lead access changes on seeded rows, the default level rows, quotations.department_id with its triggers and
// backfill, and the update guard on the 0080 department stamp (D55-4).
// Needs Docker: a real postgres:16-alpine from Testcontainers (its own database, so no compose stack is
// involved). Run with:
//   pnpm --filter @bos/db exec vitest run src/access-phase2-migrations.test.ts
//
// The database is migrated with the real SQL up to the migration before 0088, seeded like tenants that have been
// running (grants the old seed wrote, a grant and a level row a Founder made, a tenant still on the code
// defaults, and quotations on opportunities), then migrated with the real runner, which applies 0088 and
// anything later. The level rows 0088 writes are compared with the copy it embeds; the contracts test compares
// that copy with DEFAULT_ROLE_PERMISSION_LEVELS (this package does not depend on contracts).
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
const TAG = '0088_access_phase2_grants';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface LevelRow {
  role: string;
  permission: string;
  min_level: string;
  scope: string;
}

let container: StartedPostgreSqlContainer;
let admin: Pool;
let owner: Pool;
let beforeFolder: string;
let sql0088: string[];
let embeddedLevels: LevelRow[];

/** Seeded grants, a Founder's grant and a Founder's level row. */
let tenantA: TenantWithEntity;
/** Marketing already holds a Founder-made profile picture grant. */
let tenantB: TenantWithEntity;
let tenantMaterialized: TenantWithEntity;
/** No role_permissions rows: still on the code defaults. */
let tenantC: TenantWithEntity;

let salesDept: string;
let memberUser: string;
let customerId: string;
let oppOfMember: string;
let oppWithoutOwner: string;
let quotationOfMember: string;
let quotationWithoutOwner: string;

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
              set_config('bos.actor_id', 'access-phase2-migration-test', true),
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

const one = async <T>(sql: string, values: unknown[]): Promise<T> => {
  const { rows } = await owner.query(sql, values);
  return rows[0] as T;
};

async function insertGrants(
  org: TenantWithEntity,
  rows: readonly (readonly [role: string, permission: string, scope: string, seeded: boolean])[],
): Promise<void> {
  await writeAs(org, async (c) => {
    for (const [role, permission, scope, seeded] of rows) {
      await c.query(
        'INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded) VALUES ($1, $2, $3, $4, $5)',
        [org.tenantId, role, permission, scope, seeded],
      );
    }
  });
}

/** permission to { scope, seeded } for one role in one tenant. */
async function grantsOf(
  tenantId: string,
  role: string,
): Promise<Record<string, { scope: string; seeded: boolean }>> {
  const { rows } = await owner.query<{ permission: string; scope: string; seeded: boolean }>(
    'SELECT permission, scope, seeded FROM app.role_permissions WHERE tenant_id = $1 AND role_key = $2',
    [tenantId, role],
  );
  return Object.fromEntries(
    rows.map((row) => [row.permission, { scope: row.scope, seeded: row.seeded }]),
  );
}

async function levelRowsOf(tenantId: string): Promise<(LevelRow & { seeded: boolean })[]> {
  const { rows } = await owner.query<LevelRow & { seeded: boolean }>(
    `SELECT role_key AS role, permission, min_level, scope, seeded
       FROM app.role_permission_levels WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows;
}

const levelKey = (row: LevelRow): string =>
  `${row.role} ${row.permission} ${row.min_level} ${row.scope}`;

async function authzVersion(tenantId: string): Promise<number | undefined> {
  const { rows } = await owner.query<{ version: string }>(
    'SELECT version FROM app.authz_versions WHERE tenant_id = $1',
    [tenantId],
  );
  return rows[0] === undefined ? undefined : Number(rows[0].version);
}

async function insertLead(ownerUserId: string | null, departmentId: string | null = null) {
  return writeAs(tenantA, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.leads (tenant_id, organization_id, number, title, source, owner_user_id, department_id, company_name, contact_name)
       VALUES ($1, $2, $3, 'Lead', 'website', $4, $5, 'Acme', 'Asha') RETURNING id`,
      [
        tenantA.tenantId,
        tenantA.organizationId,
        `LD-${randomUUID().slice(0, 8)}`,
        ownerUserId,
        departmentId,
      ],
    );
    return rows[0]!.id;
  });
}

async function insertOpportunity(
  ownerUserId: string | null,
  departmentId: string | null = null,
): Promise<string> {
  return writeAs(tenantA, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.opportunities (tenant_id, organization_id, number, name, customer_id, owner_user_id, department_id)
       VALUES ($1, $2, $3, 'Deal', $4, $5, $6) RETURNING id`,
      [
        tenantA.tenantId,
        tenantA.organizationId,
        `DEAL-${randomUUID().slice(0, 8)}`,
        customerId,
        ownerUserId,
        departmentId,
      ],
    );
    return rows[0]!.id;
  });
}

/** A quotation on `opportunityId`; `departmentId` is what the caller tries to write by hand (0088 or later). */
async function insertQuotation(
  opportunityId: string,
  departmentId?: string | null,
): Promise<string> {
  return writeAs(tenantA, async (c) => {
    const columns = departmentId === undefined ? '' : ', department_id';
    const values = departmentId === undefined ? '' : ', $6';
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.quotations (tenant_id, organization_id, number, customer_party_id, opportunity_id${columns})
       VALUES ($1, $2, $3, $4, $5${values}) RETURNING id`,
      [
        tenantA.tenantId,
        tenantA.organizationId,
        `QT-${randomUUID().slice(0, 8)}`,
        customerId,
        opportunityId,
        ...(departmentId === undefined ? [] : [departmentId]),
      ],
    );
    return rows[0]!.id;
  });
}

const departmentOf = async (table: string, id: string): Promise<string | null> =>
  (
    await one<{ department_id: string | null }>(
      `SELECT department_id FROM app.${table} WHERE id = $1`,
      [id],
    )
  ).department_id;

async function update(table: string, id: string, set: string, value?: unknown): Promise<void> {
  await writeAs(tenantA, (c) =>
    c.query(
      `UPDATE app.${table} SET ${set} WHERE id = $1`,
      value === undefined ? [id] : [id, value],
    ),
  );
}

async function newDepartment(): Promise<{ departmentId: string; userId: string }> {
  const { departmentId } = await createDepartment(owner, tenantA);
  const { userId } = await createStaffUser(owner, { ...tenantA, departmentId });
  return { departmentId, userId };
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
  const index = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(index, `${TAG} is in the journal`).toBeGreaterThan(0);
  beforeFolder = await mkdtemp(join(tmpdir(), 'bos-before-0088-'));
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
  const text = await readFile(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8');
  sql0088 = text.split('--> statement-breakpoint');
  const embedded = /jsonb_to_recordset\('(\[[^']*\])'::jsonb\) AS level_grant\(/.exec(text);
  expect(embedded, 'the level rows 0088 embeds').not.toBeNull();
  embeddedLevels = JSON.parse(embedded![1]!) as LevelRow[];
  await runMigrations(ownerUrl, beforeFolder);

  // Tenant A has been running on the old seed: Finance, Accountant, PMO and Operations Head read every lead and
  // opportunity, Marketing holds 0083's rows, Sales reads its own quotations and Operations Officers their own
  // purchase requests. A Founder widened PMO's lead read and Operations Head's opportunity read by hand, let Sales
  // edit every lead, and gave Sales managers every lead. Finance holds the lead write it starts leads with.
  tenantA = await createTenantWithEntity(owner);
  await insertGrants(tenantA, [
    ['founder', 'memo.read', 'all', true],
    ['finance', 'crm.lead.read', 'all', true],
    ['finance', 'crm.opportunity.read', 'all', true],
    ['finance', 'quotation.read', 'all', true],
    ['finance', 'crm.lead.write', 'own', true],
    ['accountant', 'crm.lead.read', 'all', true],
    ['accountant', 'crm.opportunity.read', 'all', true],
    ['pmo', 'crm.lead.read', 'all', false],
    ['pmo', 'crm.opportunity.read', 'all', true],
    ['operations_head', 'crm.lead.read', 'all', true],
    ['operations_head', 'crm.opportunity.read', 'all', false],
    ['operations_head', 'quotation.read', 'all', true],
    ['sales', 'crm.lead.read', 'own', true],
    ['sales', 'quotation.read', 'own', true],
    ['sales', 'crm.lead.write', 'all', false],
    ['marketing', 'crm.lead.read', 'own', true],
    ['marketing', 'crm.lead.write', 'own', true],
    ['operations_officer', 'procurement.pr.read', 'own', true],
  ]);
  await writeAs(tenantA, async (c) => {
    await c.query(
      `INSERT INTO app.role_permission_levels (tenant_id, role_key, permission, min_level, scope)
       VALUES ($1, 'sales', 'crm.lead.read', 'manager', 'all')`,
      [tenantA.tenantId],
    );
    await c.query('INSERT INTO app.authz_versions (tenant_id, version) VALUES ($1, 3)', [
      tenantA.tenantId,
    ]);
  });

  // Tenant B: a Founder already let Marketing set anyone's picture.
  tenantB = await createTenantWithEntity(owner);
  await insertGrants(tenantB, [
    ['founder', 'memo.read', 'all', true],
    ['marketing', 'profile.avatar.write', 'all', false],
  ]);
  await writeAs(tenantB, (c) =>
    c.query('INSERT INTO app.authz_versions (tenant_id, version) VALUES ($1, 1)', [
      tenantB.tenantId,
    ]),
  );

  tenantC = await createTenantWithEntity(owner);

  // A tenant whose Founder already saved Settings > Access with every department switch off: the level rows are
  // materialised and empty, so 0088 must not write any back.
  tenantMaterialized = await createTenantWithEntity(owner);
  await insertGrants(tenantMaterialized, [
    ['sales', 'crm.lead.read', 'own', true],
    ['sales', 'crm.lead.write', 'own', true],
    ['marketing', 'crm.lead.read', 'own', true],
  ]);
  await writeAs(tenantMaterialized, async (c) => {
    await c.query(
      'INSERT INTO app.access_revisions (tenant_id, revision, level_rules_materialized) VALUES ($1, 1, true)',
      [tenantMaterialized.tenantId],
    );
    await c.query('INSERT INTO app.authz_versions (tenant_id, version) VALUES ($1, 1)', [
      tenantMaterialized.tenantId,
    ]);
  });

  // Quotations before 0088: one on an opportunity whose owner is in the Sales department, one on an opportunity
  // without an owner.
  salesDept = (await createDepartment(owner, tenantA)).departmentId;
  memberUser = (await createStaffUser(owner, { ...tenantA, departmentId: salesDept })).userId;
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
  oppOfMember = await insertOpportunity(memberUser);
  oppWithoutOwner = await insertOpportunity(null);
  quotationOfMember = await insertQuotation(oppOfMember);
  quotationWithoutOwner = await insertQuotation(oppWithoutOwner);

  // The real runner now applies 0088 and everything after it.
  await runMigrations(ownerUrl);
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await admin?.end();
  await container?.stop();
  if (beforeFolder) await rm(beforeFolder, { recursive: true, force: true });
});

describe('0088 Marketing defaults', () => {
  it('gives Marketing its own profile picture and the customers it owns, seeded', async () => {
    const grants = await grantsOf(tenantA.tenantId, 'marketing');
    expect(grants['profile.avatar.write']).toEqual({ scope: 'own', seeded: true });
    expect(grants['customer.read']).toEqual({ scope: 'own', seeded: true });
    expect(grants['crm.lead.read']).toEqual({ scope: 'own', seeded: true });
  });

  it('keeps a picture grant Marketing already holds, and still adds customer read', async () => {
    const grants = await grantsOf(tenantB.tenantId, 'marketing');
    expect(grants['profile.avatar.write']).toEqual({ scope: 'all', seeded: false });
    expect(grants['customer.read']).toEqual({ scope: 'own', seeded: true });
  });
});

describe('0088 D50 lead access on seeded rows', () => {
  it('moves Finance and Accountant from every lead and opportunity to their own', async () => {
    for (const role of ['finance', 'accountant']) {
      const grants = await grantsOf(tenantA.tenantId, role);
      expect(grants['crm.lead.read'], role).toEqual({ scope: 'own', seeded: true });
      expect(grants['crm.opportunity.read'], role).toEqual({ scope: 'own', seeded: true });
    }
    expect((await grantsOf(tenantA.tenantId, 'finance'))['quotation.read']).toEqual({
      scope: 'all',
      seeded: true,
    });
  });

  it('leaves a grant a Founder made: PMO keeps every lead, and moves only its seeded opportunity read', async () => {
    const grants = await grantsOf(tenantA.tenantId, 'pmo');
    expect(grants['crm.lead.read']).toEqual({ scope: 'all', seeded: false });
    expect(grants['crm.opportunity.read']).toEqual({ scope: 'own', seeded: true });
  });

  it('takes the seeded lead read from Operations Head and keeps its other rows', async () => {
    const grants = await grantsOf(tenantA.tenantId, 'operations_head');
    expect(grants['crm.lead.read']).toBeUndefined();
    expect(grants['crm.opportunity.read']).toEqual({ scope: 'all', seeded: false });
    expect(grants['quotation.read']).toEqual({ scope: 'all', seeded: true });
  });
});

describe('0088 level rows', () => {
  // What Settings > Access materialises from its default switches: managers and heads see the department's leads,
  // opportunities and quotations, heads the department's purchase requests, and Sales and Marketing managers and
  // heads also edit the department's leads (Sales its opportunities too) so they can hand work over (D50).
  it('embeds the 27 default rows: department reach to see leads, opportunities, quotations and purchase requests, and to edit leads and opportunities', () => {
    expect(embeddedLevels.map(levelKey).sort()).toEqual(
      [
        'finance crm.lead.read manager department',
        'finance crm.lead.read head department',
        'finance crm.opportunity.read manager department',
        'finance crm.opportunity.read head department',
        'accountant crm.lead.read manager department',
        'accountant crm.lead.read head department',
        'accountant crm.opportunity.read manager department',
        'accountant crm.opportunity.read head department',
        'sales crm.lead.read manager department',
        'sales crm.lead.read head department',
        'sales crm.opportunity.read manager department',
        'sales crm.opportunity.read head department',
        'sales crm.lead.write manager department',
        'sales crm.lead.write head department',
        'sales crm.opportunity.write manager department',
        'sales crm.opportunity.write head department',
        'sales quotation.read manager department',
        'sales quotation.read head department',
        'marketing crm.lead.read manager department',
        'marketing crm.lead.read head department',
        'marketing crm.lead.write manager department',
        'marketing crm.lead.write head department',
        'pmo crm.lead.read manager department',
        'pmo crm.lead.read head department',
        'pmo crm.opportunity.read manager department',
        'pmo crm.opportunity.read head department',
        'operations_officer procurement.pr.read head department',
      ].sort(),
    );
  });

  it('writes a row only where the tenant role reads below the department, seeded, and keeps the level row a Founder made', async () => {
    // Left out: PMO lead rows (a Founder widened its lead read to every lead), Operations Head rows (its lead read
    // is gone and a Founder gave it every opportunity), Sales opportunity rows (no opportunity grant here), Sales
    // lead edit rows (a Founder let Sales edit every lead) and any Finance edit row (it only starts leads).
    const seeded = [
      'finance crm.lead.read manager department',
      'finance crm.lead.read head department',
      'finance crm.opportunity.read manager department',
      'finance crm.opportunity.read head department',
      'accountant crm.lead.read manager department',
      'accountant crm.lead.read head department',
      'accountant crm.opportunity.read manager department',
      'accountant crm.opportunity.read head department',
      'sales crm.lead.read head department',
      'sales quotation.read manager department',
      'sales quotation.read head department',
      'marketing crm.lead.read manager department',
      'marketing crm.lead.read head department',
      'marketing crm.lead.write manager department',
      'marketing crm.lead.write head department',
      'pmo crm.opportunity.read manager department',
      'pmo crm.opportunity.read head department',
      'operations_officer procurement.pr.read head department',
    ];
    const rows = await levelRowsOf(tenantA.tenantId);
    expect(rows.map((row) => `${levelKey(row)} ${row.seeded}`).sort()).toEqual(
      [...seeded.map((key) => `${key} true`), 'sales crm.lead.read manager all false'].sort(),
    );
  });

  it('writes no level row for a tenant whose Founder already saved Settings > Access with the switches off', async () => {
    expect(await levelRowsOf(tenantMaterialized.tenantId)).toEqual([]);
  });

  it('writes no level row for a tenant whose roles hold none of those reads', async () => {
    expect(await levelRowsOf(tenantB.tenantId)).toEqual([]);
  });

  it('audits the level rows as the migration', async () => {
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'role_permission_levels' AND actor_id = 'system:migration-0088'`,
      [tenantA.tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(18);
  });
});

describe('0088 tenants and versions', () => {
  it('leaves a tenant with no role rows on the code defaults: no grant, no level row, no version', async () => {
    const grants = await owner.query('SELECT 1 FROM app.role_permissions WHERE tenant_id = $1', [
      tenantC.tenantId,
    ]);
    expect(grants.rows).toHaveLength(0);
    expect(await levelRowsOf(tenantC.tenantId)).toEqual([]);
    expect(await authzVersion(tenantC.tenantId)).toBeUndefined();
  });

  it('bumps the authz version once for each tenant whose rows changed', async () => {
    expect(await authzVersion(tenantA.tenantId)).toBe(4);
    expect(await authzVersion(tenantB.tenantId)).toBe(2);
  });

  it('changes nothing and bumps nothing when its grant statements run again', async () => {
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
    const grantStatements = sql0088.filter(
      (statement) => statement.includes('set_config') || statement.includes('LOCK TABLE'),
    );
    expect(grantStatements).toHaveLength(3);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const statement of grantStatements) await client.query(statement);
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

describe('0088 quotations.department_id', () => {
  it('backfills existing quotations from their opportunity', async () => {
    expect(await departmentOf('opportunities', oppOfMember)).toBe(salesDept);
    expect(await departmentOf('quotations', quotationOfMember)).toBe(salesDept);
    expect(await departmentOf('quotations', quotationWithoutOwner)).toBeNull();
  });

  it("stamps a new quotation with its opportunity's department, ignoring one written by hand", async () => {
    const other = await newDepartment();
    const opp = await insertOpportunity(memberUser);
    expect(await departmentOf('quotations', await insertQuotation(opp))).toBe(salesDept);
    expect(await departmentOf('quotations', await insertQuotation(opp, other.departmentId))).toBe(
      salesDept,
    );
  });

  it("follows the opportunity when an owner change moves the opportunity's department", async () => {
    const other = await newDepartment();
    const opp = await insertOpportunity(memberUser);
    const quotation = await insertQuotation(opp);
    await update('opportunities', opp, 'owner_user_id = $2', other.userId);
    expect(await departmentOf('opportunities', opp)).toBe(other.departmentId);
    expect(await departmentOf('quotations', quotation)).toBe(other.departmentId);
    await update('opportunities', opp, 'owner_user_id = NULL');
    expect(await departmentOf('quotations', quotation)).toBeNull();
  });

  it('replaces a department written by hand on an update', async () => {
    const other = await newDepartment();
    const opp = await insertOpportunity(memberUser);
    const quotation = await insertQuotation(opp);
    await update('quotations', quotation, 'department_id = $2', other.departmentId);
    expect(await departmentOf('quotations', quotation)).toBe(salesDept);
    await update('quotations', quotation, 'department_id = NULL');
    expect(await departmentOf('quotations', quotation)).toBe(salesDept);
  });

  it('records the backfill under the migration', async () => {
    const event = await one<{ actor_id: string }>(
      `SELECT actor_id FROM audit.audit_events
        WHERE entity_type = 'quotations' AND action = 'quotations.update' AND entity_id = $1
        ORDER BY id LIMIT 1`,
      [quotationOfMember],
    );
    expect(event.actor_id).toBe('system:migration-0088');
  });
});

describe('0088 department stamp on leads and opportunities (D55-4)', () => {
  it('still stamps a new lead and opportunity from the owner, ignoring a department written by hand', async () => {
    const other = await newDepartment();
    expect(await departmentOf('leads', await insertLead(memberUser, other.departmentId))).toBe(
      salesDept,
    );
    expect(
      await departmentOf('opportunities', await insertOpportunity(memberUser, other.departmentId)),
    ).toBe(salesDept);
  });

  it('still re-stamps on an owner change and empties when the owner is removed', async () => {
    const other = await newDepartment();
    for (const table of ['leads', 'opportunities'] as const) {
      const id =
        table === 'leads' ? await insertLead(memberUser) : await insertOpportunity(memberUser);
      await update(table, id, 'owner_user_id = $2', other.userId);
      expect(await departmentOf(table, id), table).toBe(other.departmentId);
      await update(table, id, 'owner_user_id = NULL');
      expect(await departmentOf(table, id), table).toBeNull();
    }
  });

  it('still replaces a department written by hand on an update that leaves the owner alone', async () => {
    const other = await newDepartment();
    for (const table of ['leads', 'opportunities'] as const) {
      const id =
        table === 'leads' ? await insertLead(memberUser) : await insertOpportunity(memberUser);
      await update(table, id, 'department_id = $2', other.departmentId);
      expect(await departmentOf(table, id), table).toBe(salesDept);
    }
  });

  it('keeps the stamp when the owner is written unchanged after moving department', async () => {
    // The owner moves department; their old records stay with the old one (D55-4). Re-saving the same owner (a
    // form that sends every field) must not move the record, nor the quotations of an opportunity.
    const { departmentId: firstDept } = await createDepartment(owner, tenantA);
    const { departmentId: laterDept } = await createDepartment(owner, tenantA);
    const { userId: mover } = await createStaffUser(owner, { ...tenantA, departmentId: firstDept });
    const lead = await insertLead(mover);
    const opp = await insertOpportunity(mover);
    const quotation = await insertQuotation(opp);
    await writeAs(tenantA, (c) =>
      c.query(
        'UPDATE app.user_entities SET department_id = $3 WHERE tenant_id = $1 AND user_id = $2',
        [tenantA.tenantId, mover, laterDept],
      ),
    );
    await update('leads', lead, 'owner_user_id = owner_user_id');
    await update(
      'opportunities',
      opp,
      'owner_user_id = owner_user_id, department_id = department_id',
    );
    expect(await departmentOf('leads', lead)).toBe(firstDept);
    expect(await departmentOf('opportunities', opp)).toBe(firstDept);
    expect(await departmentOf('quotations', quotation)).toBe(firstDept);
  });
});
