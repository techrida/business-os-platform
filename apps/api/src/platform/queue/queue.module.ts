import { BullModule } from '@nestjs/bullmq';
import { Logger, Module } from '@nestjs/common';
import { Queue } from 'bullmq';

import { AppConfig, CoreConfig } from '../config/config';
import { SYSTEM_QUEUE } from './queue.constants';
import { producerOnlyConnection, redisOptionsFromUrl } from './redis-options';

export * from './queue.constants';

const logger = new Logger('QueueModule');

/**
 * Closes a queue and never throws. With Valkey away a close (a QUIT) is refused by the producer connection ("stream isn't
 * writeable": it has no offline queue), which bullmq does not count as a connection error, so the refusal would fail the
 * whole API shutdown. The error is logged and the socket is dropped instead.
 */
export async function closeQueueQuietly(
  close: () => Promise<void>,
  disconnect: () => Promise<void>,
): Promise<void> {
  try {
    await close();
  } catch (error) {
    logger.warn(
      `closing a queue failed (Valkey is away?), dropping its connection: ${error instanceof Error ? error.message : String(error)}`,
    );
    try {
      await disconnect();
    } catch {
      // Already gone: nothing is left to free.
    }
  }
}

const TOLERANT_CLOSE = Symbol.for('bos.queue.tolerant-close');

/**
 * Makes `Queue.close()` of every queue (the ones @nestjs/bullmq closes at shutdown) go through closeQueueQuietly. The
 * queues are built inside @nestjs/bullmq with bullmq's own class, so this cannot be a subclass. Idempotent.
 */
export function installTolerantQueueClose(): void {
  const proto = Queue.prototype as unknown as Record<symbol, boolean> & { close(): Promise<void> };
  if (proto[TOLERANT_CLOSE]) return;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the queue as `this` below
  const original = proto.close;
  proto.close = function (this: Queue): Promise<void> {
    return closeQueueQuietly(
      () => original.call(this),
      () => this.disconnect(),
    );
  };
  proto[TOLERANT_CLOSE] = true;
}

installTolerantQueueClose();

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
