// The record reach of record-reach.ts against the migrated schema: `scopeWhereFor()` filters real
// `app.leads` by owner, creator, live follow-up and department, and real `app.invoices` and
// `app.vendor_bills` by the column that names who entered them. The record check agrees with each
// list, through refs built by the real `loadReaders()`. Needs Docker:
//   pnpm --filter @bos/api exec vitest run src/platform/authz/record-reach.integration.test.ts
//
// The rows are written as the container superuser with `session_replication_role = replica`, so the
// foreign keys to users, parties and documents and the department-stamp trigger stay out of the way:
// this test is about which rows each scope reaches, and every row states its columns outright. The
// reads go through `withTx()` as `bos_app`, under row-level security, the way a service reads.
import { randomUUID } from 'node:crypto';

import type { AccessScope, Permission } from '@bos/contracts';
import { createTenantWithEntity, invoices, leads, runMigrations, vendorBills } from '@bos/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from '../db/db.module';
import { type TxScope, systemActor, withTx } from '../db/tx';
import { scopeWhereFor } from './authz.service';
import { can } from './can';
import type { Principal, ResourceRef, ScopableTable } from './principal';
import { loadReaders } from './record-reach';

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

const ME = randomUUID();
const SOMEONE_ELSE = randomUUID();
const MY_DEPT = randomUUID();
const OTHER_DEPT = randomUUID();

let container: StartedPostgreSqlContainer;
let appPool: Pool;
let db: Db;
let scope: TxScope;

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

/** The leads, by what makes each one reachable (or not) for ME. */
const LEAD = {
  mine: randomUUID(),
  enteredByMe: randomUUID(),
  myFollowUp: randomUUID(),
  myCancelledFollowUp: randomUUID(),
  theirFollowUp: randomUUID(),
  myDepartment: randomUUID(),
  noDepartment: randomUUID(),
  mineInOtherEntity: randomUUID(),
} as const;

