// Integration test for RoleCache and AuthzService.invalidate: a real postgres:16-alpine started by
// Testcontainers (needs Docker). Run with:
//   pnpm --filter @bos/api exec vitest run src/platform/authz/role-cache.test.ts
//
// It proves the R11 promises (P1 plan §10): the defaults cover an org with no rows, rows replace
// them, the widest scope wins, the version is read at most once per org every 5 s, and a bump from
// another api instance is picked up once that window passes. Setup is the same as
// settings/numbering.service.test.ts: roles and default privileges as in init-dbs.sh, migrate as
// bos_owner, then work as bos_app.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { organizations, rolePermissions, runMigrations, tenants } from '@bos/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Db } from '../db/db.module';
import { type TxScope, systemActor, withTx } from '../db/tx';
import { AuthzService } from './authz.service';
import { RoleCache, VERSION_CHECK_TTL_MS } from './role-cache';

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

let container: StartedPostgreSqlContainer;
let appPool: Pool;
let db: Db;
let now = 1_000_000;
const clock = (): number => now;

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

/** A fresh tenant and staff org, so every test starts with no rows and no version. */
async function newOrg(): Promise<TxScope> {
  const tenantId = randomUUID();
  const organizationId = randomUUID();
  const scope = { tenantId, organizationId };
  await withTx(db, scope, systemActor('test'), async (tx) => {
    await tx.insert(tenants).values({ id: tenantId });
    await tx.insert(organizations).values({
      id: organizationId,
      tenantId,
      organizationId,
      kind: 'staff',
      name: 'Techrida',
      zitadelOrgId: `zitadel-${organizationId}`,
    });
  });
  return scope;
}

type Row = [role: RoleKey, permission: Permission, scope: Scope];

/** Replaces the org's role_permissions with `rows`, through withTx like every app write. */
async function setRows(scope: TxScope, rows: readonly Row[]): Promise<void> {
  await withTx(db, scope, systemActor('test'), async (tx) => {
    await tx
      .delete(rolePermissions)
      .where(
        and(
          eq(rolePermissions.tenantId, scope.tenantId),
          eq(rolePermissions.organizationId, scope.organizationId),
        ),
      );
    if (rows.length > 0) {
      await tx
        .insert(rolePermissions)
        .values(
          rows.map(([roleKey, permission, s]) => ({ ...scope, roleKey, permission, scope: s })),
        );
    }
  });
}

const grantsOf = (map: ReadonlyMap<Permission, Scope>): Record<string, Scope> =>
  Object.fromEntries(map);

