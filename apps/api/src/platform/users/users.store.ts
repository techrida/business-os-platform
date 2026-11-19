// Every SQL statement k-users runs, in one place.
// Serves the NFRs "every change is audited" (writes take the `tx` that withTx opened, so the audit
// trigger sees the actor) and "tenancy is never implicit" (every read names tenant and org).
//
// Raw `sql` with the P1-PLAN §4 column names on purpose: U1's drizzle file schema/identity.ts was a
// placeholder when this was written (columns since checked against 0002_identity_authz.sql). Swap to
// the drizzle tables at integration if you like; the UsersStore interface is what the rest of
// k-users (and its tests) depend on.
//
// ADR 0027: users and user_roles are tenant-scoped (no organization_id). A ZITADEL org maps to an
// app.idp_orgs row; which legal entities a staff user may act for lives in app.user_entities.
import type { AdminUser, AdminUsersQuery, AdminUsersSummary, RoleKey } from '@bos/contracts';
import { idpOrgs, organizations } from '@bos/db';
import { Inject, Injectable } from '@nestjs/common';
import { type SQL, and, eq, sql } from 'drizzle-orm';

import { DB, type Db, type DbTransaction } from '../db/db.module';
import { searchPage } from '../list';
import { type Actor, type TxScope, withTx } from '../db/tx';
import type { MirroredStatus } from './zitadel-admin.client';

/** Either the pool-backed db or an open transaction: both can run a statement. */
export type Queryable = Db | DbTransaction;

/** A ZITADEL org as app.idp_orgs maps it: the tenant, and staff vs portal (ADR 0027 section 2). */
export interface IdpOrgRow {
  idpOrgId: string;
  tenantId: string;
  zitadelOrgId: string;
  kind: 'staff' | 'customer' | 'vendor';
}

export interface UserRow {
  id: string;
  tenantId: string;
  idpOrgId: string;
  zitadelUserId: string;
  email: string | null;
  displayName: string | null;
  status: MirroredStatus;
}

/** One app.user_entities row: an entity the staff user may act for (ADR 0027 section 3). */
export interface MembershipRow {
  organizationId: string;
  isDefault: boolean;
  /** NULL = every role in the token. */
  roleKeys: string[] | null;
  departmentId: string | null;
}

export interface UserFields {
  zitadelUserId: string;
  /** The IdP org the user logs in through; only insertUser reads it. */
  idpOrgId: string;
  email: string | null;
  displayName: string | null;
  status: MirroredStatus;
}

export type ListedUser = AdminUser & UserRow;
/** Up to `limit + 1` rows (the extra one says another page exists) and the count of all matches. */
export type ListedUsers = { rows: ListedUser[]; total: number };
export type StaffSummary = Omit<AdminUsersSummary, 'canSendPasswordReset'>;

/** One ZITADEL event id as the webhook delivered it; the triple is the dedupe key (§3). */
export interface ZitadelEventKey {
  instanceId: string;
  aggregateId: string;
  sequence: string;
  eventType: string | null;
}

export abstract class UsersStore {
  abstract idpOrgByZitadelId(zitadelOrgId: string): Promise<IdpOrgRow | null>;
  abstract idpOrgById(idpOrgId: string): Promise<IdpOrgRow | null>;
  /** The tenant's one staff IdP org: where invites are created and grants are set. */
  abstract staffIdpOrgOf(tenantId: string): Promise<IdpOrgRow | null>;
  /** Every staff IdP org; reconcile walks these (portal orgs are invisible to the provisioner token). */
  abstract listStaffIdpOrgs(): Promise<IdpOrgRow[]>;
  /** The tenant's default entity id: bootstrap memberships land here and user writes are audited under it. */
  abstract defaultEntityOf(tenantId: string): Promise<string | null>;
  /** The scope withTx put on this transaction (bos.tenant_id / bos.organization_id). */
  abstract txScope(tx: DbTransaction): Promise<TxScope>;

