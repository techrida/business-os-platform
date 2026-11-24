import { randomUUID } from 'node:crypto';

import { Queue, QueueEvents, Worker } from 'bullmq';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LIVE_STATES } from '../documents/scan.processor';
import { redisOptionsFromUrl } from './redis-options';

/**
 * BullMQ 6 over ioredis 6 (RESP3) against the Valkey the stack ships: the readiness ping, a job
 * through a worker, a job scheduler, and the sweeper's "live jobs" lookup on a paused queue.
 */
describe('BullMQ 6 against a real Valkey', () => {
  let container: StartedTestContainer;
  let connection: ReturnType<typeof redisOptionsFromUrl>;
  const queues: Queue[] = [];

  const newQueue = (): Queue => {
    const queue = new Queue(`it-${randomUUID()}`, { connection });
    queues.push(queue);
    return queue;
  };

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
    await Promise.all(queues.map((q) => q.close()));
    await container?.stop();
  });

  it('answers the readiness ping through the queue backend connection', async () => {
    const queue = newQueue();
    const client = (await queue.getBackend().connection.client) as unknown as {
      ping(): Promise<string>;
    };
    expect(await client.ping()).toBe('PONG');
  });

  it('runs a job through a worker', async () => {
    const queue = newQueue();
    const events = new QueueEvents(queue.name, { connection });
    const worker = new Worker(
      queue.name,
      (job) => Promise.resolve(`done:${String((job.data as { n: number }).n)}`),
      {
        connection,
      },
    );
    try {
      await events.waitUntilReady();
      const job = await queue.add('work', { n: 7 });
      expect(await job.waitUntilFinished(events, 15_000)).toBe('done:7');
    } finally {
      await worker.close();
      await events.close();
    }
  });

  it('keeps one job scheduler when it is upserted twice', async () => {
    const queue = newQueue();
    for (let i = 0; i < 2; i++) {
      await queue.upsertJobScheduler('tick', { every: 60_000 }, { name: 'tick', data: {} });
    }
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toEqual(['tick']);
  });

  it('counts the waiting job of a paused queue as live for the sweeper', async () => {
    const queue = newQueue();
    await queue.pause();
    await queue.add('scan', { versionId: 'v1' });
    const live = await queue.getJobs([...LIVE_STATES], 0, -1);
    expect(live.map((j) => j.name)).toEqual(['scan']);
  });
});
