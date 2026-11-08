// Unit test for NotifyService.nudge with a fake queue (no Valkey, no database). The write path and the
// reads are covered by notify.service.integration.test.ts. nudge is the one method that must never throw:
// it runs after a commit, where an exception would turn a successful request into an error.
import type { Queue } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDirectory } from '../authz/user-directory';
import type { CoreConfig } from '../config/config';
import type { Db } from '../db/db.module';
import { OUTBOX_DRAIN_JOB, OUTBOX_QUEUE } from './notify.constants';
import { NotifyService } from './notify.service';

function serviceWith(queue: { add: ReturnType<typeof vi.fn> }): NotifyService {
  return new NotifyService(
    {} as Db,
    { WORKSPACE_PUBLIC_URL: 'https://app.example.com' } as CoreConfig,
    {} as UserDirectory,
    queue as unknown as Queue,
  );
}

describe('notify constants', () => {
  it('match the names the drainer and the plan use', () => {
    expect(OUTBOX_QUEUE).toBe('outbox');
    expect(OUTBOX_DRAIN_JOB).toBe('outbox.drain');
  });
});

describe('NotifyService.nudge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds outbox.drain with a per-second job id and removes the job when it ends', async () => {
    // 2025-01-01T00:00:10.900Z is epoch second 1735689610 (the fraction is dropped).
    vi.setSystemTime(new Date('2025-01-01T00:00:10.900Z'));
    const queue = { add: vi.fn().mockResolvedValue(undefined) };

    await serviceWith(queue).nudge();

    expect(queue.add).toHaveBeenCalledExactlyOnceWith(
      'outbox.drain',
      {},
      { jobId: 'outbox.drain-1735689610', removeOnComplete: true, removeOnFail: true },
    );
  });

  it('uses a new job id in the next second', async () => {
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const service = serviceWith(queue);

    vi.setSystemTime(new Date('2025-01-01T00:00:10.000Z'));
    await service.nudge();
    vi.setSystemTime(new Date('2025-01-01T00:00:11.000Z'));
    await service.nudge();

    const jobIds = queue.add.mock.calls.map((c) => (c[2] as { jobId: string }).jobId);
    expect(jobIds).toEqual(['outbox.drain-1735689610', 'outbox.drain-1735689611']);
  });

  it('swallows a queue error: the repeatable drain is the backstop', async () => {
    const queue = { add: vi.fn().mockRejectedValue(new Error('valkey is down')) };

    await expect(serviceWith(queue).nudge()).resolves.toBeUndefined();
    expect(queue.add).toHaveBeenCalledOnce();
  });
});