  /** `lock` takes FOR UPDATE, so a hook sync and a reconcile of the same user run one after the other. */
  abstract findByZitadelId(
    q: Queryable,
    zitadelUserId: string,
    lock?: boolean,
  ): Promise<UserRow | null>;
  /** Tenant-scoped: `scope.organizationId` is not a filter, users have no entity. */
  abstract findById(q: Queryable, scope: TxScope, userId: string): Promise<UserRow | null>;
  /** Inserts, or returns the existing row's id when a concurrent insert won. */
  abstract insertUser(tx: DbTransaction, scope: TxScope, u: UserFields): Promise<string>;
  abstract updateUser(
    tx: DbTransaction,
    userId: string,
    u: Omit<UserFields, 'zitadelUserId' | 'idpOrgId'>,
  ): Promise<void>;
  abstract notInactiveInIdpOrg(q: Queryable, org: IdpOrgRow): Promise<UserRow[]>;

  abstract membershipsOf(q: Queryable, tenantId: string, userId: string): Promise<MembershipRow[]>;
  /**
   * The bootstrap rule (ADR 0027 section 3): a membership in `entityId` (is_default, role_keys NULL)
   * when the user has none at all. Returns whether it inserted one.
   */
  abstract ensureDefaultMembership(
    tx: DbTransaction,
    tenantId: string,
    entityId: string,
    userId: string,
  ): Promise<boolean>;

  abstract rolesOf(q: Queryable, tenantId: string, userId: string): Promise<RoleKey[]>;
  abstract replaceRoles(
    tx: DbTransaction,
    scope: TxScope,
    userId: string,
    roles: readonly RoleKey[],
  ): Promise<void>;
  /** Bumps the tenant's authz_version so every process drops its cached principals and grants. */
  abstract bumpAuthzVersion(tx: DbTransaction, scope: TxScope): Promise<void>;

  /** Active holders of `role` with a membership in the entity whose role_keys is NULL or has the role. */
  abstract userIdsWithRole(scope: TxScope, role: RoleKey): Promise<string[]>;
  /** Active holders of `role` across the tenant, used by the last-Founder guard. */
  abstract activeRoleHolderIds(q: Queryable, tenantId: string, role: RoleKey): Promise<string[]>;
  /** The address of an `active` user only: notifications must not mail a deactivated or invited person. */
  abstract emailOf(userId: string): Promise<string | null>;
  /**
   * The tenant's staff users (the staff IdP org's), with their mirrored roles. `total` counts every match of
   * the same scope, filters and search, ignoring the id cursor and the page.
   */
  abstract list(scope: TxScope, q: AdminUsersQuery): Promise<ListedUsers>;
  abstract summary(scope: TxScope): Promise<StaffSummary>;
  abstract recordActivity(scope: TxScope, actor: Actor): Promise<void>;

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

const USER_COLUMNS = sql`u.id, u.tenant_id AS "tenantId", u.idp_org_id AS "idpOrgId",
  u.zitadel_user_id AS "zitadelUserId", u.email, u.display_name AS "displayName", u.status`;

const STAFF_USERS = sql`FROM app.users u
  JOIN app.idp_orgs io ON io.id = u.idp_org_id AND io.tenant_id = u.tenant_id AND io.kind = 'staff'`;

const DIRECTORY_ORDER = {
  name: sql`lower(coalesce(u.display_name, u.email)) ASC NULLS LAST, u.id`,
  lastActive: sql`u.last_active_at DESC NULLS LAST, u.id`,
  createdAt: sql`u.created_at DESC, u.id`,
};

const IDP_ORG_COLUMNS = {
  idpOrgId: idpOrgs.id,
  tenantId: idpOrgs.tenantId,
  zitadelOrgId: idpOrgs.zitadelOrgId,
  kind: idpOrgs.kind,
};

type UserRecord = UserRow & Record<string, unknown>;

@Injectable()
export class SqlUsersStore extends UsersStore {
  constructor(@Inject(DB) private readonly db: Db) {
    super();
  }

