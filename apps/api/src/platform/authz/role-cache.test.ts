// Integration test for RoleCache and AuthzService.invalidate: a real postgres:16-alpine started by
// Testcontainers (needs Docker). Run with:
//   pnpm --filter @bos/api exec vitest run src/platform/authz/role-cache.test.ts
//
// It proves the R11 promises (P1 plan §10): the defaults cover a tenant that was never seeded, rows
// replace them, the widest scope wins, the version is read at most once per tenant every 5 s, and a
// bump from another api instance is picked up once that window passes. And the level grants (D50,
// D51): a level row only widens a base grant, the stored rows win once the tenant has any or Access
// Settings marked them materialized, and zero grant rows always mean the defaults. Role rows are tenant policy
// (ADR 0027 §7), so every entity of a tenant shares one cache entry. Setup is the same as
// settings/numbering.service.test.ts: roles and default privileges as in init-dbs.sh, migrate as
// bos_owner, then work as bos_app.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  type AccessLevel,
  type AccessScope,
  DEFAULT_ROLE_PERMISSION_LEVELS,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  type Permission,
  ROLE_KEYS,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  accessRevisions,
  createTenantWithEntity,
  organizations,
  rolePermissionLevels,
  rolePermissions,
  runMigrations,
} from '@bos/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
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

/** A fresh tenant and its default entity, so every test starts with no rows and no version. */
async function newOrg(): Promise<TxScope> {
  const { tenantId, organizationId } = await createTenantWithEntity(appPool);
  return { tenantId, organizationId };
}

/** A second, non-default legal entity in the tenant of `scope`. */
async function secondEntity(scope: TxScope): Promise<TxScope> {
  const organizationId = randomUUID();
  const second = { tenantId: scope.tenantId, organizationId };
  const code = `E2-${organizationId.slice(0, 8)}`;
  await withTx(db, second, systemActor('test'), async (tx) => {
    await tx.insert(organizations).values({
      id: organizationId,
      tenantId: scope.tenantId,
      organizationId,
      code,
      name: code,
      legalName: code,
    });
  });
  return second;
}

type Row = [role: RoleKey, permission: Permission, scope: Scope];

/** Replaces the tenant's role_permissions with `rows`, through withTx like every app write. */
async function setRows(scope: TxScope, rows: readonly Row[]): Promise<void> {
  await withTx(db, scope, systemActor('test'), async (tx) => {
    await tx.delete(rolePermissions).where(eq(rolePermissions.tenantId, scope.tenantId));
    if (rows.length > 0) {
      await tx.insert(rolePermissions).values(
        rows.map(([roleKey, permission, s]) => ({
          tenantId: scope.tenantId,
          roleKey,
          permission,
          scope: s,
        })),
      );
    }
  });
}

type LevelRow = [role: RoleKey, permission: Permission, minLevel: 'manager' | 'head', scope: Scope];

/** Replaces the tenant's role_permission_levels with `rows`. */
async function setLevelRows(scope: TxScope, rows: readonly LevelRow[]): Promise<void> {
  await withTx(db, scope, systemActor('test'), async (tx) => {
    await tx.delete(rolePermissionLevels).where(eq(rolePermissionLevels.tenantId, scope.tenantId));
    if (rows.length > 0) {
      await tx.insert(rolePermissionLevels).values(
        rows.map(([roleKey, permission, minLevel, s]) => ({
          tenantId: scope.tenantId,
          roleKey,
          permission,
          minLevel,
          scope: s,
        })),
      );
    }
  });
}

/** What Access Settings records when it first copies the default level rules into the table. */
async function markLevelRulesMaterialized(scope: TxScope): Promise<void> {
  await withTx(db, scope, systemActor('test'), async (tx) => {
    await tx
      .insert(accessRevisions)
      .values({ tenantId: scope.tenantId, revision: 1, levelRulesMaterialized: true });
  });
}

