import 'reflect-metadata';

import { Queue } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { NUDGE_TIMEOUT_MS, QueueCallTimeoutError, queueCallWithin } from './nudge-timeout';
import { redisOptionsFromUrl } from './redis-options';

describe('queueCallWithin', () => {
  it('passes the value through', async () => {
    await expect(queueCallWithin(() => Promise.resolve(7))).resolves.toBe(7);
  });

  it('passes a rejection through', async () => {
    await expect(queueCallWithin(() => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
  });

  it('rejects with QueueCallTimeoutError when the call never settles', async () => {
    const started = Date.now();
    await expect(queueCallWithin(() => new Promise(() => undefined), 50)).rejects.toBeInstanceOf(
      QueueCallTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  // The real thing the helper exists for: bullmq against a Valkey that is not there. Port 1 refuses connections,
  // and bullmq keeps the `add` waiting for the connection instead of failing it.
  it('bounds a real bullmq queue.add against an unreachable Valkey', async () => {
    const queue = new Queue('r6q21-valkey-down', {
      connection: {
        ...(redisOptionsFromUrl('redis://127.0.0.1:1') as RedisOptions),
        retryStrategy: () => 200,
      },
    });
    queue.on('error', () => undefined);
    try {
      const started = Date.now();
      await expect(queueCallWithin(() => queue.add('job', { a: 1 }))).rejects.toBeInstanceOf(
        QueueCallTimeoutError,
      );
      expect(Date.now() - started).toBeLessThan(NUDGE_TIMEOUT_MS + 1_000);
    } finally {
      await queue.close().catch(() => undefined);
    }
  }, 15_000);
});