const INVOICE = { mine: randomUUID(), theirs: randomUUID(), nobodys: randomUUID() } as const;
const BILL = { mine: randomUUID(), theirs: randomUUID() } as const;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  await admin.query('REVOKE ALL ON DATABASE bos FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin.end();

  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();

  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 4 });
  db = drizzle({ client: appPool });
  const created = await createTenantWithEntity(appPool);
  scope = { tenantId: created.tenantId, organizationId: created.organizationId };

  const seed = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  const client = await seed.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    const { tenantId: t, organizationId: o } = scope;
    const otherEntity = randomUUID();
    let n = 0;
    const lead = async (
      id: string,
      org: string,
      owner: string,
      department: string | null,
      createdBy: string | null,
    ): Promise<void> => {
      n += 1;
      await client.query(
        `INSERT INTO app.leads (id, tenant_id, organization_id, number, title, source, owner_user_id,
           company_name, contact_name, stage, department_id, created_by_user_id)
         VALUES ($1, $2, $3, $4, 'Reach fixture', 'website', $5, 'Acme Pvt Ltd', 'Sita Sharma',
           'new', $6, $7)`,
        [id, t, org, `LD-2026-${n.toString().padStart(4, '0')}`, owner, department, createdBy],
      );
    };
    await lead(LEAD.mine, o, ME, OTHER_DEPT, null);
    await lead(LEAD.enteredByMe, o, SOMEONE_ELSE, OTHER_DEPT, ME);
    await lead(LEAD.myFollowUp, o, SOMEONE_ELSE, OTHER_DEPT, SOMEONE_ELSE);
    await lead(LEAD.myCancelledFollowUp, o, SOMEONE_ELSE, OTHER_DEPT, null);
    await lead(LEAD.theirFollowUp, o, SOMEONE_ELSE, OTHER_DEPT, null);
    await lead(LEAD.myDepartment, o, SOMEONE_ELSE, MY_DEPT, null);
    await lead(LEAD.noDepartment, o, SOMEONE_ELSE, null, null);
    await lead(LEAD.mineInOtherEntity, otherEntity, ME, MY_DEPT, ME);

    const followUp = async (
      org: string,
      leadId: string,
      assignee: string,
      cancelled: boolean,
    ): Promise<void> => {
      await client.query(
        `INSERT INTO app.activities (tenant_id, organization_id, kind, subject, lead_id, due_at,
           assignee_user_id, cancelled_at)
         VALUES ($1, $2, 'call', 'Call back', $3, now(), $4, CASE WHEN $5 THEN now() END)`,
        [t, org, leadId, assignee, cancelled],
      );
    };
    await followUp(o, LEAD.myFollowUp, ME, false);
    await followUp(o, LEAD.myCancelledFollowUp, ME, true);
    await followUp(o, LEAD.theirFollowUp, SOMEONE_ELSE, false);
    await followUp(otherEntity, LEAD.mineInOtherEntity, ME, false);

    for (const [id, createdBy] of [
      [INVOICE.mine, ME],
      [INVOICE.theirs, SOMEONE_ELSE],
      [INVOICE.nobodys, null],
    ] as const) {
      await client.query(
        `INSERT INTO app.invoices (id, tenant_id, organization_id, kind, customer_party_id,
           manual_reason, currency, subtotal, discount_amount, taxable_vat_amount, tax_amount, total,
           status, created_by)
         VALUES ($1, $2, $3, 'tax_invoice', $4, 'One-off hardware sale', 'NPR', '100.00', '0.00',
           '100.00', '0.00', '100.00', 'draft', $5)`,
        [id, t, o, randomUUID(), createdBy],
      );
    }
    for (const [id, enteredBy] of [
      [BILL.mine, ME],
      [BILL.theirs, SOMEONE_ELSE],
    ] as const) {
      await client.query(
        `INSERT INTO app.vendor_bills (id, tenant_id, organization_id, vendor_id, vendor_invoice_no,
           invoice_date, fiscal_year, currency, document_id, status, fx_rate, payable_total_npr,
           entered_by)
         VALUES ($1, $2, $3, $4, $5, '2026-11-09', '2083/84', 'NPR', $6, 'draft', 1, 0, $7)`,
        [id, t, o, randomUUID(), `INV-${id.slice(0, 8)}`, randomUUID(), enteredBy],
      );
    }
    await client.query('COMMIT');
  } finally {
    client.release();
    await seed.end();
  }
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await container?.stop();
});

function staff(grants: [Permission, AccessScope][], departmentId: string | null): Principal {
  return {
    userId: ME,
    zitadelUserId: 'zitadel-sub-reach',
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: randomUUID(),
    roles: [],
    departmentId,
    status: 'active',
    grants: new Map(grants),
  };
}

/** The ids `scopeWhereFor()` lists for `p`, read the way a service reads. */
async function listed(
  table: ScopableTable & { id: AnyPgColumn },
  p: Principal,
  action: Permission,
): Promise<string[]> {
  const rows = await withTx(db, scope, systemActor('test'), async (tx) =>
    tx
      .select({ id: table.id })
      .from(table)
      .where(scopeWhereFor(p, table, action))
      .orderBy(asc(table.id)),
  );
  return rows.map((r) => String(r.id));
}

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

