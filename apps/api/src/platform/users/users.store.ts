// Every SQL statement k-users runs, in one place.
// Serves the NFRs "every change is audited" (writes take the `tx` that withTx opened, so the audit
// trigger sees the actor) and "tenancy is never implicit" (every read names tenant and org).
//
// Raw `sql` with the P1-PLAN §4 column names on purpose: U1's drizzle file schema/identity.ts was a
// placeholder when this was written (columns since checked against 0002_identity_authz.sql). Swap to
// the drizzle tables at integration if you like; the UsersStore interface is what the rest of
// k-users (and its tests) depend on.
import type { RoleKey } from '@bos/contracts';
import { organizations } from '@bos/db';
import { Inject, Injectable } from '@nestjs/common';
import { type SQL, eq, sql } from 'drizzle-orm';

import { DB, type Db, type DbTransaction } from '../db/db.module';
import type { TxScope } from '../db/tx';
import type { MirroredStatus } from './zitadel-admin.client';

/** Either the pool-backed db or an open transaction: both can run a statement. */
export type Queryable = Db | DbTransaction;

export interface OrgRow {
  tenantId: string;
  organizationId: string;
  zitadelOrgId: string;
}

export interface UserRow {
  id: string;
  tenantId: string;
  organizationId: string;
  zitadelUserId: string;
  email: string | null;
  displayName: string | null;
  status: MirroredStatus;
  departmentId: string | null;
}

export interface UserFields {
  zitadelUserId: string;
  email: string | null;
  displayName: string | null;
  status: MirroredStatus;
}

export interface ListedUser extends UserRow {
  roles: RoleKey[];
}

/** One ZITADEL event id as the webhook delivered it; the triple is the dedupe key (§3). */
export interface ZitadelEventKey {
  instanceId: string;
  aggregateId: string;
  sequence: string;
  eventType: string | null;
}

export abstract class UsersStore {
  abstract orgByZitadelId(zitadelOrgId: string): Promise<OrgRow | null>;
  abstract orgById(organizationId: string): Promise<OrgRow | null>;
  abstract listOrgs(): Promise<OrgRow[]>;
  /** The scope withTx put on this transaction (bos.tenant_id / bos.organization_id). */
  abstract txScope(tx: DbTransaction): Promise<TxScope>;

  /** `lock` takes FOR UPDATE, so a hook sync and a reconcile of the same user run one after the other. */
  abstract findByZitadelId(
    q: Queryable,
    zitadelUserId: string,
    lock?: boolean,
  ): Promise<UserRow | null>;
  abstract findById(q: Queryable, scope: TxScope, userId: string): Promise<UserRow | null>;
  /** Inserts, or returns the existing row's id when a concurrent insert won. */
  abstract insertUser(tx: DbTransaction, scope: TxScope, u: UserFields): Promise<string>;
  abstract updateUser(
    tx: DbTransaction,
    userId: string,
    u: Omit<UserFields, 'zitadelUserId'>,
  ): Promise<void>;
  abstract notInactiveInOrg(q: Queryable, scope: TxScope): Promise<UserRow[]>;

  abstract rolesOf(q: Queryable, userId: string): Promise<RoleKey[]>;
  abstract replaceRoles(
    tx: DbTransaction,
    scope: TxScope,
    userId: string,
    roles: readonly RoleKey[],
  ): Promise<void>;
  /** Bumps the org's authz_version so every process drops its cached principals and grants. */
  abstract bumpAuthzVersion(tx: DbTransaction, scope: TxScope): Promise<void>;

  abstract userIdsWithRole(scope: TxScope, role: RoleKey): Promise<string[]>;
  /** The address of an `active` user only: notifications must not mail a deactivated or invited person. */
  abstract emailOf(userId: string): Promise<string | null>;
  abstract list(
    scope: TxScope,
    q: { limit: number; after?: string | undefined },
  ): Promise<ListedUser[]>;

  /** True when the event is new; false when this (instance, aggregate, sequence) was seen before. */
  abstract recordEvent(e: ZitadelEventKey): Promise<boolean>;
  abstract getCursor(name: string): Promise<string | null>;
  abstract setCursor(name: string, cursor: string): Promise<void>;
}

async function rows<T extends Record<string, unknown>>(q: Queryable, query: SQL): Promise<T[]> {
  // Db and DbTransaction share execute(); the cast only picks one of the two identical signatures.
  const result = await (q as Db).execute<T>(query);
  return result.rows as T[];
}

