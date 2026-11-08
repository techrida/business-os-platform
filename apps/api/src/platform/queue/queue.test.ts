import 'reflect-metadata';

import { describe, expect, it, vi } from 'vitest';

import { MetricsService } from '../obs/metrics.service';
import { HEARTBEAT_JOB } from './queue.constants';
import { redisOptionsFromUrl } from './redis-options';
import { HeartbeatScheduler, SystemProcessor } from './system.processor';
import { workerHealth } from './worker-health';

describe('redisOptionsFromUrl', () => {
  it('splits host, port and defaults', () => {
    expect(redisOptionsFromUrl('redis://valkey:6379')).toEqual({ host: 'valkey', port: 6379 });
    expect(redisOptionsFromUrl('redis://valkey')).toEqual({ host: 'valkey', port: 6379 });
  });

  it('reads credentials, database and TLS', () => {
    expect(redisOptionsFromUrl('rediss://user:p%40ss@cache.example.com:6380/2')).toEqual({
      host: 'cache.example.com',
      port: 6380,
      username: 'user',
      password: 'p@ss',
      db: 2,
      tls: {},
    });
  });
});

describe('SystemProcessor', () => {
  it('records the heartbeat in the gauge', async () => {
    const metrics = new MetricsService();
    const processor = new SystemProcessor(metrics);
    const before = Date.now() / 1000;
    await processor.process({ name: HEARTBEAT_JOB } as never);
    expect(metrics.lastHeartbeatSeconds).toBeGreaterThanOrEqual(before);
    expect(await metrics.render()).toMatch(/^worker_last_heartbeat_seconds \d+/m);
  });

  it('rejects an unknown job instead of dropping it', async () => {
    const processor = new SystemProcessor(new MetricsService());
    await expect(processor.process({ name: 'system.nope' } as never)).rejects.toThrow(
      'Unknown system job',
    );
  });
});

describe('HeartbeatScheduler', () => {
  it('upserts one repeating system.heartbeat scheduler', async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    await new HeartbeatScheduler({ upsertJobScheduler } as never).onApplicationBootstrap();
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      HEARTBEAT_JOB,
      { every: 15_000 },
      expect.objectContaining({ name: HEARTBEAT_JOB }),
    );
  });
});

describe('workerHealth', () => {
  const start = 1_000_000;

  it('is healthy during the grace period before the first heartbeat', () => {
    expect(workerHealth({ nowMs: start + 30_000, startedAtMs: start, lastHeartbeatMs: 0 }).ok).toBe(
      true,
    );
  });

  it('is unhealthy when no heartbeat ever arrived after the stale window', () => {
    expect(workerHealth({ nowMs: start + 61_000, startedAtMs: start, lastHeartbeatMs: 0 }).ok).toBe(
      false,
    );
  });

  it('is healthy with a recent heartbeat and unhealthy when it goes stale', () => {
    const beat = start + 100_000;
    expect(
      workerHealth({ nowMs: beat + 20_000, startedAtMs: start, lastHeartbeatMs: beat }).ok,
    ).toBe(true);
    expect(
      workerHealth({ nowMs: beat + 61_000, startedAtMs: start, lastHeartbeatMs: beat }).ok,
    ).toBe(false);
  });
});
