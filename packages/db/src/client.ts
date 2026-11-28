import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import * as schema from './schema/platform.js';

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  /** The underlying pool, for callers that need a raw client (transactions, health checks). */
  pool: Pool;
  /** Closes every connection. Call it on shutdown. */
  close: () => Promise<void>;
}

/**
 * Pool settings for a long-running process (the API and the worker), pinned by a test. Not the default of
 * `createDb`: a migration or a check script opens one connection and may run a statement for minutes.
 *
 *  - `min`: connections the pool keeps once it has them, so the first request after a quiet spell does not
 *    pay a new TCP and auth handshake. pg-pool never opens them by itself, see `warmPool`.
 *  - `idleTimeoutMillis`: how long an extra connection above `min` may sit idle.
 *  - `statement_timeout`: the server cancels any statement on the pool after this long (SQLSTATE 57014).
 *    `withTx` sets a shorter one for its own transactions.
 *  - `query_timeout`: the client gives up 5 s after the server would have, so a hung socket cannot hold a
 *    caller forever.
 */
export function runtimePoolOptions(
  statementTimeoutMs: number = RUNTIME_STATEMENT_TIMEOUT_MS,
): Omit<PoolConfig, 'connectionString'> {
  return {
    max: 10,
    min: 4,
    idleTimeoutMillis: 300_000,
    // Fail a query that cannot get a connection instead of queueing it forever.
    connectionTimeoutMillis: 5_000,
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs + RUNTIME_QUERY_TIMEOUT_MARGIN_MS,
  };
}

export const RUNTIME_STATEMENT_TIMEOUT_MS = 30_000;
export const RUNTIME_QUERY_TIMEOUT_MARGIN_MS = 5_000;

/** Opens `min` connections at once, so the pool starts warm. Never throws: a database that is down is the pool's problem to report later. */
export async function warmPool(pool: Pool, count: number): Promise<void> {
  const clients = await Promise.allSettled(Array.from({ length: count }, () => pool.connect()));
  for (const client of clients) {
    if (client.status === 'fulfilled') client.value.release();
  }
}

/**
 * Opens a connection pool and wraps it in Drizzle.
 *
 * The API passes DATABASE_URL (the bos_app role: data changes only). Migrations and the tenancy check pass
 * DATABASE_MIGRATE_URL (bos_owner). The URL carries a password, so it is never logged or put in an error.
 */
export function createDb(
  connectionString: string,
  options: Omit<PoolConfig, 'connectionString'> = {},
): DbHandle {
  const pool = new Pool({ max: 10, ...options, connectionString });
  // An idle client can fail (the server restarts, a network blip). Without a listener Node would treat the
  // 'error' event as uncaught and kill the process; with one, the pool just drops the client and reconnects.
  pool.on('error', () => undefined);
  const db = drizzle({ client: pool, schema });
  return { db, pool, close: () => pool.end() };
}
