import 'reflect-metadata';

import { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { QueueCallTimeoutError, queueCallWithin } from './nudge-timeout';
import { redisOptionsFromUrl } from './redis-options';

describe('queueCallWithin', () => {
  it('passes the value through', async () => {
    await expect(queueCallWithin(() => Promise.resolve(7))).resolves.toBe(7);
  });

  it('passes a rejection through', async () => {
    await expect(queueCallWithin(() => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
  });

  it('rejects with QueueCallTimeoutError exactly when the bound passes', async () => {
    vi.useFakeTimers();
    try {
      let outcome: unknown = 'pending';
      const call = queueCallWithin(() => new Promise(() => undefined), 50).catch(
        (error: unknown) => {
          outcome = error;
        },
      );
      await vi.advanceTimersByTimeAsync(49);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      await call;
      expect(outcome).toBeInstanceOf(QueueCallTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  // The real thing the helper exists for: bullmq against a Valkey that is not there. Port 1 refuses connections,
  // and bullmq keeps the `add` waiting for the connection instead of failing it.
  it('bounds a real bullmq queue.add against an unreachable Valkey', async () => {
    const queue = new Queue('r6q21-valkey-down', {
      connection: {
        ...redisOptionsFromUrl('redis://127.0.0.1:1'),
        retryStrategy: () => 200,
      },
    });
    queue.on('error', () => undefined);
    try {
      // A short bound, and no wall-clock assertion: that the call rejects at all, instead of hanging until the test
      // times out, is what proves it is bounded. The default bound is covered by the fake-timer test above.
      await expect(queueCallWithin(() => queue.add('job', { a: 1 }), 100)).rejects.toBeInstanceOf(
        QueueCallTimeoutError,
      );
    } finally {
      await queue.close().catch(() => undefined);
    }
  }, 15_000);
});
