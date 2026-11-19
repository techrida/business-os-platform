// Tests for AuthzService. The key one is a property test: for every scope, org kind, department and
// status, the rows `scopeWhere()` returns from a real Postgres table are exactly the rows `can()`
// allows, so a list never shows a row its detail page would refuse (P1 plan §6.2). A second fixture,
// registered in record-reach.ts like `leads`, does the same for the creator and assignee reach and
// the `assigned` scope, with refs filled by the real `loadReaders()`. Needs Docker:
//   pnpm --filter @bos/api exec vitest run src/platform/authz/authz.service.test.ts
// The fixture table lives in `public` and is read as the container superuser: this test is about the
// SQL, not about migrations or grants (role-cache.test.ts covers those).
//
// ADR 0027: every principal's `organizationId` is the acting legal entity, for staff and portal
// callers alike; a portal caller is told apart by `partyId`. The counterparty columns also hold the
// entity id in some rows, so a comparison with `organizationId` instead of `partyId` would show.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  type AccessScope,
  ErrorBodySchema,
  type OrgKind,
  type Permission,
  type Scope,
} from '@bos/contracts';
import { type ArgumentsHost, ForbiddenException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { type AnyPgColumn, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from '../db/db.module';
import { ErrorBodyFilter } from '../tenancy/error-body.filter';
import { bindIdentity, bindPrincipal, runWithRequestStore } from '../tenancy/request-context';
import { AuthzService, scopeWhereFor } from './authz.service';
import { can } from './can';
import type { Principal, ResourceRef, ScopableTable } from './principal';
import { defineRecordReach, loadReaders } from './record-reach';
import { RoleCache } from './role-cache';

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
/** The acting legal entity, for every org kind. */
const ENTITY = randomUUID();
const OTHER_ENTITY = randomUUID();
const CUSTOMER_PARTY = randomUUID();
const VENDOR_PARTY = randomUUID();
const OTHER_PARTY = randomUUID();
const ME = randomUUID();
const SOMEONE_ELSE = randomUUID();
const MY_DEPT = randomUUID();
const OTHER_DEPT = randomUUID();

const PARTY_OF: Record<OrgKind, string | null> = {
  staff: null,
  customer: CUSTOMER_PARTY,
  vendor: VENDOR_PARTY,
};

// Two Drizzle views of one physical table: one with every scope column, and one with only the
// tenancy columns, which proves "a column the table lacks matches nothing" against `can()`.
const fullTable = pgTable('authz_fixture', {
  id: text('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  ownerUserId: uuid('owner_user_id'),
  departmentId: uuid('department_id'),
  customerPartyId: uuid('customer_party_id'),
  vendorPartyId: uuid('vendor_party_id'),
});
const bareTable = pgTable('authz_fixture', {
  id: text('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
});

type FixtureRow = typeof fullTable.$inferSelect;

/** Every combination of the columns `can()` looks at (2 × 2 × 3 × 3 × 4 × 4 = 576 rows). */
function fixtureRows(): FixtureRow[] {
  const rows: FixtureRow[] = [];
  for (const tenantId of [TENANT, OTHER_TENANT])
    for (const organizationId of [ENTITY, OTHER_ENTITY])
      for (const ownerUserId of [ME, SOMEONE_ELSE, null])
        for (const departmentId of [MY_DEPT, OTHER_DEPT, null])
          // ENTITY in a counterparty column: a party id equal to an entity id must grant nothing.
          for (const customerPartyId of [CUSTOMER_PARTY, ENTITY, OTHER_PARTY, null])
            for (const vendorPartyId of [VENDOR_PARTY, ENTITY, OTHER_PARTY, null])
              rows.push({
                id: `r${rows.length.toString().padStart(4, '0')}`,
                tenantId,
                organizationId,
                ownerUserId,
                departmentId,
                customerPartyId,
                vendorPartyId,
              });
  return rows;
}

const ROWS = fixtureRows();

const fullRef = (r: FixtureRow): ResourceRef => ({ ...r });
const bareRef = (r: FixtureRow): ResourceRef => ({
  tenantId: r.tenantId,
  organizationId: r.organizationId,
});

const ACTION: Permission = 'memo.read'; // not an SoD permission: scopeWhere cannot express SoD

function principalOf(over: Partial<Principal> & { orgKind: OrgKind }): Principal {
  return {
    userId: ME,
    zitadelUserId: 'zitadel-sub-1',
    tenantId: TENANT,
    organizationId: ENTITY,
    partyId: PARTY_OF[over.orgKind],
    idpOrgId: randomUUID(),
    roles: [],
    departmentId: MY_DEPT,
    status: 'active',
    grants: new Map(),
    ...over,
  };
}

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
  db = drizzle({ client: pool });
  await pool.query(`CREATE TABLE public.authz_fixture (
    id text PRIMARY KEY,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    owner_user_id uuid,
    department_id uuid,
    customer_party_id uuid,
    vendor_party_id uuid
  )`);
  await db.insert(fullTable).values(ROWS);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function idsMatching(
  table: ScopableTable & { id: AnyPgColumn },
  p: Principal,
): Promise<string[]> {
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(scopeWhereFor(p, table, ACTION))
    .orderBy(asc(table.id));
  return rows.map((r) => String(r.id));
}

describe('AuthzService.scopeWhere', () => {
  const SCOPE_CASES: (Scope | 'none' | 'unknown')[] = [
    'own',
    'department',
    'customer_org',
    'all',
    'none',
    'unknown',
  ];
  const TABLES = [
    { name: 'full table', table: fullTable, ref: fullRef },
    { name: 'tenancy-only table', table: bareTable, ref: bareRef },
  ] as const;

  it('returns exactly the rows can() allows, for every scope, org kind, party, department and status', async () => {
    let nonEmptyCases = 0;
    for (const { name, table, ref } of TABLES)
      for (const orgKind of ['staff', 'customer', 'vendor'] as const)
        // A portal principal with no party (a misbuilt principal) must reach no counterparty row.
        for (const partyId of orgKind === 'staff' ? [null] : [PARTY_OF[orgKind], null])
          for (const scope of SCOPE_CASES)
            for (const departmentId of [MY_DEPT, null])
              for (const status of ['active', 'inactive'] as const) {
                const grants = new Map<Permission, Scope>();
                // 'unknown' stands for a bad role_permissions row: neither side may treat it as a grant.
                if (scope !== 'none') grants.set(ACTION, scope as Scope);
                const p = principalOf({ orgKind, partyId, departmentId, status, grants });

                const expected = ROWS.filter((r) => can(p, ACTION, ref(r)).allowed).map(
                  (r) => r.id,
                );
                const actual = await idsMatching(table, p);
                expect(
                  actual,
                  `${name} ${orgKind} party=${partyId} ${scope} dept=${departmentId} ${status}`,
                ).toEqual(expected);
                if (expected.length > 0) nonEmptyCases++;
              }
    // Guard against a vacuous pass (both sides empty everywhere).
    expect(nonEmptyCases).toBeGreaterThan(20);
  });

  it.each(['customer_org', 'all'] as const)(
    'shows a customer with %s only the rows of the acting entity that name its party',
    async (scope) => {
      const p = principalOf({ orgKind: 'customer', grants: new Map([[ACTION, scope]]) });

      const ids = await idsMatching(fullTable, p);
      const want = ROWS.filter(
        (r) =>
          r.tenantId === TENANT &&
          r.organizationId === ENTITY &&
          r.customerPartyId === CUSTOMER_PARTY,
      ).map((r) => r.id);
      // 3 owners × 3 departments × 4 vendor values. Rows with the entity id as the party are out.
      expect(want).toHaveLength(36);
      expect(ids).toEqual(want);
    },
  );

  it('reads the principal from the request when called on the service', async () => {
    const p = principalOf({ orgKind: 'customer', grants: new Map([[ACTION, 'all']]) });
    const service = new AuthzService(db, new RoleCache(db));

    const ids = await inRequest(p, async () => {
      const rows = await db
        .select({ id: fullTable.id })
        .from(fullTable)
        .where(service.scopeWhere(fullTable, ACTION))
        .orderBy(asc(fullTable.id));
      return rows.map((r) => r.id);
    });

    expect(ids).toEqual(await idsMatching(fullTable, p));
    expect(ids.length).toBeGreaterThan(0);
  });
});

/** Runs `fn` with `p` bound as the request principal, the way the tenancy interceptor would. */
function inRequest<T>(p: Principal, fn: () => T): T {
  return runWithRequestStore('test-correlation-id', () => {
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
    return fn();
  });
}

/** What ErrorBodyFilter would send for `exception`, through fake Express objects. */
function errorBodyOf(exception: unknown): { status?: number; body?: unknown } {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    headersSent: false,
    setHeader: () => undefined,
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: unknown) {
      out.body = body;
    },
  };
  const req = { method: 'GET', path: '/v1/memos/1', headers: {} };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;
  new ErrorBodyFilter().catch(exception, host);
  return out;
}

describe('AuthzService.assert', () => {
  const service = (): AuthzService => new AuthzService({} as Db, new RoleCache({} as Db));
  const record: ResourceRef = { tenantId: TENANT, organizationId: ENTITY, ownerUserId: ME };

  /** The exception `assert` throws for `p`, or undefined when it allows. */
  function thrown(p: Principal, action: Permission, r?: ResourceRef): unknown {
    try {
      inRequest(p, () => service().assert(action, r));
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it('does nothing when can() allows', () => {
    const p = principalOf({ orgKind: 'staff', grants: new Map([[ACTION, 'own']]) });
    expect(thrown(p, ACTION, record)).toBeUndefined();
    expect(thrown(p, ACTION)).toBeUndefined();
  });

  it.each([
    ['no_permission', principalOf({ orgKind: 'staff' }), ACTION, record],
    [
      'out_of_scope',
      principalOf({ orgKind: 'staff', grants: new Map([[ACTION, 'own']]) }),
      ACTION,
      { ...record, ownerUserId: SOMEONE_ELSE },
    ],
    [
      'inactive_user',
      principalOf({ orgKind: 'staff', status: 'inactive', grants: new Map([[ACTION, 'all']]) }),
      ACTION,
      record,
    ],
    [
      'separation_of_duties',
      principalOf({ orgKind: 'staff', grants: new Map([['approvals.requests.act', 'all']]) }),
      'approvals.requests.act',
      { ...record, sodUserIds: [ME] },
    ],
  ] as const)(
    'throws a 403 carrying reason %s, which the error filter passes through',
    (reason, p, action, r) => {
      const error = thrown(p, action, r);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toEqual({
        code: 'forbidden',
        message: 'Forbidden',
        reason,
      });
      const sent = errorBodyOf(error);
      expect(sent.status).toBe(403);
      expect(ErrorBodySchema.parse(sent.body).error).toMatchObject({ code: 'forbidden', reason });
    },
  );
});

// D50 and D55-3 through record-reach.ts: a table registered there is filtered by its own columns, and
// `own` on its read permission also reaches the creator and every holder of a live assignment. The
// fixture stands in for `leads` (same read permission, same reach shape), and the refs come from the
// real `loadReaders()`, so the list query and the record check a service builds agree, row for row.
const reachTable = pgTable('authz_reach_fixture', {
  id: text('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  ownerUserId: uuid('owner_user_id'),
  departmentId: uuid('department_id'),
  createdBy: uuid('created_by'),
});
const reachAssignments = pgTable('authz_reach_assignment', {
  id: text('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  subjectId: text('subject_id').notNull(),
  assigneeUserId: uuid('assignee_user_id'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
});
/** The same rows seen as an invoice-like table: owned through `created_by`, with no department. */
const createdByTable = pgTable('authz_reach_fixture', {
  id: text('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  createdBy: uuid('created_by'),
});

const READ: Permission = 'crm.lead.read';
const WRITE: Permission = 'crm.lead.write';

defineRecordReach(reachTable, {
  id: reachTable.id,
  owner: reachTable.ownerUserId,
  department: reachTable.departmentId,
  readPermission: READ,
  creator: reachTable.createdBy,
  assignment: { table: reachAssignments, subject: reachAssignments.subjectId },
});
defineRecordReach(createdByTable, { id: createdByTable.id, owner: createdByTable.createdBy });

/** Who holds a follow-up on a row: the cases a live-assignment check must tell apart. */
const ASSIGNMENTS = [
  'none',
  'me',
  'me-cancelled',
  'someone-else',
  'unassigned',
  'me-in-other-entity',
] as const;
type Assignment = (typeof ASSIGNMENTS)[number];

type ReachRow = typeof reachTable.$inferSelect;
type AssignmentRow = typeof reachAssignments.$inferInsert;

const otherEntityThan = (organizationId: string): string =>
  organizationId === ENTITY ? OTHER_ENTITY : ENTITY;

/** 2 tenants × 2 entities × 3 owners × 3 departments × 3 creators × 6 follow-ups = 648 rows. */
function reachFixture(): {
  rows: ReachRow[];
  assignments: AssignmentRow[];
  followUp: ReadonlyMap<string, Assignment>;
} {
  const rows: ReachRow[] = [];
  const assignments: AssignmentRow[] = [];
  const followUp = new Map<string, Assignment>();
  for (const tenantId of [TENANT, OTHER_TENANT])
    for (const organizationId of [ENTITY, OTHER_ENTITY])
      for (const ownerUserId of [ME, SOMEONE_ELSE, null])
        for (const departmentId of [MY_DEPT, OTHER_DEPT, null])
          for (const createdBy of [ME, SOMEONE_ELSE, null])
            for (const assignment of ASSIGNMENTS) {
              const id = `x${rows.length.toString().padStart(4, '0')}`;
              rows.push({ id, tenantId, organizationId, ownerUserId, departmentId, createdBy });
              followUp.set(id, assignment);
              if (assignment === 'none') continue;
              let assigneeUserId: string | null = ME;
              if (assignment === 'someone-else') assigneeUserId = SOMEONE_ELSE;
              if (assignment === 'unassigned') assigneeUserId = null;
              assignments.push({
                id: `a${id}`,
                tenantId,
                organizationId:
                  assignment === 'me-in-other-entity'
                    ? otherEntityThan(organizationId)
                    : organizationId,
                subjectId: id,
                assigneeUserId,
                cancelledAt: assignment === 'me-cancelled' ? new Date() : null,
              });
            }
  return { rows, assignments, followUp };
}

const FIXTURE = reachFixture();

describe('AuthzService.scopeWhere on a table described in record-reach.ts', () => {
  /** Each row's ResourceRef, filled the way a service fills it: its columns plus `loadReaders()`. */
  const refs = new Map<string, ResourceRef>();
  /** The invoice-like view's refs: the owner is whoever entered the row. */
  const createdByRefs = new Map<string, ResourceRef>();

  beforeAll(async () => {
    await pool.query(`CREATE TABLE public.authz_reach_fixture (
      id text PRIMARY KEY,
      tenant_id uuid NOT NULL,
      organization_id uuid NOT NULL,
      owner_user_id uuid,
      department_id uuid,
      created_by uuid
    )`);
    await pool.query(`CREATE TABLE public.authz_reach_assignment (
      id text PRIMARY KEY,
      tenant_id uuid NOT NULL,
      organization_id uuid NOT NULL,
      subject_id text NOT NULL,
      assignee_user_id uuid,
      cancelled_at timestamptz
    )`);
    await db.insert(reachTable).values(FIXTURE.rows);
    await db.insert(reachAssignments).values(FIXTURE.assignments);

    const readers = await loadReaders(
      db,
      { tenantId: TENANT, organizationId: ENTITY },
      reachTable,
      FIXTURE.rows.map((r) => r.id),
    );
    for (const r of FIXTURE.rows) {
      const found = readers.get(r.id);
      if (found === undefined) throw new Error(`loadReaders() left out ${r.id}`);
      refs.set(r.id, {
        tenantId: r.tenantId,
        organizationId: r.organizationId,
        ownerUserId: r.ownerUserId,
        departmentId: r.departmentId,
        creatorUserId: found.creatorUserId,
        assigneeUserIds: found.assigneeUserIds,
      });
      createdByRefs.set(r.id, {
        tenantId: r.tenantId,
        organizationId: r.organizationId,
        ownerUserId: r.createdBy,
      });
    }
  }, 60_000);

  /** The ref of `id`. Never undefined: `can()` with no ref is a route-level check and would allow. */
  const refIn = (map: ReadonlyMap<string, ResourceRef>, id: string): ResourceRef => {
    const ref = map.get(id);
    if (ref === undefined) throw new Error(`no ref for ${id}`);
    return ref;
  };

  const allowedIds = (
    map: ReadonlyMap<string, ResourceRef>,
    p: Principal,
    action: Permission,
  ): string[] =>
    FIXTURE.rows.filter((r) => can(p, action, refIn(map, r.id)).allowed).map((r) => r.id);

  const followUpOf = (r: ReachRow): Assignment | undefined => FIXTURE.followUp.get(r.id);

  async function listedIds(
    table: ScopableTable & { id: AnyPgColumn },
    p: Principal,
    action: Permission,
  ): Promise<string[]> {
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(scopeWhereFor(p, table, action))
      .orderBy(asc(table.id));
    return rows.map((r) => String(r.id));
  }

  /** Rows of the acting entity owned by someone else in another department: only reach can match. */
  const theirs = (pick: (r: ReachRow) => boolean): string[] =>
    FIXTURE.rows
      .filter(
        (r) =>
          r.tenantId === TENANT &&
          r.organizationId === ENTITY &&
          r.ownerUserId === SOMEONE_ELSE &&
          r.departmentId === OTHER_DEPT &&
          pick(r),
      )
      .map((r) => r.id);

  it('returns exactly the rows can() allows, on the read with its reach and the write without', async () => {
    let nonEmptyCases = 0;
    const scopes: (AccessScope | 'none')[] = ['assigned', 'own', 'department', 'all', 'none'];
    for (const action of [READ, WRITE])
      for (const scope of scopes)
        for (const departmentId of [MY_DEPT, null]) {
          const grants = new Map<Permission, AccessScope>();
          if (scope !== 'none') grants.set(action, scope);
          const p = principalOf({ orgKind: 'staff', departmentId, grants });

          const expected = allowedIds(refs, p, action);
          expect(
            await listedIds(reachTable, p, action),
            `${action} ${scope} dept=${departmentId}`,
          ).toEqual(expected);
          if (expected.length > 0) nonEmptyCases++;
        }
    expect(nonEmptyCases).toBeGreaterThan(10);
  });

  it('reaches a row I entered or hold a live follow-up on with own, read only', async () => {
    const reader = principalOf({ orgKind: 'staff', grants: new Map([[READ, 'own']]) });
    const writer = principalOf({ orgKind: 'staff', grants: new Map([[WRITE, 'own']]) });
    const readIds = await listedIds(reachTable, reader, READ);
    const writeIds = await listedIds(reachTable, writer, WRITE);

    const entered = theirs((r) => r.createdBy === ME);
    const following = theirs((r) => r.createdBy !== ME && followUpOf(r) === 'me');
    const notMine = theirs((r) => r.createdBy !== ME && followUpOf(r) !== 'me');
    expect(entered.length).toBeGreaterThan(0);
    expect(following.length).toBeGreaterThan(0);
    expect(notMine.length).toBeGreaterThan(0);

    expect(readIds).toEqual(expect.arrayContaining([...entered, ...following]));
    // Cancelled, someone else's, unassigned and other-entity follow-ups hand nothing over.
    for (const id of notMine) expect(readIds).not.toContain(id);
    for (const id of [...entered, ...following]) expect(writeIds).not.toContain(id);
  });

  it('gives assigned only the rows with my live follow-up, and nothing on a write', async () => {
    const p = principalOf({
      orgKind: 'staff',
      grants: new Map<Permission, AccessScope>([
        [READ, 'assigned'],
        [WRITE, 'assigned'],
      ]),
    });
    const want = FIXTURE.rows
      .filter((r) => r.tenantId === TENANT && r.organizationId === ENTITY && followUpOf(r) === 'me')
      .map((r) => r.id);
    expect(want.length).toBeGreaterThan(0);
    expect(await listedIds(reachTable, p, READ)).toEqual(want);
    expect(await listedIds(reachTable, p, WRITE)).toEqual([]);
  });

  it('reads the owner from the registered column, and lets department act as own without one', async () => {
    const want = FIXTURE.rows
      .filter((r) => r.tenantId === TENANT && r.organizationId === ENTITY && r.createdBy === ME)
      .map((r) => r.id);
    expect(want.length).toBeGreaterThan(0);
    for (const scope of ['own', 'department'] as const)
      for (const departmentId of [MY_DEPT, null]) {
        const p = principalOf({
          orgKind: 'staff',
          departmentId,
          grants: new Map([[ACTION, scope]]),
        });
        expect(allowedIds(createdByRefs, p, ACTION)).toEqual(want);
        expect(await listedIds(createdByTable, p, ACTION)).toEqual(want);
      }
  });
});
