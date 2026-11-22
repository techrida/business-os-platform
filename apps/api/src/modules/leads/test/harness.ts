// Shared setup for the leads and activities integration tests (Testcontainers Postgres, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app, the RoleCache (the tenant has no role rows, so it serves the
// code defaults and their level rows, as for a tenant never seeded) and NotifyService (bell and outbox rows; only
// the queue nudge is a no-op). Faked: the request context, and authz.assert, which still runs the real pure can() on
// a fake principal, so the ResourceRef a service builds is what decides 403 or 404.
// Two ways to act: `as(user, role)` gives a base user one role's staff-level defaults and no department, and
// `actAs(userId)` reads a member's roles, department and level from their membership and their grants from the
// RoleCache, the way the tenancy interceptor builds a request's principal.
// Not a test file itself: vitest only runs *.test.ts.
import { randomUUID } from 'node:crypto';

import {
  type AccessLevel,
  type AccessScope,
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  ROLE_KEYS,
  type RoleKey,
} from '@bos/contracts';
import {
  createDepartment,
  createParty,
  createStaffUser,
  createTenantWithEntity,
  userEntities,
  userRoles,
  users as usersTable,
} from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { ForbiddenException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';

import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import { RoleCache } from '../../../platform/authz/role-cache';
import type { UserDirectory } from '../../../platform/authz/user-directory';
import type { CoreConfig } from '../../../platform/config/config';
import type { Db } from '../../../platform/db/db.module';
import { systemActor, withTx } from '../../../platform/db/tx';
import { NotifyService } from '../../../platform/notify/notify.service';

/**
 * The driver comes in from the test file (a *.test.ts may import pg; this helper may not, see eslint.config.mjs
 * D32), so the helper names it only by shape.
 */
interface PoolLike {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
}
export interface Driver {
  Pool: new (config: { connectionString: string; max: number }) => PoolLike;
  drizzle: (options: { client: never }) => Db;
}
type AppPool = Parameters<typeof createParty>[0];

/** The workspace URL the harness's NotifyService renders email links with. */
export const WORKSPACE_URL = 'https://app.example.test';

export type EntityScope = { tenantId: string; organizationId: string };
export type TestUser = 'salesA' | 'salesB' | 'boss' | 'viewer';

/**
 * The role each base user holds in `user_roles`, so the directory (owner select, assignment rule, live grants)
 * agrees with the role their usual `as()` gives them.
 */
const BASE_ROLES: Readonly<Record<TestUser, RoleKey>> = {
  salesA: 'sales',
  salesB: 'sales',
  boss: 'founder',
  viewer: 'management',
};

/** A staff member of entity A for the access tests: the roles, department and level of their membership. */
export interface MemberSpec {
  roles: readonly RoleKey[];
  departmentId?: string | null;
  level?: AccessLevel;
  displayName?: string;
}

export interface Harness {
  db: Db;
  ownerPool: PoolLike;
  appPool: PoolLike;
  tenantId: string;
  /** Entity A is the acting entity of every request; entity B is another legal entity of the tenant. */
  scopeA: EntityScope;
  scopeB: EntityScope;
  users: Record<TestUser, string>;
  /** The fake of the request-store caller that LeadsCaller and ActivitiesCaller read. */
  caller: {
    current: () => { scope: EntityScope; actor: ReturnType<typeof actorNow>; principal: Principal };
  };
  /** The fake of AuthzService: the real can() on the fake principal. */
  authz: { assert: (action: Permission, ref?: Parameters<typeof can>[2]) => void };
  /** Acts as `userId` holding the default grants of `role`, in entity `entity` (A unless named). */
  as: (user: TestUser, role: RoleKey, entity?: 'A' | 'B') => void;
  /**
   * Acts as `userId` the way a request does: roles narrowed by their membership in the entity (A unless named), its
   * department and level, and the grants the RoleCache gives that.
   */
  actAs: (userId: string, entity?: 'A' | 'B') => Promise<void>;
  /** The real RoleCache over this database: the grants `actAs` and the assignment rule read. */
  roleCache: RoleCache;
  /** The real NotifyService over this database; its queue nudge does nothing. */
  notify: NotifyService;
  /** A new department of entity A; its id. */
  department: (name: string) => Promise<string>;
  /** A new active staff member of entity A with these roles, department and level; their user id. */
  member: (spec: MemberSpec) => Promise<string>;
  /** A customer party and its customers row, owned by `owner`. */
  seedCustomer: (owner?: string) => Promise<string>;
  /** Domain and row events the audit trail holds for one entity row, oldest first. */
  auditOf: (entityId: string) => Promise<{ action: string; entity_type: string }[]>;
  stop: () => Promise<void>;
}

const state: {
  acting: EntityScope;
  userId: string;
  roles: readonly RoleKey[];
  departmentId: string | null;
  level: AccessLevel;
  grants: ReadonlyMap<Permission, AccessScope>;
} = {
  acting: { tenantId: '', organizationId: '' },
  userId: '',
  roles: [],
  departmentId: null,
  level: 'staff',
  grants: new Map(),
};
const actorNow = () => ({
  kind: 'user' as const,
  id: state.userId,
  correlationId: 'test-corr',
});

const ROLE_KEY_SET: ReadonlySet<string> = new Set(ROLE_KEYS);

/** One role's code defaults at staff level: the grants `as()` gives. */
const defaultsOf = (role: RoleKey): ReadonlyMap<Permission, AccessScope> =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role]) as [Permission, AccessScope][]);