describe('scopeWhereFor on app.leads', () => {
  const READ: Permission = 'crm.lead.read';
  const WRITE: Permission = 'crm.lead.write';
  const ALL_LEADS = Object.values(LEAD);

  /** Each lead's ref as a service builds it: its own columns plus `loadReaders()`. */
  async function leadRefs(): Promise<Map<string, ResourceRef>> {
    return withTx(db, scope, systemActor('test'), async (tx) => {
      const rows = await tx
        .select({
          id: leads.id,
          tenantId: leads.tenantId,
          organizationId: leads.organizationId,
          ownerUserId: leads.ownerUserId,
          departmentId: leads.departmentId,
        })
        .from(leads)
        .where(inArray(leads.id, ALL_LEADS));
      const readers = await loadReaders(
        tx,
        scope,
        leads,
        rows.map((r) => r.id),
      );
      return new Map(
        rows.map((r): [string, ResourceRef] => [
          r.id,
          {
            ...r,
            creatorUserId: readers.get(r.id)?.creatorUserId ?? null,
            assigneeUserIds: readers.get(r.id)?.assigneeUserIds ?? [],
          },
        ]),
      );
    });
  }

  const CASES: {
    action: Permission;
    scope: AccessScope;
    departmentId: string | null;
    want: string[];
  }[] = [
    {
      action: READ,
      scope: 'own',
      departmentId: MY_DEPT,
      want: [LEAD.mine, LEAD.enteredByMe, LEAD.myFollowUp],
    },
    {
      action: READ,
      scope: 'department',
      departmentId: MY_DEPT,
      want: [LEAD.mine, LEAD.enteredByMe, LEAD.myFollowUp, LEAD.myDepartment],
    },
    {
      action: READ,
      scope: 'department',
      departmentId: null,
      want: [LEAD.mine, LEAD.enteredByMe, LEAD.myFollowUp],
    },
    { action: READ, scope: 'assigned', departmentId: MY_DEPT, want: [LEAD.myFollowUp] },
    {
      action: READ,
      scope: 'all',
      departmentId: MY_DEPT,
      want: ALL_LEADS.filter((id) => id !== LEAD.mineInOtherEntity),
    },
    // Writes stay with the owner (D55-3): the creator and the assignee reach nothing here.
    { action: WRITE, scope: 'own', departmentId: MY_DEPT, want: [LEAD.mine] },
    {
      action: WRITE,
      scope: 'department',
      departmentId: MY_DEPT,
      want: [LEAD.mine, LEAD.myDepartment],
    },
    { action: WRITE, scope: 'assigned', departmentId: MY_DEPT, want: [] },
  ];

  it.each(CASES)(
    '$action at $scope (department $departmentId) lists the expected leads, as can() decides',
    async ({ action, scope: granted, departmentId, want }) => {
      const p = staff([[action, granted]], departmentId);
      const refs = await leadRefs();
      expect(refs.has(LEAD.mine)).toBe(true);

      expect(sorted(await listed(leads, p, action))).toEqual(sorted(want));
      const allowed = [...refs].filter(([, ref]) => can(p, action, ref).allowed).map(([id]) => id);
      expect(sorted(allowed)).toEqual(sorted(want));
    },
  );
});

describe('scopeWhereFor on app.invoices and app.vendor_bills', () => {
  it.each(['own', 'department'] as const)(
    'reads the owner of an invoice from created_by at %s, which has no department',
    async (granted) => {
      for (const departmentId of [MY_DEPT, null]) {
        const p = staff([['invoice.read', granted]], departmentId);
        expect(await listed(invoices, p, 'invoice.read')).toEqual([INVOICE.mine]);
        // The ref an invoice service must build for the record check to agree: owner = created_by.
        const enteredBy = (createdBy: string | null): ResourceRef => ({
          ...scope,
          ownerUserId: createdBy,
        });
        expect(can(p, 'invoice.read', enteredBy(ME)).allowed).toBe(true);
        expect(can(p, 'invoice.read', enteredBy(SOMEONE_ELSE)).allowed).toBe(false);
        expect(can(p, 'invoice.read', enteredBy(null)).allowed).toBe(false);
      }
    },
  );

  it.each(['own', 'department'] as const)(
    'reads the owner of a vendor bill from entered_by at %s',
    async (granted) => {
      const p = staff([['payables.bill.read', granted]], MY_DEPT);
      expect(await listed(vendorBills, p, 'payables.bill.read')).toEqual([BILL.mine]);
    },
  );

  it('lists every invoice and bill of the entity at all', async () => {
    const p = staff(
      [
        ['invoice.read', 'all'],
        ['payables.bill.read', 'all'],
      ],
      MY_DEPT,
    );
    expect(sorted(await listed(invoices, p, 'invoice.read'))).toEqual(
      sorted(Object.values(INVOICE)),
    );
    expect(sorted(await listed(vendorBills, p, 'payables.bill.read'))).toEqual(
      sorted(Object.values(BILL)),
    );
  });
});
