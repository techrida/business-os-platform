import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { createDb, runtimePoolOptions, warmPool } from '@bos/db';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import { CoreConfig } from '../config/config';
import { MetricsService } from '../obs/metrics.service';
import { configureTx, setTxObserver } from './tx-settings';

/** The raw `pg.Pool`. Use it for health checks and anything drizzle cannot express. */
export const PG_POOL = Symbol('PG_POOL');
/** The drizzle database. Inject with `@Inject(DB) private readonly db: Db`. */
export const DB = Symbol('DB');

export type Db = NodePgDatabase;
/** The `tx` object drizzle hands to a transaction callback. */
export type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Runs `fn` in one transaction: commit if it resolves, roll back if it throws.
 * A thin wrapper so callers never touch the pool and P1 can add tenant-scoping (SET LOCAL) in one place.
 */
export function inTransaction<T>(db: Db, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

/**
 * pg-pool listens for errors only on idle clients. A checked-out client that the server ends while no
 * query runs (idle_in_transaction_session_timeout, an admin kill, a restart) emits 'error' with no
 * listener, which would crash the process. With this listener the error is logged, the client's next
 * query fails, the transaction rejects and the pool discards the client on release.
 */
export function guardClientErrors(pool: Pool): void {
  const logger = new Logger('PgPool');
  pool.on('connect', (client) => {
    client.on('error', (error: Error & { code?: string }) =>
      logger.error(`client error${error.code ? ` (${error.code})` : ''}: ${error.message}`),
    );
  });
}

/** Feeds the pool counts and every withTx's timing to /metrics, where an ObsModule is loaded. */
@Injectable()
export class DbMetrics implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Optional() @Inject(MetricsService) private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.metrics) return;
    this.metrics.observePool(this.pool);
    setTxObserver(this.metrics);
  }

  onApplicationShutdown(): void {
    if (this.metrics) setTxObserver(undefined);
  }
}

/** Connections opened at start and kept: the pool's `min` (runtimePoolOptions). */
const WARM_CONNECTIONS = 4;

/**
 * Warms the pool at start and closes it on shutdown, so the process can exit and Postgres sees clean
 * disconnects. The warm-up does not wait for the database: the boot goes on, and a database that is down
 * shows up on the first real query and on /health, as before.
 */
@Injectable()
export class PoolLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  onModuleInit(): void {
    void warmPool(this.pool, WARM_CONNECTIONS);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Postgres connection from `DATABASE_URL` (the `bos_app` role, which has DML only: schema changes
 * go through the migrate job as `bos_owner`). Global so any module can inject `DB`.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [CoreConfig],
      useFactory: (config: CoreConfig): Pool => {
        configureTx({
          lockTimeoutMs: config.DB_LOCK_TIMEOUT_MS,
          statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
          idleInTxTimeoutMs: config.DB_IDLE_IN_TX_TIMEOUT_MS,
        });
        // The one pool factory (packages/db client.ts): the same options for the API and the worker, with the
        // server-side statement limit that suits each (30 s, 120 s).
        const { pool } = createDb(
          config.DATABASE_URL,
          runtimePoolOptions(config.DB_POOL_STATEMENT_TIMEOUT_MS),
        );
        // An idle client dropping (Postgres restart) emits 'error' on the pool; unhandled it
        // would crash the process. The pool replaces the client on its own.
        pool.on('error', (error) =>
          new Logger('PgPool').error(`idle client error: ${error.message}`),
        );
        guardClientErrors(pool);
        return pool;
      },
    },
    { provide: DB, inject: [PG_POOL], useFactory: (pool: Pool): Db => drizzle({ client: pool }) },
    PoolLifecycle,
    DbMetrics,
  ],
  exports: [PG_POOL, DB],
})
export class DbModule {}
