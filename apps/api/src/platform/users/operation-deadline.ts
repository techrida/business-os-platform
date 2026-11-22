// The hard deadline of a guarded identity operation (see withFounderRemovalLease in identity-reconcile.ts). It lives in
// its own module so the ZITADEL client can check it right before every mutating request without importing the
// reconciler.
import { AsyncLocalStorage } from 'node:async_hooks';

import { ServiceUnavailableException } from '@nestjs/common';

/** After this long a guarded operation starts no more provider mutations (a best-effort close is still allowed). */
export const OPERATION_DEADLINE_MS = 60_000;

interface OperationClock {
  startedAt: number;
  deadlineMs: number;
  /**
   * The lease fence: past this time (Date.now()) no provider mutation starts at all, the best-effort close included,
   * because the tenant's lease may be about to pass to another holder. Undefined outside a lease.
   */
  fenceAt?: number;
}

const operation = new AsyncLocalStorage<OperationClock | undefined>();

/**
 * Call right before every mutating provider request of a guarded operation: throws 503 once the operation has run past
 * its hard deadline or its lease fence, so nothing new starts while the lease could be about to be taken over. A no-op
 * outside one.
 */
export function assertWithinOperationDeadline(): void {
  const current = operation.getStore();
  if (!current) return;
  const now = Date.now();
  if (
    now - current.startedAt > current.deadlineMs ||
    (current.fenceAt !== undefined && now > current.fenceAt)
  ) {
    throw new ServiceUnavailableException('This change took too long. Try again.');
  }
}

export function runWithOperationDeadline<T>(
  deadlineMs: number,
  fn: () => Promise<T>,
  fenceAt?: number,
): Promise<T> {
  const clock: OperationClock = { startedAt: Date.now(), deadlineMs };
  if (fenceAt !== undefined) clock.fenceAt = fenceAt;
  return operation.run(clock, fn);
}

/**
 * Runs `fn` with no deadline: the best-effort close after a failure must still run once the deadline has passed. The
 * lease fence stays: a holder whose lease may already belong to someone else starts no provider call.
 */
export function runOutsideOperationDeadline<T>(fn: () => Promise<T>): Promise<T> {
  const fenceAt = operation.getStore()?.fenceAt;
  return operation.run(
    fenceAt === undefined
      ? undefined
      : { startedAt: Date.now(), deadlineMs: Number.POSITIVE_INFINITY, fenceAt },
    fn,
  );
}
