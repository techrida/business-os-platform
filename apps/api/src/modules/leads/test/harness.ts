// Shared setup for the leads and activities integration tests (Testcontainers Postgres, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app. Faked: the request context, and authz.assert, which still runs
// the real pure can() on a fake principal, so the ResourceRef a service builds is what decides 403 or 404.
// Not a test file itself: vitest only runs *.test.ts.
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { createParty, createStaffUser, createTenantWithEntity, runMigrations } from '@bos/db';
import { ForbiddenException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';

import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import { systemActor, withTx } from '../../../platform/db/tx';

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

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const ADDRESS = JSON.stringify({ line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' });

export type EntityScope = { tenantId: string; organizationId: string };
export type TestUser = 'salesA' | 'salesB' | 'boss' | 'viewer';

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
  /** A customer party and its customers row, owned by `owner`. */
  seedCustomer: (owner?: string) => Promise<string>;
  /** Domain and row events the audit trail holds for one entity row, oldest first. */
  auditOf: (entityId: string) => Promise<{ action: string; entity_type: string }[]>;
  stop: () => Promise<void>;
}

const state: { acting: EntityScope; userId: string; grants: Map<Permission, Scope> } = {
  acting: { tenantId: '', organizationId: '' },
  userId: '',
  grants: new Map(),
};
const actorNow = () => ({
  kind: 'user' as const,
  id: state.userId,
  correlationId: 'test-corr',
});

export async function startHarness({ Pool, drizzle }: Driver): Promise<Harness> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16-alpine',
  ).start();
  const urlFor = (user: string, password: string, database: string) => {
    const url = new URL(container.getConnectionUri());
    url.username = user;
    url.password = password;
    url.pathname = `/${database}`;
    return url.toString();
  };
  const admin0 = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin0.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin0.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin0.query('CREATE DATABASE bos OWNER bos_owner');
  await admin0.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  // As infra/postgres/init-dbs.sh does: pg_trgm lives in public, so a missing grant shows up in the tests.
  await bosAdmin.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();
  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  const ownerPool = new Pool({ connectionString: urlFor('bos_owner', OWNER_PW, 'bos'), max: 2 });
  const appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 8 });
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
    users[key] = (await createStaffUser(pool, { ...scopeA, idpOrgId: tenant.idpOrgId })).userId;
  }
  state.acting = scopeA;
  state.userId = users.salesA;
  state.grants = new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS.sales)) as Map<Permission, Scope>;

  const principalNow = (): Principal => ({
    userId: state.userId,
    zitadelUserId: `z-${state.userId}`,
    ...state.acting,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: tenant.idpOrgId,
    roles: [],
    departmentId: null,
    status: 'active',
    grants: state.grants,
  });

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
    as: (user, role, entity = 'A') => {
      state.userId = users[user];
      state.grants = new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<
        Permission,
        Scope
      >;
      state.acting = entity === 'A' ? scopeA : scopeB;
    },
    seedCustomer: async (owner) => {
      const { partyId } = await createParty(pool, { tenantId, kind: 'customer' });
      await withTx(db, scopeA, systemActor('test'), (tx) =>
        tx.execute(
          sql`INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address, owner_user_id)
              VALUES (${partyId}, ${tenantId}, ${`CUS-${partyId.slice(0, 8)}`}, 'Acme Pvt. Ltd.', 'acme', ${ADDRESS}::jsonb, ${owner ?? null})`,
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
      await container.stop();
    },
  };
}
