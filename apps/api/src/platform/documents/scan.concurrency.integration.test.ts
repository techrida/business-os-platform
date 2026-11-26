// The docs.scan worker runs three files at a time. A real BullMQ worker over a real Valkey (Testcontainers),
// built from the options the @Processor decorator declares, with the scan itself replaced by a 200 ms wait.
// Run with: pnpm --filter @bos/api exec vitest run src/platform/documents/scan.concurrency.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { Queue, QueueEvents, Worker, type WorkerOptions } from 'bullmq';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { redisOptionsFromUrl } from '../queue/redis-options';
import { DOCS_SCAN_JOB, type ScanJobData } from './documents.ports';
import { ScanProcessor } from './scan.processor';

// @nestjs/bullmq keeps the options of `@Processor(queue, options)` under this key (bull.constants.js).
const WORKER_METADATA = 'bullmq:worker_metadata';
const SCAN_MS = 200;

describe('docs.scan queue concurrency', () => {
  let container: StartedTestContainer;
  let connection: ReturnType<typeof redisOptionsFromUrl>;

  beforeAll(async () => {
    container = await new GenericContainer('valkey/valkey:9.1-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    connection = redisOptionsFromUrl(
      `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    );
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it('declares a concurrency of 3 on the processor', () => {
    const declared = Reflect.getMetadata(WORKER_METADATA, ScanProcessor) as
      | Partial<WorkerOptions>
      | undefined;
    expect(declared?.concurrency).toBe(3);
  });

  it('scans six files that take 200 ms each in about two rounds, three at a time', async () => {
    const declared = Reflect.getMetadata(WORKER_METADATA, ScanProcessor) as Partial<WorkerOptions>;
    const processor = new ScanProcessor(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    let active = 0;
    let peak = 0;
    vi.spyOn(processor, 'scanVersion').mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, SCAN_MS));
      active -= 1;
      return 'clean';
    });

    const queue = new Queue(`it-scan-${randomUUID()}`, { connection });
    const events = new QueueEvents(queue.name, { connection });
    const worker = new Worker(queue.name, (job) => processor.process(job), {
      ...declared,
      connection,
    });
    try {
      await events.waitUntilReady();
      await worker.waitUntilReady();
      const data = (): ScanJobData => ({
        versionId: randomUUID(),
        tenantId: randomUUID(),
        organizationId: randomUUID(),
      });
      const started = performance.now();
      const jobs = await Promise.all(
        Array.from({ length: 6 }, () => queue.add(DOCS_SCAN_JOB, data())),
      );
      await Promise.all(jobs.map((job) => job.waitUntilFinished(events, 10_000)));
      const elapsed = performance.now() - started;

      expect(peak).toBe(3);
      // One at a time it is 6 x 200 = 1200 ms; three at a time it is two rounds, about 400 ms plus queue round trips.
      expect(elapsed).toBeLessThan(900);
    } finally {
      await worker.close();
      await events.close();
      await queue.close();
    }
  });
});
