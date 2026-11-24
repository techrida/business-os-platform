import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import {
  HealthCheckService,
  type HealthCheckResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { Queue } from 'bullmq';
import { Pool } from 'pg';

import { PG_POOL } from '../db/db.module';
import { SYSTEM_QUEUE } from '../queue/queue.constants';
import { JwksStatus } from './jwks-status';

/** Each dependency gets this long to answer. A hung dependency must read as "down", not hang the probe. */
export const CHECK_TIMEOUT_MS = 2_000;

/**
 * Liveness and readiness. Kept apart from the controller so it can be tested without the
 * auth module (the controller imports `@Public()` from it).
 *
 * - live: the process answers. No dependency is checked, so a Postgres outage never makes the
 *   orchestrator restart a healthy API.
 * - ready: Postgres `select 1`, a Valkey ping and "JWKS loaded at least once". Any failure gives
 *   503 with the per-dependency result.
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @InjectQueue(SYSTEM_QUEUE) private readonly queue: Queue,
    private readonly jwks: JwksStatus,
  ) {}

  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () =>
        this.indicator
          .check('db')
          .attempt(async () => {
            await this.pool.query('select 1');
          })
          .withTimeout(CHECK_TIMEOUT_MS),
      () =>
        this.indicator
          .check('valkey')
          .attempt(async () => {
            // The queue's own connection answers; no second client is opened just for health.
            // BullMQ 6 no longer exposes `queue.client`: the raw client sits on the backend's connection.
            const client = (await this.queue.getBackend().connection.client) as unknown as {
              ping(): Promise<string>;
            };
            await client.ping();
          })
          .withTimeout(CHECK_TIMEOUT_MS),
      () =>
        this.indicator
          .check('jwks')
          .attempt(async () => {
            if (!(await this.jwks.isJwksReady())) throw new Error('signing keys not loaded yet');
          })
          .withTimeout(CHECK_TIMEOUT_MS),
    ]);
  }
}
