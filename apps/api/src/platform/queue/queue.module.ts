import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AppConfig, CoreConfig } from '../config/config';
import { SYSTEM_QUEUE } from './queue.constants';
import { producerOnlyConnection, redisOptionsFromUrl } from './redis-options';

export * from './queue.constants';

/**
 * The BullMQ connection (Valkey) and the `system` queue. Loaded by both processes: the API
 * only needs the connection for readiness and future enqueueing. The heartbeat job and its
 * processor live in WorkerModule, so the API never consumes jobs.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      // AppConfig exists only in the API process, which never consumes jobs: its queues only add.
      inject: [CoreConfig, { token: AppConfig, optional: true }],
      useFactory: (config: CoreConfig, api: AppConfig | undefined) => ({
        connection:
          api === undefined
            ? redisOptionsFromUrl(config.VALKEY_URL)
            : producerOnlyConnection(config.VALKEY_URL),
      }),
    }),
    BullModule.registerQueue({ name: SYSTEM_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