const grantsOf = (map: ReadonlyMap<Permission, AccessScope>): Record<string, AccessScope> =>
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
  it('falls back to DEFAULT_ROLE_PERMISSIONS when the tenant has no role_permissions rows', async () => {
    const org = await newOrg();
    const cache = new RoleCache(db, clock);

    const sales = await cache.grantsFor(org.tenantId, org.organizationId, ['sales']);
    expect(grantsOf(sales)).toEqual(DEFAULT_ROLE_PERMISSIONS.sales);

    const founder = await cache.grantsFor(org.tenantId, org.organizationId, ['founder']);
    expect(founder.size).toBe(PERMISSIONS.length);
    expect([...founder.values()].every((s) => s === 'all')).toBe(true);
  });

  it('uses the rows instead of the defaults once the tenant has any', async () => {
    const org = await newOrg();
    await setRows(org, [['sales', 'memo.read', 'department']]);
    const cache = new RoleCache(db, clock);

    const sales = await cache.grantsFor(org.tenantId, org.organizationId, ['sales']);
    expect(grantsOf(sales)).toEqual({ 'memo.read': 'department' });
    // A role with no rows in a tenant that has rows grants nothing: the table is the whole truth.
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

  it('reads the version at most once per tenant every 5 s, and reloads rows only when it changed', async () => {
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

  it('changes the epoch at once on its own invalidate, and after the window on another instance', async () => {
    const org = await newOrg();
    const cache = new RoleCache(db, clock);
    const authz = new AuthzService(db, cache);
    const first = await cache.epoch(org.tenantId);
    expect(await cache.epoch(org.tenantId)).toBe(first); // nothing changed: same epoch

    await authz.invalidate(org.tenantId, org.organizationId);
    const second = await cache.epoch(org.tenantId);
    expect(second).not.toBe(first); // own invalidate: the next request sees a new epoch

    await otherInstance().invalidate(org.tenantId, org.organizationId);
    expect(await cache.epoch(org.tenantId)).toBe(second); // inside the 5 s window
    now += VERSION_CHECK_TTL_MS + 1;
    expect(await cache.epoch(org.tenantId)).not.toBe(second);
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

  it('shares one entry across the entities of a tenant, and one invalidate reloads them all', async () => {
    const org = await newOrg();
    const other = await secondEntity(org);
    await setRows(org, [['sales', 'memo.read', 'own']]);
    const cache = new RoleCache(db, clock);
    const memoRead = async (c: RoleCache, scope: TxScope) =>
      (await c.grantsFor(scope.tenantId, scope.organizationId, ['sales'])).get('memo.read');

    expect(await memoRead(cache, org)).toBe('own');
    const queries = vi.spyOn(appPool, 'query');
    // The other entity reads the same tenant rows from memory: no version check, no row load.
    expect(await memoRead(cache, other)).toBe('own');
    expect(queries).not.toHaveBeenCalled();

    // An invalidate made while acting for one entity reloads the grants of every entity.
    queries.mockRestore();
    await setRows(org, [['sales', 'memo.read', 'all']]);
    await new AuthzService(db, cache).invalidate(other.tenantId, other.organizationId);
    expect(await memoRead(cache, org)).toBe('all');
    expect(await memoRead(cache, other)).toBe('all');
  });

  it('keeps tenants apart: the rows of one tenant never reach another', async () => {
    const a = await newOrg();
    const b = await newOrg();
    await setRows(a, [['sales', 'memo.read', 'all']]);
    const cache = new RoleCache(db, clock);

    const aGrants = await cache.grantsFor(a.tenantId, a.organizationId, ['sales']);
    expect(aGrants.get('memo.read')).toBe('all');
    // Tenant b has no rows, so it gets the defaults, not tenant a's widened grant.
    const bGrants = await cache.grantsFor(b.tenantId, b.organizationId, ['sales']);
    expect(grantsOf(bGrants)).toEqual(DEFAULT_ROLE_PERMISSIONS.sales);
  });

  it('collapses concurrent cold loads of one tenant into one load', async () => {
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

describe('RoleCache.current, the request path (U20a2-Q10)', () => {
  it('refuses a grant another instance removed on the very next call, without waiting for the window', async () => {
    const org = await newOrg();
    await setRows(org, [
      ['sales', 'memo.read', 'own'],
      ['sales', 'memo.create', 'own'],
    ]);
    const cache = new RoleCache(db, clock);
    const salesGrants = async () => (await cache.current(org.tenantId)).grantsFor(['sales']);

    expect((await salesGrants()).get('memo.create')).toBe('own');

    // An access save on another instance removes the grant and bumps the version. The clock does not move.
    await setRows(org, [['sales', 'memo.read', 'own']]);
    await otherInstance().invalidate(org.tenantId, org.organizationId);

    const after = await salesGrants();
    expect(after.has('memo.create')).toBe(false);
    expect(after.get('memo.read')).toBe('own');
  });

  it('moves its epoch on the very next call after another instance bumped the version', async () => {
    const org = await newOrg();
    const cache = new RoleCache(db, clock);
    const first = (await cache.current(org.tenantId)).epoch;
    expect((await cache.current(org.tenantId)).epoch).toBe(first);
    expect(await cache.epoch(org.tenantId)).toBe(first); // the same value the user cache was keyed to

    await otherInstance().invalidate(org.tenantId, org.organizationId);
    expect((await cache.current(org.tenantId)).epoch).not.toBe(first);
  });

  it('makes one indexed version read per call while nothing changed, and reloads rows only on a bump', async () => {
    const org = await newOrg();
    await setRows(org, [['sales', 'memo.read', 'own']]);
    await otherInstance().invalidate(org.tenantId, org.organizationId);
    const cache = new RoleCache(db, clock);
    await cache.current(org.tenantId); // cold: version, then rows

    const queries = vi.spyOn(appPool, 'query');
    for (let i = 0; i < 3; i += 1) {
      expect((await cache.current(org.tenantId)).grantsFor(['sales']).get('memo.read')).toBe('own');
    }
    expect(queries).toHaveBeenCalledTimes(3); // the version only, no row load

    await setRows(org, [['sales', 'memo.read', 'all']]);
    await otherInstance().invalidate(org.tenantId, org.organizationId);
    queries.mockClear(); // the writes above went through the same pool
    expect((await cache.current(org.tenantId)).grantsFor(['sales']).get('memo.read')).toBe('all');
    expect(queries).toHaveBeenCalledTimes(2); // version, then the one row statement
  });

  it('confirms the entry for the other callers too, so grantsFor in the same request reads no database', async () => {
    const org = await newOrg();
    const cache = new RoleCache(db, clock);
    await cache.current(org.tenantId);
    now += VERSION_CHECK_TTL_MS + 1;
    await cache.current(org.tenantId);

    const queries = vi.spyOn(appPool, 'query');
    await cache.grantsFor(org.tenantId, org.organizationId, ['sales']);
    expect(queries).not.toHaveBeenCalled();
  });

  it('fails when the version cannot be read, rather than serving the cached grants', async () => {
    const org = await newOrg();
    const cache = new RoleCache(db, clock);
    await cache.current(org.tenantId);

    vi.spyOn(appPool, 'query').mockImplementation(() => {
      throw new Error('database down');
    });
    await expect(cache.current(org.tenantId)).rejects.toThrow();
  });
});

describe('RoleCache: a tenant without grant rows and rolesGranting', () => {
  /** Every role at every level on a fresh, never-seeded tenant: the code defaults as the cache builds them. */
  async function codeDefaults(
    cache: RoleCache,
  ): Promise<Record<string, Record<string, AccessScope>>> {
    const fresh = await newOrg();
    const want: Record<string, Record<string, AccessScope>> = {};
    for (const role of ROLE_KEYS)
      for (const level of ['staff', 'manager', 'head'] as const) {
        const got = await cache.grantsFor(fresh.tenantId, fresh.organizationId, [role], level);
        want[`${role} ${level}`] = grantsOf(got);
      }
    return want;
  }

  async function expectCodeDefaults(cache: RoleCache, org: TxScope): Promise<void> {
    const want = await codeDefaults(cache);
    for (const role of ROLE_KEYS)
      for (const level of ['staff', 'manager', 'head'] as const) {
        const got = await cache.grantsFor(org.tenantId, org.organizationId, [role], level);
        expect(grantsOf(got), `${role} ${level}`).toEqual(want[`${role} ${level}`]);
      }
  }

  it('keeps the code defaults for every role when a version row exists but no grant rows were ever written', async () => {
    const org = await newOrg();
    // A user or role write bumps the version without materialising any grants.
    await otherInstance().invalidate(org.tenantId, org.organizationId);
    const [versionRow] = (
      await appPool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM app.authz_versions WHERE tenant_id = $1',
        [org.tenantId],
      )
    ).rows;
    expect(versionRow?.n).toBe('1');

    const cache = new RoleCache(db, clock);
    const founder = await cache.grantsFor(org.tenantId, org.organizationId, ['founder']);
    expect(grantsOf(founder)).toEqual(DEFAULT_ROLE_PERMISSIONS.founder);
    expect(founder.get('admin.settings.write')).toBe('all');
    await expectCodeDefaults(cache, org);
  });

  it('falls back to the code defaults when every grant row of a seeded tenant is gone, never an empty policy', async () => {
    const org = await newOrg();
    await setRows(org, [['founder', 'memo.read', 'all']]);
    await otherInstance().invalidate(org.tenantId, org.organizationId);
    await setRows(org, []);
    await otherInstance().invalidate(org.tenantId, org.organizationId);

    const cache = new RoleCache(db, clock);
    expect(grantsOf(await cache.grantsFor(org.tenantId, org.organizationId, ['founder']))).toEqual(
      DEFAULT_ROLE_PERMISSIONS.founder,
    );
    await expectCodeDefaults(cache, org);
    const defaultHolders = ROLE_KEYS.filter(
      (role) => DEFAULT_ROLE_PERMISSIONS[role]['memo.read'] !== undefined,
    ).sort();
    expect(await cache.rolesGranting(org.tenantId, 'memo.read')).toEqual(defaultHolders);
  });

  it('gives a tenant that was never seeded (no rows, no version) both default tables', async () => {
    const org = await newOrg();
    const cache = new RoleCache(db, clock);
    const sample = DEFAULT_ROLE_PERMISSION_LEVELS.sales.find(
      (r) => r.permission === 'crm.lead.read',
    );
    expect(sample).toBeDefined();
    expect(DEFAULT_ROLE_PERMISSIONS.sales['crm.lead.read']).toBeDefined();

    const staff = await cache.grantsFor(org.tenantId, org.organizationId, ['sales'], 'staff');
    expect(grantsOf(staff)).toEqual(DEFAULT_ROLE_PERMISSIONS.sales);
    const senior = await cache.grantsFor(
      org.tenantId,
      org.organizationId,
      ['sales'],
      sample?.minLevel ?? 'head',
    );
    expect(senior.get('crm.lead.read')).toBe(sample?.scope);
  });

  it('gives a never-seeded tenant, for every role, level and permission, the K3 scope of the code defaults', async () => {
    const org = await newOrg();
    const cache = new RoleCache(db, clock);
    const levelRank = { staff: 0, manager: 1, head: 2 } as const;
    const scopeRank = { assigned: 0, own: 1, department: 2, customer_org: 3, all: 4 } as const;
    for (const role of ROLE_KEYS)
      for (const level of ['staff', 'manager', 'head'] as const) {
        const want: Record<string, AccessScope> = {};
        for (const [permission, base] of Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) {
          if (base === undefined) continue;
          // Widest of the base and the most senior default row at or below the level.
          const senior = DEFAULT_ROLE_PERMISSION_LEVELS[role]
            .filter((r) => r.permission === permission && levelRank[r.minLevel] <= levelRank[level])
            .sort((a, b) => levelRank[b.minLevel] - levelRank[a.minLevel])[0];
          want[permission] =
            senior !== undefined && scopeRank[senior.scope] > scopeRank[base] ? senior.scope : base;
        }
        const got = await cache.grantsFor(org.tenantId, org.organizationId, [role], level);
        expect(grantsOf(got), `${role} ${level}`).toEqual(want);
      }
  });

  it('lists the roles whose live rows hold a permission, sorted, and the defaults only when never seeded', async () => {
    const fresh = await newOrg();
    const cache = new RoleCache(db, clock);
    const defaultHolders = ROLE_KEYS.filter(
      (role) => DEFAULT_ROLE_PERMISSIONS[role]['admin.roles.write'] !== undefined,
    ).sort();
    expect(defaultHolders.length).toBeGreaterThan(0);
    expect(await cache.rolesGranting(fresh.tenantId, 'admin.roles.write')).toEqual(defaultHolders);

    const org = await newOrg();
    // A Founder-made grant for management counts at any scope; a role key this build does not know never does.
    await setRows(org, [
      ['sales', 'admin.roles.write', 'own'],
      ['management', 'admin.roles.write', 'all'],
      ['founder', 'memo.read', 'all'],
    ]);
    await withTx(db, org, systemActor('test'), async (tx) => {
      await tx.insert(rolePermissions).values({
        tenantId: org.tenantId,
        roleKey: 'retired_role',
        permission: 'admin.roles.write',
        scope: 'all',
      });
    });
    await otherInstance().invalidate(org.tenantId, org.organizationId);
    expect(await cache.rolesGranting(org.tenantId, 'admin.roles.write')).toEqual([
      'management',
      'sales',
    ]);
  });
});

describe('RoleCache: level grants', () => {
  const at = (cache: RoleCache, org: TxScope, roles: RoleKey[], level: AccessLevel) =>
    cache.grantsFor(org.tenantId, org.organizationId, roles, level).then(grantsOf);

  it("widens a base grant from the row's level up, and never narrows or creates one", async () => {
    const org = await newOrg();
    await setRows(org, [
      ['sales', 'crm.lead.read', 'own'],
      ['sales', 'crm.lead.write', 'own'],
      ['sales', 'quotation.read', 'all'],
    ]);
    await setLevelRows(org, [
      ['sales', 'crm.lead.read', 'manager', 'department'],
      // Narrower than the base `all`: ignored, a level never narrows.
      ['sales', 'quotation.read', 'head', 'department'],
      // No base grant for it: ignored, a level never creates access.
      ['sales', 'procurement.pr.read', 'head', 'department'],
    ]);
    await otherInstance().invalidate(org.tenantId, org.organizationId);
    const cache = new RoleCache(db, clock);

    expect(await at(cache, org, ['sales'], 'staff')).toEqual({
      'crm.lead.read': 'own',
      'crm.lead.write': 'own',
      'quotation.read': 'all',
    });
    // A head inherits the manager row: every row at or below the member's level applies.
    for (const level of ['manager', 'head'] as const) {
      expect(await at(cache, org, ['sales'], level)).toEqual({
        'crm.lead.read': 'department',
        'crm.lead.write': 'own',
        'quotation.read': 'all',
      });
    }
  });

  it('takes the most senior row at or below the level, as K3 and Check a person do', async () => {
    const org = await newOrg();
    await setRows(org, [['sales', 'crm.lead.read', 'own']]);
    await setLevelRows(org, [
      ['sales', 'crm.lead.read', 'manager', 'all'],
      ['sales', 'crm.lead.read', 'head', 'department'],
    ]);
    await otherInstance().invalidate(org.tenantId, org.organizationId);
    const cache = new RoleCache(db, clock);

    expect((await at(cache, org, ['sales'], 'manager'))['crm.lead.read']).toBe('all');
    expect((await at(cache, org, ['sales'], 'head'))['crm.lead.read']).toBe('department');
  });

  it('merges per role at the level, then across roles by the widest scope', async () => {
    const org = await newOrg();
    await setRows(org, [
      ['sales', 'crm.lead.read', 'own'],
      ['finance', 'invoice.read', 'own'],
    ]);
    // `assigned` is a stored scope since 0082; the drizzle enum predates it, so write it as SQL.
    await withTx(db, org, systemActor('test'), async (tx) => {
      await tx.execute(sql`INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope)
        VALUES (${org.tenantId}, 'finance', 'crm.lead.read', 'assigned')`);
    });
    await setLevelRows(org, [
      ['finance', 'invoice.read', 'head', 'department'],
      ['sales', 'crm.lead.read', 'head', 'department'],
    ]);
    await otherInstance().invalidate(org.tenantId, org.organizationId);
    const cache = new RoleCache(db, clock);

    expect(await at(cache, org, ['finance'], 'staff')).toEqual({
      'crm.lead.read': 'assigned',
      'invoice.read': 'own',
    });
    // `assigned` ranks below `own`, so the wider sales grant wins, in either role order.
    expect(await at(cache, org, ['finance', 'sales'], 'staff')).toEqual({
      'crm.lead.read': 'own',
      'invoice.read': 'own',
    });
    expect(await at(cache, org, ['sales', 'finance'], 'staff')).toEqual({
      'crm.lead.read': 'own',
      'invoice.read': 'own',
    });
    expect(await at(cache, org, ['sales', 'finance'], 'head')).toEqual({
      'crm.lead.read': 'department',
      'invoice.read': 'department',
    });
  });

  it('uses the code default level rows while the tenant has none of its own and nothing was materialized', async () => {
    const sample = DEFAULT_ROLE_PERMISSION_LEVELS.sales.find(
      (r) => r.permission === 'crm.lead.read',
    );
    expect(sample).toBeDefined();
    const org = await newOrg();
    await setRows(org, [['sales', 'crm.lead.read', 'own']]);
    await otherInstance().invalidate(org.tenantId, org.organizationId);
    const cache = new RoleCache(db, clock);

    expect((await at(cache, org, ['sales'], 'staff'))['crm.lead.read']).toBe('own');
    expect((await at(cache, org, ['sales'], 'head'))['crm.lead.read']).toBe(sample?.scope);
  });

  it('uses the stored rows once there are any, even before the materialized flag (migration 0088)', async () => {
    const org = await newOrg();
    await setRows(org, [['sales', 'crm.lead.read', 'own']]);
    // Only heads: the Founder turned the manager switch off, which the defaults have on.
    await setLevelRows(org, [['sales', 'crm.lead.read', 'head', 'department']]);
    await otherInstance().invalidate(org.tenantId, org.organizationId);
    const cache = new RoleCache(db, clock);

    expect((await at(cache, org, ['sales'], 'manager'))['crm.lead.read']).toBe('own');
    expect((await at(cache, org, ['sales'], 'head'))['crm.lead.read']).toBe('department');
  });

  it('gives no level grant when the rules were materialized and every row was then switched off', async () => {
    const org = await newOrg();
    await setRows(org, [['sales', 'crm.lead.read', 'own']]);
    await markLevelRulesMaterialized(org);
    await otherInstance().invalidate(org.tenantId, org.organizationId);
    const cache = new RoleCache(db, clock);

    for (const level of ['staff', 'manager', 'head'] as const) {
      expect((await at(cache, org, ['sales'], level))['crm.lead.read']).toBe('own');
    }
  });

  it('reloads level rows with the version, like the base rows', async () => {
    const org = await newOrg();
    await setRows(org, [['sales', 'crm.lead.read', 'own']]);
    await setLevelRows(org, [['sales', 'crm.lead.read', 'manager', 'department']]);
    await otherInstance().invalidate(org.tenantId, org.organizationId);
    const cache = new RoleCache(db, clock);
    const managerReads = async () => (await at(cache, org, ['sales'], 'manager'))['crm.lead.read'];
    expect(await managerReads()).toBe('department');

    await setLevelRows(org, [['sales', 'crm.lead.read', 'head', 'department']]);
    await otherInstance().invalidate(org.tenantId, org.organizationId);
    expect(await managerReads()).toBe('department'); // inside the 5 s window
    now += VERSION_CHECK_TTL_MS + 1;
    expect(await managerReads()).toBe('own');
  });

  it('still loads a tenant in two queries (version, then one statement for base, level and flag)', async () => {
    const org = await newOrg();
    await setRows(org, [['sales', 'crm.lead.read', 'own']]);
    await setLevelRows(org, [['sales', 'crm.lead.read', 'head', 'department']]);
    await markLevelRulesMaterialized(org);
    await otherInstance().invalidate(org.tenantId, org.organizationId);
    const cache = new RoleCache(db, clock);
    const queries = vi.spyOn(appPool, 'query');

    expect(
      (await cache.grantsFor(org.tenantId, org.organizationId, ['sales'], 'head')).get(
        'crm.lead.read',
      ),
    ).toBe('department');
    expect(queries).toHaveBeenCalledTimes(2);
  });
});
