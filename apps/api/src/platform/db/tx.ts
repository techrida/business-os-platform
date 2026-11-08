// The one way to write to an app.* table. Serves the NFR "every change is audited": withTx sets the
// bos.* session settings that the audit trigger reads, and the trigger refuses a write when
// bos.actor_id is missing.
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { principal } from '../authz/principal';
import { ctx } from '../tenancy/request-context';
import { type Db, type DbTransaction, inTransaction } from './db.module';

// Kernel services import the transaction type from here, next to withTx.
export type { Db, DbTransaction };

export interface Actor {
  kind: 'user' | 'system' | 'zitadel' | 'seed';
  id: string;
  ip?: string | null;
  userAgent?: string | null;
  correlationId: string;
}

export interface TxScope {
  tenantId: string;
  organizationId: string;
}

function requireNonEmpty(value: string, what: string): void {
  if (value.trim() === '') {
    throw new Error(`${what} must be a non-empty string`);
  }
}

/**
 * Runs `fn` in one transaction whose first statement sets the scope and the actor for the whole
 * transaction. `set_config(..., true)` is the function form of SET LOCAL: it vanishes at COMMIT or
 * ROLLBACK, so a pooled connection never carries one request's identity into the next.
 *
 * Rejects before opening a transaction when the actor id or the correlation id is empty: an audit
 * row without a who or a trace id is worse than a failed write.
 */
export async function withTx<T>(
  db: Db,
  scope: TxScope,
  actor: Actor,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  requireNonEmpty(actor.id, 'actor.id');
  requireNonEmpty(actor.correlationId, 'actor.correlationId');
  return inTransaction(db, async (tx) => {
    await tx.execute(sql`SELECT
      set_config('bos.tenant_id', ${scope.tenantId}, true),
      set_config('bos.organization_id', ${scope.organizationId}, true),
      set_config('bos.actor_kind', ${actor.kind}, true),
      set_config('bos.actor_id', ${actor.id}, true),
      set_config('bos.correlation_id', ${actor.correlationId}, true),
      set_config('bos.ip', ${actor.ip ?? ''}, true),
      set_config('bos.user_agent', ${actor.userAgent ?? ''}, true)`);
    return fn(tx);
  });
}

/**
 * Scope and actor of the current HTTP request. HTTP only: it reads ctx(), which throws in the
 * worker. The actor id is the internal `app.users` uuid (principal().userId), not the ZITADEL `sub`.
 */
export function requestTx(): { scope: TxScope; actor: Actor } {
  const c = ctx();
  return {
    scope: { tenantId: c.tenantId, organizationId: c.organizationId },
    actor: {
      kind: 'user',
      id: principal().userId,
      ip: c.ip,
      userAgent: c.userAgent,
      correlationId: c.correlationId,
    },
  };
}

/**
 * The actor for a background job (the worker has no request, so no user). `job` names it in the
 * audit log as `system:<job>`. Without a correlation id, a fresh `sys-<uuid>` (40 characters of
 * letters, digits and hyphens) satisfies the same pattern as an HTTP correlation id.
 */
export function systemActor(job: string, correlationId?: string): Actor {
  requireNonEmpty(job, 'job');
  return {
    kind: 'system',
    id: `system:${job}`,
    correlationId: correlationId ?? `sys-${randomUUID()}`,
  };
}