  async idpOrgByZitadelId(zitadelOrgId: string): Promise<IdpOrgRow | null> {
    const found = await this.db
      .select(IDP_ORG_COLUMNS)
      .from(idpOrgs)
      .where(eq(idpOrgs.zitadelOrgId, zitadelOrgId))
      .limit(1);
    return found[0] ?? null;
  }

  async idpOrgById(idpOrgId: string): Promise<IdpOrgRow | null> {
    const found = await this.db
      .select(IDP_ORG_COLUMNS)
      .from(idpOrgs)
      .where(eq(idpOrgs.id, idpOrgId))
      .limit(1);
    return found[0] ?? null;
  }

  async staffIdpOrgOf(tenantId: string): Promise<IdpOrgRow | null> {
    const found = await this.db
      .select(IDP_ORG_COLUMNS)
      .from(idpOrgs)
      .where(and(eq(idpOrgs.tenantId, tenantId), eq(idpOrgs.kind, 'staff')))
      .limit(1);
    return found[0] ?? null;
  }

  listStaffIdpOrgs(): Promise<IdpOrgRow[]> {
    return this.db.select(IDP_ORG_COLUMNS).from(idpOrgs).where(eq(idpOrgs.kind, 'staff'));
  }

  async defaultEntityOf(tenantId: string): Promise<string | null> {
    const found = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.tenantId, tenantId), eq(organizations.isDefault, true)))
      .limit(1);
    return found[0]?.id ?? null;
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
          WHERE u.tenant_id = ${scope.tenantId} AND u.id = ${userId}`,
    );
    return row ?? null;
  }

  async insertUser(tx: DbTransaction, scope: TxScope, u: UserFields): Promise<string> {
    const [inserted] = await rows<{ id: string }>(
      tx,
      sql`INSERT INTO app.users (tenant_id, idp_org_id, zitadel_user_id, email, display_name, status, last_synced_at)
          VALUES (${scope.tenantId}, ${u.idpOrgId}, ${u.zitadelUserId}, ${u.email},
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
    u: Omit<UserFields, 'zitadelUserId' | 'idpOrgId'>,
  ): Promise<void> {
    await tx.execute(
      sql`UPDATE app.users SET email = ${u.email}, display_name = ${u.displayName},
            status = ${u.status}, last_synced_at = now(), updated_at = now()
          WHERE id = ${userId}`,
    );
  }

  notInactiveInIdpOrg(q: Queryable, org: IdpOrgRow): Promise<UserRow[]> {
    return rows<UserRecord>(
      q,
      sql`SELECT ${USER_COLUMNS} FROM app.users u
          WHERE u.tenant_id = ${org.tenantId} AND u.idp_org_id = ${org.idpOrgId}
            AND u.status <> 'inactive'`,
    );
  }

  membershipsOf(q: Queryable, tenantId: string, userId: string): Promise<MembershipRow[]> {
    return rows<MembershipRow & Record<string, unknown>>(
      q,
      sql`SELECT organization_id AS "organizationId", is_default AS "isDefault",
                 role_keys AS "roleKeys", department_id AS "departmentId"
          FROM app.user_entities WHERE tenant_id = ${tenantId} AND user_id = ${userId}
          ORDER BY is_default DESC, organization_id`,
    );
  }

  async ensureDefaultMembership(
    tx: DbTransaction,
    tenantId: string,
    entityId: string,
    userId: string,
  ): Promise<boolean> {
    // NOT EXISTS: only a user with no membership at all gets one. The explicit target (ADR 0027
    // section 9) makes a concurrent bootstrap of the same user a no-op instead of an error.
    const inserted = await rows<{ one: number }>(
      tx,
      sql`INSERT INTO app.user_entities (tenant_id, organization_id, user_id, is_default, role_keys)
          SELECT ${tenantId}::uuid, ${entityId}::uuid, ${userId}::uuid, true, NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM app.user_entities WHERE tenant_id = ${tenantId} AND user_id = ${userId})
          ON CONFLICT (tenant_id, organization_id, user_id) DO NOTHING
          RETURNING 1 AS one`,
    );
    return inserted.length > 0;
  }

  async rolesOf(q: Queryable, tenantId: string, userId: string): Promise<RoleKey[]> {
    const found = await rows<{ role: RoleKey }>(
      q,
      sql`SELECT role_key AS role FROM app.user_roles
          WHERE tenant_id = ${tenantId} AND user_id = ${userId} ORDER BY role_key`,
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
        ? sql`DELETE FROM app.user_roles WHERE tenant_id = ${scope.tenantId} AND user_id = ${userId}`
        : sql`DELETE FROM app.user_roles WHERE tenant_id = ${scope.tenantId} AND user_id = ${userId}
                AND role_key NOT IN (${sql.join(
                  keep.map((r) => sql`${r}`),
                  sql`, `,
                )})`,
    );
    for (const role of keep) {
      await tx.execute(
        sql`INSERT INTO app.user_roles (tenant_id, user_id, role_key, source)
            VALUES (${scope.tenantId}, ${userId}, ${role}, 'zitadel')
            ON CONFLICT (tenant_id, user_id, role_key) DO NOTHING`,
      );
    }
  }

  async bumpAuthzVersion(tx: DbTransaction, scope: TxScope): Promise<void> {
    // authz_versions_tenant_unique (0013) makes this one race-free statement.
    await tx.execute(
      sql`INSERT INTO app.authz_versions (tenant_id, version)
          VALUES (${scope.tenantId}, 1)
          ON CONFLICT (tenant_id)
          DO UPDATE SET version = app.authz_versions.version + 1, updated_at = now()`,
    );
  }

  async userIdsWithRole(scope: TxScope, role: RoleKey): Promise<string[]> {
    const found = await rows<{ id: string }>(
      this.db,
      sql`SELECT u.id FROM app.user_roles ur
          JOIN app.users u ON u.tenant_id = ur.tenant_id AND u.id = ur.user_id
          JOIN app.user_entities ue ON ue.tenant_id = ur.tenant_id AND ue.user_id = ur.user_id
            AND ue.organization_id = ${scope.organizationId}
          WHERE ur.tenant_id = ${scope.tenantId} AND ur.role_key = ${role} AND u.status = 'active'
            AND (ue.role_keys IS NULL OR ${role}::text = ANY (ue.role_keys))
          ORDER BY u.id`,
    );
    return found.map((r) => r.id);
  }

  async activeRoleHolderIds(q: Queryable, tenantId: string, role: RoleKey): Promise<string[]> {
    const found = await rows<{ id: string }>(
      q,
      sql`SELECT u.id FROM app.user_roles ur
          JOIN app.users u ON u.tenant_id = ur.tenant_id AND u.id = ur.user_id
          WHERE ur.tenant_id = ${tenantId} AND ur.role_key = ${role} AND u.status = 'active'
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

  async list(scope: TxScope, q: AdminUsersQuery): Promise<ListedUsers> {
    const from = sql`${STAFF_USERS}
          LEFT JOIN app.user_entities ue ON ue.tenant_id = u.tenant_id AND ue.user_id = u.id
            AND ue.organization_id = ${scope.organizationId}
          LEFT JOIN app.departments d ON d.tenant_id = ue.tenant_id
            AND d.organization_id = ue.organization_id AND d.id = ue.department_id`;
    const any = (values: readonly string[]) =>
      sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      );
    // Scope and filters only; the search and the cursor are added below.
    const filters = sql`u.tenant_id = ${scope.tenantId}
      ${q.status?.length ? sql`AND u.status IN (${any(q.status)})` : sql``}
      ${q.departmentId ? sql`AND d.id = ${q.departmentId}` : sql``}
      ${
        q.role?.length
          ? sql`AND EXISTS (SELECT 1 FROM app.user_roles ur WHERE ur.tenant_id = u.tenant_id
              AND ur.user_id = u.id AND ur.role_key IN (${any(q.role)}))`
          : sql``
      }`;
    const order = q.sort ? DIRECTORY_ORDER[q.sort] : sql`u.id`;
    const count = async (reader: Queryable, where: SQL | undefined) => {
      const [row] = await rows<{ n: number }>(
        reader,
        sql`SELECT count(*)::int AS n ${from} WHERE ${where}`,
      );
      return row?.n ?? 0;
    };
    const select = (where: SQL | undefined, orderBy: SQL[], tail: SQL) => sql`
      SELECT ${USER_COLUMNS}, u.avatar_document_id AS "avatarDocumentId",
        to_char(u.last_active_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastActiveAt",
        to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
        CASE WHEN d.id IS NOT NULL THEN jsonb_build_object('id', d.id, 'name', d.name) END AS department,
        ARRAY(SELECT ur.role_key FROM app.user_roles ur
          WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id ORDER BY ur.role_key) AS roles
      ${from}
      WHERE ${where}
      ORDER BY ${sql.join(orderBy, sql`, `)}
      ${tail}`;

    // The id cursor (`u.id > after`) assumes id order, which similarity ranking breaks: with a cursor the
    // search stays an exact substring match.
    if (!q.q || q.after) {
      // Search punctuation literally. ILIKE supplies case folding and uses the trigram indexes.
      const pattern = q.q ? `%${q.q.replace(/[!%_]/g, '!$&')}%` : null;
      const matching = sql`${filters}
            ${pattern ? sql`AND (u.display_name ILIKE ${pattern} ESCAPE '!' OR u.email ILIKE ${pattern} ESCAPE '!')` : sql``}`;
      const [found, total] = await Promise.all([
        rows<ListedUser & Record<string, unknown>>(
          this.db,
          select(
            sql`${matching} ${q.after ? sql`AND u.id > ${q.after}` : sql``}`,
            [order],
            sql`LIMIT ${q.limit + 1} OFFSET ${((q.page ?? 1) - 1) * q.limit}`,
          ),
        ),
        // The cursor only moves through the matches, so the total leaves it out.
        count(this.db, matching),
      ]);
      return { rows: found, total };
    }

    // One extra row tells the controller whether another page exists.
    const result = await searchPage<ListedUser & Record<string, unknown>>(this.db, {
      q: q.q,
      columns: [sql`u.display_name`, sql`u.email`],
      where: filters,
      orderBy: [order],
      limit: q.limit + 1,
      offset: ((q.page ?? 1) - 1) * q.limit,
      // Run on `tx`, not this.db: fuzzy mode sets its similarity threshold for that transaction only.
      rows: (tx, p) =>
        rows(tx, select(p.where, p.orderBy, sql`LIMIT ${p.limit} OFFSET ${p.offset}`)),
      count,
    });
    return { rows: result.rows, total: result.total };
  }

  async summary(scope: TxScope): Promise<StaffSummary> {
    const [summary] = await rows<StaffSummary>(
      this.db,
      sql`SELECT count(*)::int AS total,
            (count(*) FILTER (WHERE u.status = 'active'))::int AS active,
            (count(*) FILTER (WHERE u.status = 'invited'))::int AS invited,
            (count(*) FILTER (WHERE u.status = 'inactive'))::int AS deactivated,
            coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name)
                        ORDER BY lower(d.name), d.id)
              FROM app.departments d WHERE d.tenant_id = ${scope.tenantId}
                AND d.organization_id = ${scope.organizationId}), '[]'::jsonb) AS departments
          ${STAFF_USERS}
          WHERE u.tenant_id = ${scope.tenantId}`,
    );
    return summary!;
  }

  recordActivity(scope: TxScope, actor: Actor): Promise<void> {
    return withTx(this.db, scope, actor, async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '500ms'`);
      // The WHERE clause is rechecked by Postgres after a concurrent update, so this is also
      // the throttle across API instances. The timestamp is independent of profile updated_at.
      await tx.execute(sql`UPDATE app.users SET last_active_at = now()
        WHERE tenant_id = ${scope.tenantId} AND id = ${actor.id} AND status = 'active'
          AND (last_active_at IS NULL OR last_active_at < now() - interval '5 minutes')`);
    });
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
