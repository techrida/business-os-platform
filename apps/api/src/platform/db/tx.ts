// The one way to write to an app.* table. Serves the NFR "every change is audited": withTx sets the
// bos.* session settings that the audit trigger reads, and the trigger refuses a write when
// bos.actor_id is missing.
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { principal } from '../authz/principal';
import { ctx } from '../tenancy/request-context';
import { dbBusyKindOf } from './busy';
import { type Db, type DbTransaction, inTransaction } from './db.module';
import { txObserver, txTimeouts } from './tx-settings';

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

export interface TxOptions {
  /**
   * When the transaction takes its tenant's audit-chain lock. 'first' (the default): right after the settings
   * statement, before `fn` runs. 'lazy': only when the first audited write takes it (audit.append), as before.
   * Use 'lazy' only for a transaction that never writes an audited row, or one that must not hold the tenant
   * lock across a call to another service (ZITADEL); see withTx.
   */
  audit?: 'first' | 'lazy';
  /**
   * Overrides the statement limit (DB_STATEMENT_TIMEOUT_MS, 15 s) for this transaction, in ms, a positive integer.
   * For a statement that is slow on purpose (a register over many months). Give the reason where it is used.
   * Keep it below the pool's client-side query_timeout (35 s in the API, 125 s in the worker, runtimePoolOptions):
   * past that the client gives up first, with an error that has no SQLSTATE, and its rollback queues behind the
   * statement still running on the server. There is no "off": 0 is refused.
   */
  statementTimeoutMs?: number;
}

/** For a transaction that only reads: it never appends to the audit chain, so it need not wait for its tenant's lock. */
export const READ_ONLY: TxOptions = { audit: 'lazy' };

/** For a transaction whose writes all go to tables without an audit trigger (outbox, authz_versions): no chain lock needed. */
export const UNAUDITED_WRITE: TxOptions = { audit: 'lazy' };

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
 * The same statement sets `lock_timeout`, `statement_timeout` and `idle_in_transaction_session_timeout` for this
 * transaction only (configureTx in tx-settings.ts), so a write stuck behind a lock fails with 55P03 instead of
 * holding its pool connection, a statement that runs too long is cancelled with 57014 (answered as 503 db_busy),
 * and a transaction left open is ended by the server. The wait for the tenant lock below is timed and exported
 * as db_tenant_lock_wait_seconds.
 *
 * Then, unless `options.audit` is 'lazy', it takes the tenant's audit-chain lock: the same
 * transaction-scoped advisory lock audit.append takes at every audited write (0008_audit_hardening.sql),
 * so the later appends get it again for free. Every write transaction thus takes its tenant lock before
 * any row lock, and two transactions cannot hold a row and the tenant lock in opposite orders (40P01:
 * approve locked the approval request then appended; cancel appended, then locked the request). It waits
 * under the lock_timeout set just before, so a long holder still ends in 55P03.
 *
 * Rejects before opening a transaction when the actor id or the correlation id is empty: an audit
 * row without a who or a trace id is worse than a failed write.
 */
export async function withTx<T>(
  db: Db,
  scope: TxScope,
  actor: Actor,
  fn: (tx: DbTransaction) => Promise<T>,
  options?: TxOptions,
): Promise<T> {
  requireNonEmpty(actor.id, 'actor.id');
  requireNonEmpty(actor.correlationId, 'actor.correlationId');
  const {
    lockTimeoutMs,
    statementTimeoutMs: defaultStatementTimeoutMs,
    idleInTxTimeoutMs,
  } = txTimeouts();
  const statementTimeoutMs = options?.statementTimeoutMs ?? defaultStatementTimeoutMs;
  if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1) {
    throw new Error('statementTimeoutMs must be a positive integer');
  }
  const observer = txObserver();
  const started = performance.now();
  let setupSeconds: number | undefined;
  try {
    const result = await inTransaction(db, async (tx) => {
      await tx.execute(sql`SELECT
        set_config('bos.tenant_id', ${scope.tenantId}, true),
        set_config('bos.organization_id', ${scope.organizationId}, true),
        set_config('bos.actor_kind', ${actor.kind}, true),
        set_config('bos.actor_id', ${actor.id}, true),
        set_config('bos.correlation_id', ${actor.correlationId}, true),
        set_config('bos.ip', ${actor.ip ?? ''}, true),
        set_config('bos.user_agent', ${actor.userAgent ?? ''}, true),
        set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true),
        set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true),
        set_config('idle_in_transaction_session_timeout', ${`${idleInTxTimeoutMs}ms`}, true)`);
      // Stamped before the tenant lock: setup stays pool checkout + BEGIN + settings (TX_SETUP_BUCKETS).
      setupSeconds = (performance.now() - started) / 1000;
      if (options?.audit !== 'lazy') {
        const lockStarted = performance.now();
        try {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended('audit.chain:' || ${scope.tenantId}::uuid::text, 0))`,
          );
        } finally {
          // Also when the wait ended in lock_timeout: those are the waits the metric exists to show.
          observer?.observeTenantLockWait((performance.now() - lockStarted) / 1000);
        }
      }
      return fn(tx);
    });
    observer?.observeTx('commit', setupSeconds, (performance.now() - started) / 1000);
    return result;
  } catch (error) {
    observer?.observeTx('rollback', setupSeconds, (performance.now() - started) / 1000);
    const busy = dbBusyKindOf(error);
    if (busy !== undefined) observer?.countDbBusy(busy);
    throw error;
  }
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
