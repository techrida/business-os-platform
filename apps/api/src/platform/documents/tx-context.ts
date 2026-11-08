// Reads who is writing and for which scope back out of the open transaction.
// Serves NFR Auditability: kernel services take `tx` only (they never call ctx(), because the worker has
// no request), so the scope and the actor are the ones withTx() set with set_config for this transaction.
import { sql } from 'drizzle-orm';

import type { DbTransaction, TxScope } from '../db/tx';

export interface TxContext {
  scope: TxScope;
  /** `bos.actor_id` as set by withTx: an app.users uuid for a user, a job name for the system. */
  actorId: string;
  actorKind: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The actor as a uuid for a `created_by` / `uploaded_by` column, or null when it is a job or a seed. */
export function actorUuid(c: TxContext): string | null {
  return c.actorKind === 'user' && UUID.test(c.actorId) ? c.actorId : null;
}

export async function readTxContext(tx: DbTransaction): Promise<TxContext> {
  const res = await tx.execute(sql`SELECT
    current_setting('bos.tenant_id', true) AS tenant_id,
    current_setting('bos.organization_id', true) AS organization_id,
    current_setting('bos.actor_id', true) AS actor_id,
    current_setting('bos.actor_kind', true) AS actor_kind`);
  const row = res.rows[0] as
    | {
        tenant_id: string | null;
        organization_id: string | null;
        actor_id: string | null;
        actor_kind: string | null;
      }
    | undefined;
  if (!row?.tenant_id || !row.organization_id || !row.actor_id) {
    // Failing here is the point: a write with no scope must never fall back to a default.
    throw new Error('documents: this call must run inside withTx(), which sets the bos.* settings');
  }
  return {
    scope: { tenantId: row.tenant_id, organizationId: row.organization_id },
    actorId: row.actor_id,
    actorKind: row.actor_kind ?? 'user',
  };
}
