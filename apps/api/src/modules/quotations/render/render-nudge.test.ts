// enqueueRenderOne is awaited by the request after its commit, so it must come back even when Valkey is down and
// bullmq's `queue.add` never answers; the sweep renders the document anyway.
import type { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enqueueRenderOne } from './render-nudge';

const job = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  id: '33333333-3333-4333-8333-333333333333',
};

describe('enqueueRenderOne', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds the job under the job-name-and-document id', async () => {
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const log = { warn: vi.fn() };

    await enqueueRenderOne(
      queue as unknown as Queue,
      log as unknown as Logger,
      'x.render.one',
      job,
    );

    expect(queue.add).toHaveBeenCalledExactlyOnceWith('x.render.one', job, {
      jobId: `x.render.one-${job.id}`,
      removeOnComplete: true,
      removeOnFail: true,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs and returns when the queue rejects', async () => {
    const queue = { add: vi.fn().mockRejectedValue(new Error('valkey is down')) };
    const log = { warn: vi.fn() };

    await expect(
      enqueueRenderOne(queue as unknown as Queue, log as unknown as Logger, 'x.render.one', job),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('valkey is down'));
  });

  it('gives up after about a second, logging the timeout, when the queue never answers', async () => {
    const queue = { add: vi.fn().mockReturnValue(new Promise(() => undefined)) };
    const log = { warn: vi.fn() };
    let settled = false;

    const done = enqueueRenderOne(
      queue as unknown as Queue,
      log as unknown as Logger,
      'x.render.one',
      job,
    ).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await done;

    expect(settled).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });
});
