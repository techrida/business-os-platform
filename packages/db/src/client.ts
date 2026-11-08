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
