// The render-failure state of invoices and purchase-order versions (round 4, R4c2: TR-Q4 and F1-Q13; migration 0115).
//
// Their rows are immutable, so their render state lives in `documents`: a live document means rendered or being
// rendered. What `documents` cannot say is "this one failed": that is one `document_render_failures` row per owner,
// holding how many tries failed in a row and when the sweeper may try again, or that it gave up. The pause and the
// limit come from render-retry.ts, the one policy every render sweeper follows.
//
// Every write runs inside the caller's transaction and first takes a per-owner advisory lock, so a sweeper and a Retry
// (or two sweepers) never both count one failure or both write the "given up" admin entry.
import { documentRenderFailures, documents, documentVersions, scoped } from '@bos/db';
import {
  and,
  eq,
  exists,
  gt,
  isNotNull,
  isNull,
  not,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import type { Db, DbTransaction } from '../../../platform/db/db.module';
import { nextRetryPauseMs } from '../../quotations/render/render-retry';

export type RenderFailureOwnerType = (typeof documentRenderFailures.$inferSelect)['ownerType'];

/** One document owner whose render may fail: an invoice or a purchase-order version, in its entity. */
export interface RenderFailureOwner {
  tenantId: string;
  organizationId: string;
  ownerType: RenderFailureOwnerType;
  ownerId: string;
}

/** What one recorded failure did: the failures in a row so far, and whether this one used up the last try. */
export interface RecordedFailure {
  attempts: number;
  givenUp: boolean;
}

const lock = (tx: DbTransaction, o: RenderFailureOwner) =>
  tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`render-failure:${o.ownerType}:${o.ownerId}`}))`,
  );

const ownRow = (o: RenderFailureOwner) =>
  scoped({ tenantId: o.tenantId, organizationId: o.organizationId }).where(
    documentRenderFailures,
    and(
      eq(documentRenderFailures.ownerType, o.ownerType),
      eq(documentRenderFailures.ownerId, o.ownerId),
    ),
  );

/**
 * Counts one failed try of `o` (kind: the fixed failure word, never a message). Below the limit the next try waits
 * the policy's pause; at the limit the render is given up (`givenUp` is true for exactly the call that crossed it). A
 * failure of a render that was already given up changes nothing and is not reported as giving up again.
 */
export async function recordRenderFailure(
  tx: DbTransaction,
  o: RenderFailureOwner,
  kind: string,
  now: Date,
): Promise<RecordedFailure> {
  await lock(tx, o);
  const [row] = await tx
    .select({
      attempts: documentRenderFailures.attempts,
      exhaustedAt: documentRenderFailures.exhaustedAt,
    })
    .from(documentRenderFailures)
    .where(ownRow(o))
    .limit(1);
  if (row?.exhaustedAt != null) return { attempts: row.attempts, givenUp: false };

  const attempts = (row?.attempts ?? 0) + 1;
  const pause = nextRetryPauseMs(attempts);
  const state = {
    attempts,
    lastFailureKind: kind,
    nextAttemptAt: pause === null ? null : new Date(now.getTime() + pause),
    exhaustedAt: pause === null ? now : null,
    updatedAt: now,
  };
  if (row === undefined) {
    await tx.insert(documentRenderFailures).values(
      scoped({ tenantId: o.tenantId, organizationId: o.organizationId }).values({
        ownerType: o.ownerType,
        ownerId: o.ownerId,
        ...state,
        createdAt: now,
      }),
    );
  } else {
    await tx.update(documentRenderFailures).set(state).where(ownRow(o));
  }
  return { attempts, givenUp: pause === null };
}

/** A render succeeded: its failures are forgotten. */
export async function clearRenderFailure(tx: DbTransaction, o: RenderFailureOwner): Promise<void> {
  await lock(tx, o);
  await tx.delete(documentRenderFailures).where(ownRow(o));
}

/**
 * Retry, by a person: a render that was given up starts a fresh set of tries on the next sweep. True when it was given
 * up (and is now cleared); false when there was nothing to retry (never failed, still being tried, or retried already).
 */
export async function retryGivenUpRender(
  tx: DbTransaction,
  o: RenderFailureOwner,
): Promise<{ attempts: number; kind: string } | null> {
  await lock(tx, o);
  const [row] = await tx
    .delete(documentRenderFailures)
    .where(and(ownRow(o), isNotNull(documentRenderFailures.exhaustedAt)))
    .returning({
      attempts: documentRenderFailures.attempts,
      kind: documentRenderFailures.lastFailureKind,
    });
  return row ?? null;
}

/** True when `o`'s render was given up: the screens then show the error with Retry instead of "Preparing PDF". */
export async function renderGivenUp(tx: DbTransaction, o: RenderFailureOwner): Promise<boolean> {
  const [row] = await tx
    .select({ id: documentRenderFailures.id })
    .from(documentRenderFailures)
    .where(and(ownRow(o), isNotNull(documentRenderFailures.exhaustedAt)))
    .limit(1);
  return row !== undefined;
}

/**
 * For a candidate query: the owner in these columns must not be tried now, because its last failure is still waiting
 * out its pause or it was given up. Correlated on tenant, entity and id, like the live-document check.
 */
export function renderHeldBack(
  db: Db,
  ownerType: RenderFailureOwnerType,
  owner: { tenantId: AnyPgColumn; organizationId: AnyPgColumn; id: AnyPgColumn },
  now: Date,
): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(documentRenderFailures)
      .where(
        and(
          eq(documentRenderFailures.tenantId, owner.tenantId),
          eq(documentRenderFailures.organizationId, owner.organizationId),
          eq(documentRenderFailures.ownerType, ownerType),
          eq(documentRenderFailures.ownerId, owner.id),
          or(
            isNotNull(documentRenderFailures.exhaustedAt),
            gt(documentRenderFailures.nextAttemptAt, now),
          ),
        ),
      ),
  );
}

/**
 * Soft-removes document `documentId` of `o` when none of its uploads got bytes (all still awaiting_content): the try
 * that created it failed before storing them, and a live document would keep the owner out of the candidates. The same
 * soft remove as the sweepers' orphan cleanup; a document that got its bytes is left alone.
 */
export async function discardUnfilledDocument(
  tx: DbTransaction,
  o: RenderFailureOwner,
  documentId: string,
  now: Date,
): Promise<void> {
  const filled = tx
    .select({ one: sql`1` })
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.tenantId, o.tenantId),
        eq(documentVersions.documentId, documentId),
        not(eq(documentVersions.status, 'awaiting_content')),
      ),
    );
  await tx
    .update(documents)
    .set({ removedAt: now, updatedAt: now })
    .where(
      and(
        eq(documents.tenantId, o.tenantId),
        eq(documents.organizationId, o.organizationId),
        eq(documents.ownerType, o.ownerType),
        eq(documents.ownerId, o.ownerId),
        eq(documents.id, documentId),
        isNull(documents.removedAt),
        notExists(filled),
      ),
    );
}
