import 'reflect-metadata';

import { getQueueToken } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { AppConfig, CoreConfig } from '../config/config';
import { SYSTEM_QUEUE } from './queue.constants';
import { QueueModule } from './queue.module';
import { producerOnlyConnection, redisOptionsFromUrl } from './redis-options';

// Port 1 refuses connections, so nothing here needs a Valkey; the queue only has to be built, not used.
const URL = 'redis://127.0.0.1:1';

/** Builds QueueModule the way each process does and returns the connection options its `system` queue was given. */
async function connectionOf(service: 'api' | 'worker'): Promise<Record<string, unknown>> {
  const providers: Array<{ provide: unknown; useValue: unknown }> = [
    { provide: CoreConfig, useValue: { VALKEY_URL: URL } },
  ];
  // The API process provides AppConfig as well; the worker has CoreConfig only (see ConfigModule.forRoot).
  if (service === 'api') providers.push({ provide: AppConfig, useValue: { VALKEY_URL: URL } });
  @Global()
  @Module({ providers: providers as never, exports: providers.map((p) => p.provide) as never })
  class FakeConfigModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [FakeConfigModule, QueueModule],
  }).compile();
  try {
    const queue = moduleRef.get<Queue>(getQueueToken(SYSTEM_QUEUE));
    queue.on('error', () => undefined);
    return queue.opts.connection as Record<string, unknown>;
  } finally {
    await moduleRef.close().catch(() => undefined);
  }
}

describe('the queue connection of each process', () => {
  it('producerOnlyConnection is the parsed URL with no offline queue', () => {
    expect(producerOnlyConnection(URL)).toEqual({
      ...redisOptionsFromUrl(URL),
      enableOfflineQueue: false,
    });
  });

  it('the API (it only adds jobs) turns the offline queue off', async () => {
    expect((await connectionOf('api')).enableOfflineQueue).toBe(false);
  });

  it('the worker keeps the default, because its workers issue commands while they reconnect', async () => {
    expect((await connectionOf('worker')).enableOfflineQueue).toBeUndefined();
  });
});
