import pg from 'pg';

/**
 * Test-only. Every test file drops its throw-away database with `DROP DATABASE ... WITH (FORCE)` while its pools
 * may still be closing. Postgres then sends FATAL 57P01 ("terminating connection due to administrator command") to
 * an idle pooled client. A pool with no 'error' listener rethrows that as an unhandled error, and vitest fails the
 * whole run although every test passed (GitHub runs 45135113457 and 45145601781, a different file each time).
 * Only that code, only on a pool nobody listens to, is dropped; any other pool error still surfaces.
 */
const emit = pg.Pool.prototype.emit;
pg.Pool.prototype.emit = function patchedEmit(
  this: InstanceType<typeof pg.Pool>,
  event: string | symbol,
  ...args: unknown[]
) {
  if (event === 'error' && this.listenerCount('error') === 0) {
    const error = args[0] as { code?: string } | undefined;
    if (error?.code === '57P01') return false;
  }
  return emit.call(this, event, ...args);
} as typeof emit;
