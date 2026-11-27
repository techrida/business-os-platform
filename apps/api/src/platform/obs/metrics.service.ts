import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import type { DbBusyKind } from '../db/busy';

/**
 * Buckets are chosen so the NFR thresholds (300 ms, 500 ms, 800 ms) are bucket edges: a
 * percentile read from the histogram is then exact at those points instead of interpolated.
 */
export const HTTP_DURATION_BUCKETS = [0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1, 2, 5] as const;
export const LCP_BUCKETS = [0.5, 1, 1.5, 2, 2.5, 4, 8] as const;
/** Setup is pool checkout + BEGIN + the settings statement, so a slow one means the pool is short. */
export const TX_SETUP_BUCKETS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5,
] as const;
/** Lock waits are mostly zero; the upper edges show a queue behind one tenant (lock_timeout is 5 s). */
export const TENANT_LOCK_WAIT_BUCKETS = [
  0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
] as const;
export const TX_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30,
] as const;

/** The counters a `pg.Pool` exposes; read at scrape time. */
export interface PoolStats {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

/**
 * The one place that knows prom-client. If we ever move to OpenTelemetry metrics, only this
 * file changes (prom-client has had no npm release since mid-2024).
 *
 * It owns a private Registry rather than using prom-client's global one: several Nest apps can
 * live in one process (tests do this) and the global registry throws on a duplicate name.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  private readonly httpDuration = new Histogram({
    name: 'http_server_request_duration_seconds',
    help: 'HTTP server request duration in seconds, by Nest route template.',
    labelNames: ['method', 'route', 'status_class'] as const,
    buckets: [...HTTP_DURATION_BUCKETS],
    registers: [this.registry],
  });

  private readonly lcp = new Histogram({
    name: 'web_vitals_lcp_seconds',
    help: 'Largest Contentful Paint reported by the browser, in seconds.',
    labelNames: ['app', 'route'] as const,
    buckets: [...LCP_BUCKETS],
    registers: [this.registry],
  });

  private readonly heartbeat = new Gauge({
    name: 'worker_last_heartbeat_seconds',
    help: 'Unix time of the last system.heartbeat job the worker processed (0 in the API).',
    registers: [this.registry],
  });

  private pool: PoolStats | undefined;

  private readonly poolTotal = new Gauge({
    name: 'db_pool_connections',
    help: 'Open connections in the Postgres pool (idle and checked out).',
    registers: [this.registry],
    collect: () => {
      if (this.pool) this.poolTotal.set(this.pool.totalCount);
    },
  });

  private readonly poolIdle = new Gauge({
    name: 'db_pool_idle_connections',
    help: 'Idle connections in the Postgres pool.',
    registers: [this.registry],
    collect: () => {
      if (this.pool) this.poolIdle.set(this.pool.idleCount);
    },
  });

  private readonly poolWaiting = new Gauge({
    name: 'db_pool_waiting_clients',
    help: 'Queries waiting for a free Postgres pool connection.',
    registers: [this.registry],
    collect: () => {
      if (this.pool) this.poolWaiting.set(this.pool.waitingCount);
    },
  });

  private readonly dbBusy = new Counter({
    name: 'db_busy_errors_total',
    help: 'Transactions Postgres ended as a deadlock victim, after a lock_timeout or after a statement_timeout, by kind.',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  private readonly txSetup = new Histogram({
    name: 'db_tx_setup_seconds',
    help: 'Time from withTx being called to its settings statement done: pool wait + BEGIN + SET.',
    buckets: [...TX_SETUP_BUCKETS],
    registers: [this.registry],
  });

  private readonly txDuration = new Histogram({
    name: 'db_tx_duration_seconds',
    help: 'Whole withTx duration in seconds, including lock waits, by outcome.',
    labelNames: ['outcome'] as const,
    buckets: [...TX_DURATION_BUCKETS],
    registers: [this.registry],
  });

  private readonly tenantLockWait = new Histogram({
    name: 'db_tenant_lock_wait_seconds',
    help: 'Time a transaction waited for its tenant audit-chain advisory lock (OQ-R7-02: is the per-write hash worth moving).',
    buckets: [...TENANT_LOCK_WAIT_BUCKETS],
    registers: [this.registry],
  });

  private lastHeartbeat = 0;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  /**
   * `route` must be the Nest route template (`/v1/things/:id`), never the raw URL: a raw URL
   * gives every id its own time series and exhausts Prometheus memory.
   */
  observeHttp(method: string, route: string, statusCode: number, seconds: number): void {
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    this.httpDuration.observe({ method, route, status_class: statusClass }, seconds);
  }

  observeWebVitalLcp(app: string, route: string, seconds: number): void {
    this.lcp.observe({ app, route }, seconds);
  }

  /** The pool whose counts the db_pool_* gauges report at each scrape. */
  observePool(pool: PoolStats): void {
    this.pool = pool;
  }

  observeTx(
    outcome: 'commit' | 'rollback',
    setupSeconds: number | undefined,
    totalSeconds: number,
  ): void {
    if (setupSeconds !== undefined) this.txSetup.observe(setupSeconds);
    this.txDuration.observe({ outcome }, totalSeconds);
  }

  countDbBusy(kind: DbBusyKind): void {
    this.dbBusy.inc({ kind });
  }

  observeTenantLockWait(seconds: number): void {
    this.tenantLockWait.observe(seconds);
  }

  recordHeartbeat(epochSeconds: number): void {
    this.lastHeartbeat = epochSeconds;
    this.heartbeat.set(epochSeconds);
  }

  get lastHeartbeatSeconds(): number {
    return this.lastHeartbeat;
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
