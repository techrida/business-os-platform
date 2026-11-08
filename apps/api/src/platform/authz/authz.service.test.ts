// Tests for AuthzService. The key one is a property test: for every scope, org kind, department and
// status, the rows `scopeWhere()` returns from a real Postgres table are exactly the rows `can()`
// allows, so a list never shows a row its detail page would refuse (P1 plan §6.2). Needs Docker:
//   pnpm --filter @bos/api exec vitest run src/platform/authz/authz.service.test.ts
// The fixture table lives in `public` and is read as the container superuser: this test is about the
// SQL, not about migrations or grants (role-cache.test.ts covers those).
//
// ADR 0027: every principal's `organizationId` is the acting legal entity, for staff and portal
// callers alike; a portal caller is told apart by `partyId`. The counterparty columns also hold the
// entity id in some rows, so a comparison with `organizationId` instead of `partyId` would show.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { ErrorBodySchema, type OrgKind, type Permission, type Scope } from '@bos/contracts';
import { type ArgumentsHost, ForbiddenException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { type AnyPgColumn, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from '../db/db.module';
import { ErrorBodyFilter } from '../tenancy/error-body.filter';
import { bindIdentity, bindPrincipal, runWithRequestStore } from '../tenancy/request-context';
import { AuthzService, scopeWhereFor } from './authz.service';
import { can } from './can';
import type { Principal, ResourceRef, ScopableTable } from './principal';
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