/** Another api instance: its own cache, sharing only the database. */
const otherInstance = (): AuthzService => new AuthzService(db, new RoleCache(db, clock));

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
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await container?.stop();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('RoleCache.grantsFor', () => {
  it('falls back to DEFAULT_ROLE_PERMISSIONS when the org has no role_permissions rows', async () => {
    const org = await newOrg();
    const cache = new RoleCache(db, clock);

    const sales = await cache.grantsFor(org.tenantId, org.organizationId, ['sales']);
    expect(grantsOf(sales)).toEqual(DEFAULT_ROLE_PERMISSIONS.sales);

    const founder = await cache.grantsFor(org.tenantId, org.organizationId, ['founder']);
    expect(founder.size).toBe(PERMISSIONS.length);
    expect([...founder.values()].every((s) => s === 'all')).toBe(true);
  });

  it('uses the rows instead of the defaults once the org has any', async () => {
    const org = await newOrg();
    await setRows(org, [['sales', 'memo.read', 'department']]);
    const cache = new RoleCache(db, clock);

    const sales = await cache.grantsFor(org.tenantId, org.organizationId, ['sales']);
    expect(grantsOf(sales)).toEqual({ 'memo.read': 'department' });
    // A role with no rows in an org that has rows grants nothing: the table is the whole truth.
    const founder = await cache.grantsFor(org.tenantId, org.organizationId, ['founder']);
    expect(founder.size).toBe(0);
  });

  it('takes the union of the roles, and the widest scope when they overlap', async () => {
    const org = await newOrg();
    await setRows(org, [
      ['sales', 'memo.read', 'own'],
      ['sales', 'memo.create', 'own'],
      ['management', 'memo.read', 'department'],
      ['customer_user', 'memo.read', 'customer_org'],
      ['finance', 'memo.read', 'all'],
      ['finance', 'audit.read', 'all'],
    ]);
    const cache = new RoleCache(db, clock);
    const grants = (roles: RoleKey[]) =>
      cache.grantsFor(org.tenantId, org.organizationId, roles).then(grantsOf);

    expect(await grants(['sales', 'management'])).toEqual({
      'memo.read': 'department',
      'memo.create': 'own',
    });
    expect(await grants(['management', 'customer_user'])).toEqual({
      'memo.read': 'customer_org',
    });
    // Order of the roles does not matter.
    expect(await grants(['finance', 'sales', 'customer_user'])).toEqual({
      'memo.read': 'all',
      'memo.create': 'own',
      'audit.read': 'all',
    });
    expect(await grants(['customer_user', 'sales', 'finance'])).toEqual(
      await grants(['finance', 'sales', 'customer_user']),
    );
    expect(await grants([])).toEqual({});
  });

  it('reads the version at most once per org every 5 s, and reloads rows only when it changed', async () => {
    const org = await newOrg();
    await setRows(org, [['sales', 'memo.read', 'own']]);
    await otherInstance().invalidate(org.tenantId, org.organizationId);
    const cache = new RoleCache(db, clock);
    const queries = vi.spyOn(appPool, 'query');

    await cache.grantsFor(org.tenantId, org.organizationId, ['sales']);
    expect(queries).toHaveBeenCalledTimes(2); // cold: version, then rows

    queries.mockClear();
    now += VERSION_CHECK_TTL_MS - 1;
    await cache.grantsFor(org.tenantId, org.organizationId, ['sales']);
    expect(queries).not.toHaveBeenCalled(); // inside the window: memory only

    now += 1;
    await cache.grantsFor(org.tenantId, org.organizationId, ['sales']);
    expect(queries).toHaveBeenCalledTimes(1); // window passed, same version: one indexed read
  });

  it('picks up another instance invalidate only after the 5 s window, and its own at once', async () => {
    const org = await newOrg();
    await setRows(org, [['sales', 'memo.read', 'own']]);
    const cache = new RoleCache(db, clock);
    const memoRead = async (c: RoleCache) =>
      (await c.grantsFor(org.tenantId, org.organizationId, ['sales'])).get('memo.read');

    expect(await memoRead(cache)).toBe('own');

    // An admin widens the grant on another instance, which bumps the version.
    await setRows(org, [['sales', 'memo.read', 'all']]);
    await otherInstance().invalidate(org.tenantId, org.organizationId);

    now += VERSION_CHECK_TTL_MS - 100;
    expect(await memoRead(cache)).toBe('own'); // stale, but only within the window (R11)
    now += 200;
    expect(await memoRead(cache)).toBe('all');

    // An instance's own invalidate clears its entry, so it reloads without waiting.
    const local = new RoleCache(db, clock);
    const localAuthz = new AuthzService(db, local);
    expect(await memoRead(local)).toBe('all');
    await setRows(org, [['sales', 'memo.read', 'department']]);
    await localAuthz.invalidate(org.tenantId, org.organizationId);
    expect(await memoRead(local)).toBe('department');
  });

  it('does not let a load that started before forget() cache its rows', async () => {
    const org = await newOrg();
    await setRows(org, [['sales', 'memo.read', 'own']]);
    const cache = new RoleCache(db, clock);

    const early = cache.grantsFor(org.tenantId, org.organizationId, ['sales']);
    cache.forget(org.tenantId, org.organizationId); // runs before the early load's queries return
    expect((await early).get('memo.read')).toBe('own');

    // Change the rows without a version bump: only a cache that dropped the early load sees it.
    await setRows(org, [['sales', 'memo.read', 'all']]);
    const after = await cache.grantsFor(org.tenantId, org.organizationId, ['sales']);
    expect(after.get('memo.read')).toBe('all');
  });

  it('collapses concurrent cold loads of one org into one load', async () => {
    const org = await newOrg();
    const cache = new RoleCache(db, clock);
    const queries = vi.spyOn(appPool, 'query');

    await Promise.all(
      Array.from({ length: 10 }, () =>
        cache.grantsFor(org.tenantId, org.organizationId, ['sales']),
      ),
    );
    expect(queries).toHaveBeenCalledTimes(2);
  });

  it('builds grants from a warm cache in under 1 ms', async () => {
    const org = await newOrg();
    const cache = new RoleCache(db, clock);
    const roles: RoleKey[] = ['sales', 'finance', 'management', 'accountant'];
    await cache.grantsFor(org.tenantId, org.organizationId, roles); // warm; the clock stays frozen

    const runs = 1_000;
    const start = performance.now();
    for (let i = 0; i < runs; i++) {
      await cache.grantsFor(org.tenantId, org.organizationId, roles);
    }
    const perCallMs = (performance.now() - start) / runs;
    expect(perCallMs).toBeLessThan(1);
  });
});
