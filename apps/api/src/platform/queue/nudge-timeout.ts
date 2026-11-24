// A bound on the queue calls a request makes after its transaction committed (the outbox nudge, a render nudge).
// With Valkey down, a bullmq `queue.add` waits on its offline queue instead of failing, so a request whose business
// change already committed would hang with it. The sweep and the 5 s drain are the backstop of every such call, so
// giving up after a short wait loses nothing.
import type { Logger } from '@nestjs/common';

/** How long a post-commit queue call may take before the request stops waiting for it. */
export const NUDGE_TIMEOUT_MS = 1_000;

/**
 * How long an upload waits for its scan enqueue. Longer than a nudge: giving up here discards the upload with a 503,
 * so a slow but reachable Valkey should still get the scan queued.
 */
export const SCAN_ENQUEUE_TIMEOUT_MS = 4_000;

/**
 * Runs `call` and waits for it at most `timeoutMs`. Never throws: a rejection is passed to `onFailure` (when given) and
 * a timeout is logged with `what`; the call itself is left running and its late outcome is ignored.
 */
export async function nudgeWithin(
  log: Logger,
  what: string,
  call: () => Promise<unknown>,
  onFailure?: (error: unknown) => void,
  timeoutMs: number = NUDGE_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const attempt = (async () => {
    try {
      await call();
    } catch (error) {
      if (onFailure === undefined) {
        log.warn(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
      } else onFailure(error);
    }
    return 'done' as const;
  })();
  try {
    if ((await Promise.race([attempt, timedOut])) === 'timeout') {
      log.warn(`${what} timed out after ${timeoutMs} ms, the periodic job is the backstop`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Thrown by `queueCallWithin` when the queue did not answer in time. */
export class QueueCallTimeoutError extends Error {
  override name = 'QueueCallTimeoutError';
  constructor(timeoutMs: number) {
    super(`queue call timed out after ${timeoutMs} ms`);
  }
}

/**
 * Runs a queue call and rejects with QueueCallTimeoutError when it has not settled within `timeoutMs`. For the callers
 * that already handle a failed enqueue (a deferred scan, a logged users.sync): with Valkey down bullmq's `queue.add`
 * holds on its offline queue and never rejects, so without this bound their catch block is never reached and the
 * request hangs. The call keeps running; its late outcome is ignored.
 */
export async function queueCallWithin<T>(
  call: () => Promise<T>,
  timeoutMs: number = NUDGE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<T>((resolve) => resolve(call()));
  pending.catch(() => undefined);
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new QueueCallTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
