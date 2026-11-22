// The hard deadline of a guarded identity operation (see withFounderRemovalLease in identity-reconcile.ts). It lives in
// its own module so the ZITADEL client can check it right before every mutating request without importing the
// reconciler.
import { AsyncLocalStorage } from 'node:async_hooks';

import { ServiceUnavailableException } from '@nestjs/common';

/** After this long a guarded operation starts no more provider mutations (a best-effort close is still allowed). */
export const OPERATION_DEADLINE_MS = 60_000;

const operation = new AsyncLocalStorage<{ startedAt: number; deadlineMs: number } | undefined>();

/**
 * Call right before every mutating provider request of a guarded operation: throws 503 once the operation has run past
 * its hard deadline, so nothing new starts while the lease could be about to be taken over. A no-op outside one.
 */
export function assertWithinOperationDeadline(): void {
  const current = operation.getStore();
  if (current && Date.now() - current.startedAt > current.deadlineMs) {
    throw new ServiceUnavailableException('This change took too long. Try again.');
  }
}

export function runWithOperationDeadline<T>(deadlineMs: number, fn: () => Promise<T>): Promise<T> {
  return operation.run({ startedAt: Date.now(), deadlineMs }, fn);
}

/** Runs `fn` with no deadline: the best-effort close after a failure must still run once the deadline has passed. */
export function runOutsideOperationDeadline<T>(fn: () => Promise<T>): Promise<T> {
  return operation.run(undefined, fn);
}
