import { EventEmitter } from 'node:events';

import pg from 'pg';

/**
 * Test-only. Every test file drops its throw-away database with `DROP DATABASE ... WITH (FORCE)` while its pools
 * may still be closing. Postgres then sends FATAL 57P01 ("terminating connection due to administrator command")
 * to a pooled client: an idle one reaches its pool, and a checked-out one has no listener at all (pg-pool removes
 * its own while the client is lent out). With no 'error' listener Node rethrows it as an uncaught exception, and
 * vitest fails the whole run although every test passed (GitHub runs 45135113457, 45145601781, 45151536700).
 * Only that code, only on an emitter nobody listens to, is dropped; any other error still surfaces.
 */
type Emit = (this: EventEmitter, event: string | symbol, ...args: unknown[]) => boolean;

function ignoreTerminatedByAdmin(target: EventEmitter): void {
  const original = Reflect.get(target, 'emit') as Emit;
  const patched: Emit = function patchedEmit(this, event, ...args) {
    if (event === 'error' && this.listenerCount('error') === 0) {
      const error = args[0] as { code?: string } | undefined;
      if (error?.code === '57P01') return false;
    }
    return original.call(this, event, ...args);
  };
  Reflect.set(target, 'emit', patched);
}

ignoreTerminatedByAdmin(pg.Pool.prototype);
ignoreTerminatedByAdmin(pg.Client.prototype);