export async function startHarness(driver: Driver): Promise<Harness> {
  // A copy of the migrated template: roles, public-schema grants and default privileges as
  // infra/postgres/init-dbs.sh sets them (pg_trgm lives in public, so a missing grant shows up in the tests).
  const testDb = await createTestDatabase();
  const ownerPool = new driver.Pool({ connectionString: testDb.ownerUrl, max: 2 });
  const appPool = new driver.Pool({ connectionString: testDb.appUrl, max: 8 });
  try {
    return await buildHarness(driver, testDb, ownerPool, appPool);
  } catch (error) {
    // The caller never receives a handle on a failed start, so nothing else would clean up.
    await appPool.end();
    await ownerPool.end();
    await testDb.drop();
    throw error;
  }
}

async function buildHarness(
  { drizzle }: Driver,
  testDb: TestDatabase,
  ownerPool: InstanceType<Driver['Pool']>,
  appPool: InstanceType<Driver['Pool']>,
): Promise<Harness> {
  const db: Db = drizzle({ client: appPool as never });
  const pool = appPool as unknown as AppPool;

  const tenant = await createTenantWithEntity(pool);
  const tenantId = tenant.tenantId;
  const scopeA: EntityScope = { tenantId, organizationId: tenant.organizationId };
  const entityB = randomUUID();
  // The audit trigger refuses a write without bos.actor_id, so the second entity is inserted through withTx
  // (audited under entity A, the acting entity), never with a bare pool query.
  await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
          VALUES (${entityB}, ${tenantId}, ${entityB}, ${`E-${entityB}`}, ${`E-${entityB}`}, ${`E-${entityB}`}, false)`,
    ),
  );
  const scopeB: EntityScope = { tenantId, organizationId: entityB };

  const users = { salesA: '', salesB: '', boss: '', viewer: '' } as Record<TestUser, string>;
  for (const key of Object.keys(users) as TestUser[]) {
    users[key] = (
      await createStaffUser(pool, {
        ...scopeA,
        idpOrgId: tenant.idpOrgId,
        roleKeys: [BASE_ROLES[key]],
      })
    ).userId;
  }

  const as = (user: TestUser, role: RoleKey, entity: 'A' | 'B' = 'A') => {
    state.userId = users[user];
    state.roles = [role];
    state.departmentId = null;
    state.level = 'staff';
    state.grants = defaultsOf(role);
    state.acting = entity === 'A' ? scopeA : scopeB;
  };
  as('salesA', 'sales');

  const principalNow = (): Principal => ({
    userId: state.userId,
    zitadelUserId: `z-${state.userId}`,
    ...state.acting,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: tenant.idpOrgId,
    roles: state.roles,
    departmentId: state.departmentId,
    level: state.level,
    status: 'active',
    grants: state.grants,
  });

  const roleCache = new RoleCache(db);
  const directory = {
    emailOf: async (userId: string) => {
      const [row] = await db
        .select({ email: usersTable.email })
        .from(usersTable)
        .where(eq(usersTable.id, userId));
      return row?.email ?? null;
    },
  } as unknown as UserDirectory;
  const notify = new NotifyService(
    db,
    { WORKSPACE_PUBLIC_URL: WORKSPACE_URL } as CoreConfig,
    directory,
    { add: () => Promise.resolve() } as unknown as Queue,
  );

  const member = async (spec: MemberSpec): Promise<string> => {
    const { userId } = await createStaffUser(pool, {
      ...scopeA,
      idpOrgId: tenant.idpOrgId,
      roleKeys: spec.roles,
      ...(spec.departmentId === undefined || spec.departmentId === null
        ? {}
        : { departmentId: spec.departmentId }),
    });
    const level = spec.level ?? 'staff';
    const { displayName } = spec;
    if (level !== 'staff' || displayName !== undefined) {
      await withTx(db, scopeA, systemActor('test'), async (tx) => {
        // A head also becomes the department's head: migration 0079 keeps both sides in step.
        if (level !== 'staff') {
          await tx
            .update(userEntities)
            .set({ level })
            .where(
              and(
                eq(userEntities.userId, userId),
                eq(userEntities.organizationId, scopeA.organizationId),
              ),
            );
        }
        if (displayName !== undefined) {
          await tx.update(usersTable).set({ displayName }).where(eq(usersTable.id, userId));
        }
      });
    }
    return userId;
  };

  const actAs = async (userId: string, entity: 'A' | 'B' = 'A'): Promise<void> => {
    const acting = entity === 'A' ? scopeA : scopeB;
    const [membership] = await db
      .select({
        roleKeys: userEntities.roleKeys,
        departmentId: userEntities.departmentId,
        level: userEntities.level,
      })
      .from(userEntities)
      .where(
        and(
          eq(userEntities.tenantId, tenantId),
          eq(userEntities.organizationId, acting.organizationId),
          eq(userEntities.userId, userId),
        ),
      );
    if (membership === undefined) throw new Error(`actAs: ${userId} has no membership there`);
    const held = await db
      .select({ roleKey: userRoles.roleKey })
      .from(userRoles)
      .where(and(eq(userRoles.tenantId, tenantId), eq(userRoles.userId, userId)));
    const roles = held
      .map((r) => r.roleKey)
      .filter((role): role is RoleKey => ROLE_KEY_SET.has(role))
      .filter((role) => membership.roleKeys === null || membership.roleKeys.includes(role));
    state.userId = userId;
    state.roles = roles;
    state.departmentId = membership.departmentId;
    state.level = membership.level;
    state.grants = await roleCache.grantsFor(
      tenantId,
      acting.organizationId,
      roles,
      membership.level,
    );
    state.acting = acting;
  };

  return {
    db,
    ownerPool,
    appPool,
    tenantId,
    scopeA,
    scopeB,
    users,
    caller: {
      current: () => ({ scope: state.acting, actor: actorNow(), principal: principalNow() }),
    },
    authz: {
      assert: (action, ref) => {
        const d = can(principalNow(), action, ref);
        if (!d.allowed) {
          throw new ForbiddenException({
            code: 'forbidden',
            message: 'Forbidden',
            reason: d.reason,
          });
        }
      },
    },
    as,
    actAs,
    roleCache,
    notify,
    department: async (name) => (await createDepartment(pool, { ...scopeA, name })).departmentId,
    member,
    seedCustomer: async (owner) => {
      const { partyId } = await createParty(pool, { tenantId, kind: 'customer' });
      await withTx(db, scopeA, systemActor('test'), (tx) =>
        tx.execute(
          sql`INSERT INTO app.customers
                (id, tenant_id, number, legal_name, name_norm, country, address_line, address_city, owner_user_id)
              VALUES (${partyId}, ${tenantId}, ${`CUS-${partyId.slice(0, 8)}`}, 'Acme Pvt. Ltd.', 'acme', 'NP',
                '1 Durbar Marg', 'Kathmandu', ${owner ?? null})`,
        ),
      );
      return partyId;
    },
    auditOf: async (entityId) => {
      const { rows } = await ownerPool.query(
        `SELECT action, entity_type FROM audit.audit_events
          WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`,
        [tenantId, entityId],
      );
      return rows as { action: string; entity_type: string }[];
    },
    stop: async () => {
      await appPool.end();
      await ownerPool.end();
      await testDb.drop();
    },
  };
}
