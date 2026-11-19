// Seam for the entity-level access revision counter (U20b, Spec 7.3 & 7.6).
// Kept behind a tiny port so B2 can swap in its shared `bumpAccessRevision(tx, scope)` helper
// without touching DepartmentsAdminService or its tests.
//
// Default implementation stores the monotonic counter in app.settings under key `access.revision`
// (append-only, audited, advisory-locked per tenant + entity). Keeping it separate from
// `app.authz_versions` avoids a stale-revision collision when `authz.invalidate()` bumps
// `authz_versions` after commit.
import { ConflictException, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { Db, DbTransaction } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';

export const ACCESS_REVISION_PORT = Symbol('ACCESS_REVISION_PORT');

const ACCESS_REVISION_KEY = 'access.revision';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccessRevisionPort {
  /** Reads the current access revision for `(tenantId, organizationId)` (0 before first change). */
  read(q: Db | DbTransaction, scope: TxScope): Promise<number>;
  /**
   * Acquires the per-entity access revision lock inside `tx`, verifies `expectedRevision` when
   * supplied (throwing 409 `stale_access` on mismatch), increments the counter, and returns the
   * new revision number.
   */
  bump(tx: DbTransaction, scope: TxScope, expectedRevision?: number): Promise<number>;
}

function lockKey(scope: TxScope): string {
  return `${scope.tenantId}:${scope.organizationId}:${ACCESS_REVISION_KEY}`;
}

@Injectable()
export class SettingsAccessRevisionStore implements AccessRevisionPort {
  async read(q: Db | DbTransaction, scope: TxScope): Promise<number> {
    const result = await q.execute<{ version: number }>(sql`
      SELECT version FROM app.settings
       WHERE tenant_id = ${scope.tenantId}::uuid
         AND organization_id = ${scope.organizationId}::uuid
         AND key = ${ACCESS_REVISION_KEY}::text
       ORDER BY version DESC
       LIMIT 1`);
    const row = result.rows[0];
    return row ? Number(row.version) : 0;
  }

  async bump(tx: DbTransaction, scope: TxScope, expectedRevision?: number): Promise<number> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(scope)}::text, 0))`,
    );

    const current = await this.read(tx, scope);
    if (expectedRevision !== undefined && current !== expectedRevision) {
      throw new ConflictException({
        code: 'stale_access',
        message: 'Access settings were changed by someone else. Reload to see the latest state.',
      });
    }

    const actorRes = await tx.execute<{
      actor_kind: string | null;
      actor_id: string | null;
    }>(sql`
      SELECT current_setting('bos.actor_kind', true) AS actor_kind,
             current_setting('bos.actor_id', true) AS actor_id`);
    const actorRow = actorRes.rows[0];
    const createdBy =
      actorRow?.actor_kind === 'user' && actorRow.actor_id && UUID_RE.test(actorRow.actor_id)
        ? actorRow.actor_id
        : null;

    const next = current + 1;
    await tx.execute(sql`
      INSERT INTO app.settings (tenant_id, organization_id, key, version, value, created_by)
      VALUES (
        ${scope.tenantId}::uuid,
        ${scope.organizationId}::uuid,
        ${ACCESS_REVISION_KEY}::text,
        ${next},
        ${JSON.stringify({ revision: next })}::jsonb,
        ${createdBy}::uuid
      )`);
    return next;
  }
}
