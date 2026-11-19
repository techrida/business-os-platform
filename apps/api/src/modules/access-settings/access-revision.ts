// Tenant-scoped access revision helper (migration 0084_access_revisions).
// Exported for both the Access Settings endpoints (B2) and the Departments endpoints (B1) so every
// access policy or department-membership/head write bumps the same revision atomically inside its tx.
import { sql } from 'drizzle-orm';

import type { Db, DbTransaction } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';

export type AccessQueryable = Db | DbTransaction;

export interface AccessRevisionRow {
  revision: string;
  levelRulesMaterialized: boolean;
  updatedAt: string | null;
  updatedByUserId: string | null;
  updatedByName: string | null;
}

export interface BumpAccessRevisionOptions {
  /** Acting user who made the change (stored in updated_by_user_id for "Last changed"). */
  actorUserId?: string | null;
  /** When true, marks default level rules as materialized into app.role_permission_levels. */
  markLevelRulesMaterialized?: boolean;
}

/**
 * Takes a transaction-scoped advisory lock for this tenant's access writes so concurrent saves
 * serialize cleanly and cannot interleave revision checks or first-write materializations.
 */
export async function lockAccessRevision(tx: DbTransaction, tenantId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('access_revisions:' || ${tenantId}))`);
}

/** Reads the tenant's current access revision, last-changed metadata, and level-rule flag. */
export async function readAccessRevision(
  q: AccessQueryable,
  tenantId: string,
): Promise<AccessRevisionRow> {
  const result = await (q as Db).execute<{
    revision: string;
    levelRulesMaterialized: boolean;
    updatedAt: string;
    updatedByUserId: string | null;
    updatedByName: string | null;
  }>(sql`
    SELECT ar.revision::text AS revision,
           ar.level_rules_materialized AS "levelRulesMaterialized",
           to_char(ar.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
           ar.updated_by_user_id AS "updatedByUserId",
           coalesce(u.display_name, u.email) AS "updatedByName"
      FROM app.access_revisions ar
      LEFT JOIN app.users u
        ON u.tenant_id = ar.tenant_id AND u.id = ar.updated_by_user_id
     WHERE ar.tenant_id = ${tenantId}
     LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) {
    return {
      revision: '0',
      levelRulesMaterialized: false,
      updatedAt: null,
      updatedByUserId: null,
      updatedByName: null,
    };
  }
  return row;
}

/**
 * Atomically increments the tenant's access revision inside an open `withTx` transaction and returns
 * the new opaque revision string. Shared with the departments unit (B1).
 */
export async function bumpAccessRevision(
  tx: DbTransaction,
  scope: TxScope,
  options: BumpAccessRevisionOptions = {},
): Promise<string> {
  const actorUserId = options.actorUserId ?? null;
  const materialized = options.markLevelRulesMaterialized ?? false;
  const result = await tx.execute<{ revision: string }>(sql`
    INSERT INTO app.access_revisions (
      tenant_id, revision, level_rules_materialized, updated_at, updated_by_user_id
    )
    VALUES (${scope.tenantId}, 1, ${materialized}, now(), ${actorUserId})
    ON CONFLICT (tenant_id) DO UPDATE
      SET revision = app.access_revisions.revision + 1,
          level_rules_materialized = app.access_revisions.level_rules_materialized OR EXCLUDED.level_rules_materialized,
          updated_at = now(),
          updated_by_user_id = COALESCE(EXCLUDED.updated_by_user_id, app.access_revisions.updated_by_user_id)
    RETURNING revision::text AS revision
  `);
  return result.rows[0]?.revision ?? '1';
}
