import { Injectable } from '@nestjs/common';

import type { HealthReport } from '../obs/metrics.server';
import { MetricsService } from '../obs/metrics.service';
import { HEARTBEAT_STALE_AFTER_MS } from './queue.constants';

/**
 * Pure rule, split out so it is testable without a clock or Valkey.
 * Healthy while a heartbeat arrived recently. Before the first heartbeat, the start time counts
 * as the last sign of life, which gives a fresh worker a grace period of one stale window.
 */
export function workerHealth(input: {
  nowMs: number;
  startedAtMs: number;
  lastHeartbeatMs: number;
  staleAfterMs?: number;
}): HealthReport {
  const { nowMs, startedAtMs, lastHeartbeatMs, staleAfterMs = HEARTBEAT_STALE_AFTER_MS } = input;
  const lastSignOfLife = Math.max(startedAtMs, lastHeartbeatMs);
  const silentForMs = nowMs - lastSignOfLife;
  return {
    ok: silentForMs < staleAfterMs,
    detail: { lastHeartbeatMs: lastHeartbeatMs === 0 ? null : lastHeartbeatMs, silentForMs },
  };
}

/** What `GET :9465/health` answers for the worker's container healthcheck. */
@Injectable()
export class WorkerHealth {
  private readonly startedAtMs = Date.now();

  constructor(private readonly metrics: MetricsService) {}

  report(): HealthReport {
    return workerHealth({
      nowMs: Date.now(),
      startedAtMs: this.startedAtMs,
      lastHeartbeatMs: this.metrics.lastHeartbeatSeconds * 1000,
    });
  }
}
