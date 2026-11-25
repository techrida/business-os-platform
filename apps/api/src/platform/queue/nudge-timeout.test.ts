import 'reflect-metadata';

import { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import {
  isStreamNotWriteable,
  QueueCallTimeoutError,
  queueCallWithin,
  retryWhileNotWriteable,
} from './nudge-timeout';
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

describe('retryWhileNotWriteable (R6Q24: a short Valkey reconnect must not defer the scan)', () => {
  const refused = () => new Error("Stream isn't writeable and enableOfflineQueue options is false");

  it('recognises the ioredis refusal and nothing else', () => {
    expect(isStreamNotWriteable(refused())).toBe(true);
    expect(isStreamNotWriteable(new Error('Connection is closed.'))).toBe(false);
    expect(isStreamNotWriteable("Stream isn't writeable")).toBe(false);
  });

  it('tries again after a refusal and returns the value of the first call that works', async () => {
    vi.useFakeTimers();
    try {
      const call = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(refused())
        .mockRejectedValueOnce(refused())
        .mockResolvedValue('queued');
      const result = retryWhileNotWriteable(call, 4_000);
      await vi.advanceTimersByTimeAsync(200);
      await expect(result).resolves.toBe('queued');
      expect(call).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws any other error at once, without a second try', async () => {
    const call = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('WRONGTYPE'));
    await expect(retryWhileNotWriteable(call, 4_000)).rejects.toThrow('WRONGTYPE');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('gives up with the last refusal when the deadline passes', async () => {
    vi.useFakeTimers();
    try {
      const call = vi
        .fn<() => Promise<string>>()
        .mockImplementation(() => Promise.reject(refused()));
      let outcome: unknown = 'pending';
      const result = retryWhileNotWriteable(call, 1_000).catch((e: unknown) => {
        outcome = e;
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(600);
      await result;
      expect(isStreamNotWriteable(outcome)).toBe(true);
      expect(call.mock.calls.length).toBeGreaterThan(5);
      expect(call.mock.calls.length).toBeLessThanOrEqual(11);
    } finally {
      vi.useRealTimers();
    }
  });
});
