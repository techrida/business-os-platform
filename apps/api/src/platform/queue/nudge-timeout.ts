// A bound on the queue calls a request makes after its transaction committed (the outbox nudge, a render nudge).
// With Valkey down, a bullmq `queue.add` waits on its offline queue instead of failing, so a request whose business
// change already committed would hang with it. The sweep and the 5 s drain are the backstop of every such call, so
// giving up after a short wait loses nothing.
import type { Logger } from '@nestjs/common';

/** How long a post-commit queue call may take before the request stops waiting for it. */
export const NUDGE_TIMEOUT_MS = 1_000;

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
