import type { Redis } from 'ioredis';

/**
 * Readiness and failure classification for the workspace's Valkey clients (sessions and OIDC
 * state). No `server-only` import: the login rate limiter uses it from a Route Handler module that
 * tests load without the react-server condition.
 */

/** How long a command waits, by default, for a client that is still connecting. */
export const CONNECT_WAIT_MS = 1000;
const CONNECTING_STATES: ReadonlySet<string> = new Set(['connecting', 'connect', 'reconnecting']);

/**
 * Resolves once `client` is ready, or after `maxWaitMs`, whichever comes first. Without the
 * offline queue ioredis rejects any command sent while it is still connecting, which would fail
 * the first request after every start (the clients connect lazily, on first use) and the first
 * request after a dropped connection. A client that is still not ready after the wait gets the
 * command anyway and fails fast.
 */
export function whenReady(client: Redis, maxWaitMs: number = CONNECT_WAIT_MS): Promise<Redis> {
  if (!CONNECTING_STATES.has(client.status) || maxWaitMs <= 0) return Promise.resolve(client);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      client.off('ready', done);
      resolve(client);
    };
    const timer = setTimeout(done, maxWaitMs);
    client.once('ready', done);
  });
}

/** What a log line may say about a failure. Never the message: ioredis puts command arguments in it. */
export type ValkeyErrorCategory = 'timeout' | 'connection' | 'other';

/** Thrown by `withDeadline`; carries no command or key. */
export class ValkeyDeadlineError extends Error {
  override name = 'ValkeyDeadlineError';
  constructor() {
    super('Valkey deadline exceeded');
  }
}

const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * Maps an error to an allow-listed category. Reads the error's name, code and message only to
 * classify; none of them is returned or logged.
 */
export function errorCategory(err: unknown): ValkeyErrorCategory {
  if (!(err instanceof Error)) return 'other';
  if (err instanceof ValkeyDeadlineError || /command timed out/i.test(err.message)) {
    return 'timeout';
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && CONNECTION_CODES.has(code)) return 'connection';
  if (err.name === 'MaxRetriesPerRequestError') return 'connection';
  if (
    /connection is closed|stream isn't writeable|enableOfflineQueue|ECONNREFUSED|ECONNRESET|EPIPE/i.test(
      err.message,
    )
  ) {
    return 'connection';
  }
  return 'other';
}

const CLIENT_STATES: ReadonlySet<string> = new Set([
  'wait',
  'connecting',
  'connect',
  'ready',
  'reconnecting',
  'close',
  'end',
]);

/** The client's connection state, from ioredis's fixed set; anything else logs as 'unknown'. */
export function clientStatus(client: Redis | undefined): string {
  const status = client?.status;
  return typeof status === 'string' && CLIENT_STATES.has(status) ? status : 'unknown';
}

/**
 * Rejects with ValkeyDeadlineError if `promise` has not settled within `ms`. The original promise
 * keeps running; its later rejection is swallowed so it never surfaces as unhandled.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => undefined);
  if (ms <= 0) return Promise.reject(new ValkeyDeadlineError());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ValkeyDeadlineError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error('non-error rejection'));
      },
    );
  });
}
