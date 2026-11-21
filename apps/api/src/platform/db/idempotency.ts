// One convention for "a retried command runs once" and "an edit must start from the version the caller saw".
// Serves the NFRs "no double effects" and "no lost updates". D34 / M22 of the P1 delta.
//
// Both helpers run inside a transaction opened by withTx(), and read the tenant, organization and actor from
// the bos.* settings that withTx() set, so a caller cannot name a different scope than the one it writes under.
import { idempotencyKeys } from '@bos/db';
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

// Pure and dependency-free, so it is reused from approvals instead of copied. It moves next to this file when
// approvals moves onto withIdempotency (a later unit).
import { canonicalSha256 } from '../hashing/canonical-json';
import type { DbTransaction } from './tx';

/** What a command hands back: the HTTP status and the JSON-serialisable body that a replay will return. */
export interface IdempotentResult<T> {
  status: number;
  response: T;
}

export interface IdempotencyInput {
  /** Names the operation, e.g. `memo.create`. The same key may be reused for another command. */
  command: string;
  /** The client's Idempotency-Key. */
  key: string;
  /** The request body. Its canonical JSON (sorted keys) is hashed, so key order never matters. */
  body: unknown;
}

interface SessionScope {
  tenantId: string;
  organizationId: string;
  actorId: string;
}

async function sessionScope(tx: DbTransaction): Promise<SessionScope> {
  const { rows } = await tx.execute<{
    tenant_id: string;
    organization_id: string;
    actor_id: string;
  }>(
    sql`SELECT nullif(current_setting('bos.tenant_id', true), '') AS tenant_id,
               nullif(current_setting('bos.organization_id', true), '') AS organization_id,
               nullif(current_setting('bos.actor_id', true), '') AS actor_id`,
  );
  const row = rows[0];
  if (row?.tenant_id == null || row.organization_id == null || row.actor_id == null) {
    throw new Error('idempotency: no scope or actor on this transaction; open it with withTx()');
  }
  return { tenantId: row.tenant_id, organizationId: row.organization_id, actorId: row.actor_id };
}

/**
 * Runs `fn` once per (tenant, legal entity, actor, command, key). The entity is part of the key: a retry from
 * another entity of the same tenant is a different command and never replays the first entity's answer.
 *
 * - First call: claims the key with an INSERT, runs `fn`, stores its `{ status, response }`.
 * - Replay with the same body: returns the stored answer without calling `fn` (`replayed: true`).
 * - Same key with a different body: 422. The client reused a key for another request.
 * - Two first calls at the same moment: the second INSERT waits on the unique index until the first
 *   transaction ends, then finds the finished row and replays it. If the first one rolled back, its claim is
 *   gone and the second one runs `fn` itself. No explicit row lock is needed.
 *
 * The claim lives in the caller's transaction, so `fn`'s own writes and the stored answer commit or roll back
 * together: there is no state where the effect happened but the key is free, or the reverse.
 */
export async function withIdempotency<T>(
  tx: DbTransaction,
  input: IdempotencyInput,
  fn: (tx: DbTransaction) => Promise<IdempotentResult<T>>,
): Promise<IdempotentResult<T> & { replayed: boolean }> {
  const requestHash = canonicalSha256(input.body === undefined ? null : input.body);
  const scope = await sessionScope(tx);
  const identity = and(
    eq(idempotencyKeys.tenantId, scope.tenantId),
    eq(idempotencyKeys.organizationId, scope.organizationId),
    eq(idempotencyKeys.actorId, scope.actorId),
    eq(idempotencyKeys.command, input.command),
    eq(idempotencyKeys.key, input.key),
  );

  const claimed = await tx
    .insert(idempotencyKeys)
    .values({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      command: input.command,
      key: input.key,
      requestHash,
    })
    .onConflictDoNothing({
      target: [
        idempotencyKeys.tenantId,
        idempotencyKeys.organizationId,
        idempotencyKeys.actorId,
        idempotencyKeys.command,
        idempotencyKeys.key,
      ],
    })
    .returning({ id: idempotencyKeys.id });

  const claim = claimed[0];
  if (claim !== undefined) {
    const result = await fn(tx);
    await tx
      .update(idempotencyKeys)
      .set({ status: result.status, response: result.response ?? null })
      .where(eq(idempotencyKeys.id, claim.id));
    return { ...result, replayed: false };
  }

  // The key was taken. A concurrent claimant has finished by now (our INSERT waited for it), so this read
  // sees its row; a row from this same transaction is visible too.
  const [previous] = await tx
    .select({
      requestHash: idempotencyKeys.requestHash,
      status: idempotencyKeys.status,
      response: idempotencyKeys.response,
    })
    .from(idempotencyKeys)
    .where(identity);
  if (previous === undefined) {
    // Claimed, then removed before we could read it (a retention sweep). Let the client retry.
    throw new ConflictException('This Idempotency-Key was released while it was being checked');
  }
  if (!previous.requestHash.equals(requestHash)) {
    throw new UnprocessableEntityException(
      'This Idempotency-Key was already used for a different request',
    );
  }
  if (previous.status === null) {
    // Only reachable when a caller swallowed fn's error inside the same transaction: the claim has no answer.
    throw new ConflictException('The first request with this Idempotency-Key did not finish');
  }
  return { status: previous.status, response: previous.response as T, replayed: true };
}

/** A table that `updateVersioned` can guard: it needs `id` and `version` columns (and may have `tenantId`). */
export type VersionedTable = PgTable & { id: PgColumn; version: PgColumn };

/**
 * UPDATE ... WHERE id = $id AND version = $expected, setting version = version + 1. Zero rows is a 409: the
 * row was changed since the caller read it (or is not in this tenant, which a caller must not learn apart).
 * Returns the updated row. Postgres serialises two writers on the row lock, and the loser re-checks the version
 * against the winner's committed value, so exactly one of two writers holding the same version succeeds.
 *
 * `set` may not name `id` or `version`: the helper owns the version, and an id change is not an edit.
 * A table with a `tenantId` column is also matched on the transaction's tenant.
 */
export async function updateVersioned<T extends VersionedTable>(
  tx: DbTransaction,
  table: T,
  id: string,
  expectedVersion: number,
  set: Partial<T['$inferInsert']>,
): Promise<T['$inferSelect']> {
  if ('id' in set || 'version' in set) {
    throw new Error('updateVersioned: set must not name id or version');
  }
  const conditions = [eq(table.id, id), eq(table.version, expectedVersion)];
  const tenantColumn = (table as { tenantId?: PgColumn }).tenantId;
  if (tenantColumn !== undefined) {
    conditions.push(eq(tenantColumn, (await sessionScope(tx)).tenantId));
  }
  const rows = (await tx
    .update(table)
    .set({ ...set, version: sql`${table.version} + 1` })
    .where(and(...conditions))
    .returning()) as T['$inferSelect'][];
  const row = rows[0];
  if (row === undefined) {
    throw new ConflictException('This record was changed by someone else; reload it and try again');
  }
  return row;
}
