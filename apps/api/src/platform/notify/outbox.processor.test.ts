// Unit tests for the outbox processor, its scheduler and the dead-letter metric (no database, no Valkey).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/notify/outbox.processor.test.ts
// The drain logic itself is tested against a real Postgres in outbox.drainer.integration.test.ts.
import { type Job, type Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { MetricsService } from '../obs/metrics.service';
import { NotifyMetrics } from './notify-metrics';
import { OUTBOX_DRAIN_JOB } from './notify.constants';
import { type OutboxDrainer } from './outbox.drainer';
import { OutboxDrainScheduler, OutboxProcessor } from './outbox.processor';

const job = (name: string): Job => ({ name }) as Job;

describe('OutboxProcessor', () => {
  it('runs one drain pass for a drain job', async () => {
    const drainOnce = vi.fn().mockResolvedValue({ claimed: 0, sent: 0, failed: 0, dead: 0 });
    const processor = new OutboxProcessor({ drainOnce } as unknown as OutboxDrainer);

    await processor.process(job(OUTBOX_DRAIN_JOB));

    expect(drainOnce).toHaveBeenCalledTimes(1);
  });

  it('fails a job it does not know, so the bug stays visible', async () => {
    const drainOnce = vi.fn();
    const processor = new OutboxProcessor({ drainOnce } as unknown as OutboxDrainer);

    await expect(processor.process(job('outbox.mystery'))).rejects.toThrow(
      'Unknown outbox job: outbox.mystery',
    );
    expect(drainOnce).not.toHaveBeenCalled();
  });

  it('lets a drain error fail the job so BullMQ records it', async () => {
    const drainOnce = vi.fn().mockRejectedValue(new Error('database down'));
    const processor = new OutboxProcessor({ drainOnce } as unknown as OutboxDrainer);

    await expect(processor.process(job(OUTBOX_DRAIN_JOB))).rejects.toThrow('database down');
  });
});

describe('OutboxDrainScheduler', () => {
  it('upserts one 5 s repeating drain job on module init', async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    const scheduler = new OutboxDrainScheduler({ upsertJobScheduler } as unknown as Queue);

    await scheduler.onModuleInit();

    expect(upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      'outbox.drain.every-5s',
      { every: 5000 },
      expect.objectContaining({ name: OUTBOX_DRAIN_JOB }),
    );
  });
});

describe('NotifyMetrics', () => {
  it('counts dead letters on the shared registry', async () => {
    const service = new MetricsService();
    const metrics = new NotifyMetrics(service);

    metrics.recordDeadLetter();
    metrics.recordDeadLetter();

    expect(await service.render()).toMatch(/^outbox_dead_letters_total 2$/m);
  });
});