const USER_COLUMNS = sql`u.id, u.tenant_id AS "tenantId", u.organization_id AS "organizationId",
  u.zitadel_user_id AS "zitadelUserId", u.email, u.display_name AS "displayName", u.status,
  u.department_id AS "departmentId"`;

type UserRecord = UserRow & Record<string, unknown>;

@Injectable()
export class SqlUsersStore extends UsersStore {
  constructor(@Inject(DB) private readonly db: Db) {
    super();
  }

  async orgByZitadelId(zitadelOrgId: string): Promise<OrgRow | null> {
    const found = await this.db
      .select({
        tenantId: organizations.tenantId,
        organizationId: organizations.organizationId,
        zitadelOrgId: organizations.zitadelOrgId,
      })
      .from(organizations)
      .where(eq(organizations.zitadelOrgId, zitadelOrgId))
      .limit(1);
    return found[0] ?? null;
  }

  async orgById(organizationId: string): Promise<OrgRow | null> {
    const found = await this.db
      .select({
        tenantId: organizations.tenantId,
        organizationId: organizations.organizationId,
        zitadelOrgId: organizations.zitadelOrgId,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return found[0] ?? null;
  }

  listOrgs(): Promise<OrgRow[]> {
    return this.db
      .select({
        tenantId: organizations.tenantId,
        organizationId: organizations.organizationId,
        zitadelOrgId: organizations.zitadelOrgId,
      })
      .from(organizations);
  }

  async txScope(tx: DbTransaction): Promise<TxScope> {
    const [row] = await rows<{ tenantId: string; organizationId: string }>(
      tx,
      sql`SELECT current_setting('bos.tenant_id', true) AS "tenantId",
                 current_setting('bos.organization_id', true) AS "organizationId"`,
    );
    if (!row?.tenantId || !row.organizationId) {
      throw new Error('k-users write outside withTx: bos.tenant_id / bos.organization_id unset');
    }
    return row;
  }

  async findByZitadelId(
    q: Queryable,
    zitadelUserId: string,
    lock = false,
  ): Promise<UserRow | null> {
    const [row] = await rows<UserRecord>(
      q,
      sql`SELECT ${USER_COLUMNS} FROM app.users u WHERE u.zitadel_user_id = ${zitadelUserId}
          ${lock ? sql`FOR UPDATE` : sql``}`,
    );
    return row ?? null;
  }

  async findById(q: Queryable, scope: TxScope, userId: string): Promise<UserRow | null> {
    const [row] = await rows<UserRecord>(
      q,
      sql`SELECT ${USER_COLUMNS} FROM app.users u
          WHERE u.tenant_id = ${scope.tenantId} AND u.organization_id = ${scope.organizationId}
            AND u.id = ${userId}`,
    );
    return row ?? null;
  }

  async insertUser(tx: DbTransaction, scope: TxScope, u: UserFields): Promise<string> {
    const [inserted] = await rows<{ id: string }>(
      tx,
      sql`INSERT INTO app.users (tenant_id, organization_id, zitadel_user_id, email, display_name, status, last_synced_at)
          VALUES (${scope.tenantId}, ${scope.organizationId}, ${u.zitadelUserId}, ${u.email},
                  ${u.displayName}, ${u.status}, now())
          ON CONFLICT (zitadel_user_id) DO NOTHING
          RETURNING id`,
    );
    if (inserted) return inserted.id;
    const existing = await this.findByZitadelId(tx, u.zitadelUserId);
    if (!existing) throw new Error('app.users insert conflicted but no row was found');
    return existing.id;
  }

  async updateUser(
    tx: DbTransaction,
    userId: string,
    u: Omit<UserFields, 'zitadelUserId'>,
  ): Promise<void> {
    await tx.execute(
      sql`UPDATE app.users SET email = ${u.email}, display_name = ${u.displayName},
            status = ${u.status}, last_synced_at = now(), updated_at = now()
          WHERE id = ${userId}`,
    );
  }

  notInactiveInOrg(q: Queryable, scope: TxScope): Promise<UserRow[]> {
    return rows<UserRecord>(
      q,
      sql`SELECT ${USER_COLUMNS} FROM app.users u
          WHERE u.tenant_id = ${scope.tenantId} AND u.organization_id = ${scope.organizationId}
            AND u.status <> 'inactive'`,
    );
  }

  async rolesOf(q: Queryable, userId: string): Promise<RoleKey[]> {
    const found = await rows<{ role: RoleKey }>(
      q,
      sql`SELECT role_key AS role FROM app.user_roles WHERE user_id = ${userId} ORDER BY role_key`,
    );
    return found.map((r) => r.role);
  }

  async replaceRoles(
    tx: DbTransaction,
    scope: TxScope,
    userId: string,
    roles: readonly RoleKey[],
  ): Promise<void> {
    const keep = [...new Set(roles)];
    // Delete only what went away and insert only what is new, so the audit log shows the real diff.
    await tx.execute(
      keep.length === 0
        ? sql`DELETE FROM app.user_roles WHERE user_id = ${userId}`
        : sql`DELETE FROM app.user_roles WHERE user_id = ${userId}
                AND role_key NOT IN (${sql.join(
                  keep.map((r) => sql`${r}`),
                  sql`, `,
                )})`,
    );
    for (const role of keep) {
      await tx.execute(
        sql`INSERT INTO app.user_roles (tenant_id, organization_id, user_id, role_key, source)
            VALUES (${scope.tenantId}, ${scope.organizationId}, ${userId}, ${role}, 'zitadel')
            ON CONFLICT (user_id, role_key) DO NOTHING`,
      );
    }
  }

  async bumpAuthzVersion(tx: DbTransaction, scope: TxScope): Promise<void> {
    // authz_versions_tenant_org_unique (0002) makes this one race-free statement.
    await tx.execute(
      sql`INSERT INTO app.authz_versions (tenant_id, organization_id, version)
          VALUES (${scope.tenantId}, ${scope.organizationId}, 1)
          ON CONFLICT (tenant_id, organization_id)
          DO UPDATE SET version = app.authz_versions.version + 1, updated_at = now()`,
    );
  }

  async userIdsWithRole(scope: TxScope, role: RoleKey): Promise<string[]> {
    const found = await rows<{ id: string }>(
      this.db,
      sql`SELECT u.id FROM app.user_roles ur JOIN app.users u ON u.id = ur.user_id
          WHERE ur.tenant_id = ${scope.tenantId} AND ur.organization_id = ${scope.organizationId}
            AND ur.role_key = ${role} AND u.status = 'active'
          ORDER BY u.id`,
    );
    return found.map((r) => r.id);
  }

  async emailOf(userId: string): Promise<string | null> {
    const [row] = await rows<{ email: string | null }>(
      this.db,
      sql`SELECT email FROM app.users WHERE id = ${userId} AND status = 'active'`,
    );
    return row?.email ?? null;
  }

  async list(
    scope: TxScope,
    q: { limit: number; after?: string | undefined },
  ): Promise<ListedUser[]> {
    const found = await rows<UserRecord & { roles: RoleKey[] | null }>(
      this.db,
      sql`SELECT ${USER_COLUMNS},
            coalesce(array_agg(ur.role_key ORDER BY ur.role_key) FILTER (WHERE ur.role_key IS NOT NULL), '{}') AS roles
          FROM app.users u LEFT JOIN app.user_roles ur ON ur.user_id = u.id
          WHERE u.tenant_id = ${scope.tenantId} AND u.organization_id = ${scope.organizationId}
            ${q.after ? sql`AND u.id > ${q.after}` : sql``}
          GROUP BY u.id
          ORDER BY u.id
          LIMIT ${q.limit}`,
    );
    return found.map((r) => ({ ...r, roles: r.roles ?? [] }));
  }

  async recordEvent(e: ZitadelEventKey): Promise<boolean> {
    // ops.* has no tenancy and no audit trigger, so this is a plain statement, not withTx.
    const inserted = await rows<{ one: number }>(
      this.db,
      sql`INSERT INTO ops.zitadel_events (instance_id, aggregate_id, sequence, event_type, received_at)
          VALUES (${e.instanceId}, ${e.aggregateId}, ${e.sequence}, ${e.eventType}, now())
          ON CONFLICT (instance_id, aggregate_id, sequence) DO NOTHING
          RETURNING 1 AS one`,
    );
    return inserted.length > 0;
  }

  async getCursor(name: string): Promise<string | null> {
    const [row] = await rows<{ cursor: string | null }>(
      this.db,
      sql`SELECT cursor FROM ops.sync_cursors WHERE name = ${name}`,
    );
    return row?.cursor ?? null;
  }

  async setCursor(name: string, cursor: string): Promise<void> {
    await this.db.execute(
      sql`INSERT INTO ops.sync_cursors (name, cursor, updated_at) VALUES (${name}, ${cursor}, now())
          ON CONFLICT (name) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = EXCLUDED.updated_at`,
    );
  }
}
