import 'reflect-metadata';

import { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { closeQueueQuietly, installTolerantQueueClose } from './queue.module';

describe('closing a queue at shutdown with Valkey away (R6Q24)', () => {
  it('logs a refused close, drops the connection and does not throw', async () => {
    const disconnect = vi.fn(() => Promise.resolve());
    await expect(
      closeQueueQuietly(
        () =>
          Promise.reject(
            new Error("Stream isn't writeable and enableOfflineQueue options is false"),
          ),
        disconnect,
      ),
    ).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not drop the connection when the close worked', async () => {
    const disconnect = vi.fn(() => Promise.resolve());
    await closeQueueQuietly(() => Promise.resolve(), disconnect);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('survives a disconnect that fails too', async () => {
    await expect(
      closeQueueQuietly(
        () => Promise.reject(new Error('refused')),
        () => Promise.reject(new Error('gone')),
      ),
    ).resolves.toBeUndefined();
  });

  it('is installed on bullmq Queue.close, once, so the queues @nestjs/bullmq closes are covered', async () => {
    installTolerantQueueClose();
    const patched = Queue.prototype.close;
    installTolerantQueueClose();
    expect(Queue.prototype.close).toBe(patched);
    // A queue whose close breaks (this object has no connection at all): the shutdown still goes through.
    const broken = Object.create(Queue.prototype) as Queue;
    const disconnect = vi.fn(() => Promise.resolve());
    broken.disconnect = disconnect;
    await expect(broken.close()).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalled();
  });
});
