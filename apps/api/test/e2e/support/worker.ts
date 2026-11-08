// Starts the real BullMQ worker (WorkerModule) inside the test process, the way src/worker.ts does minus the
// metrics server. With it running, an e2e exercises the background half of the system for real: the virus
// scan after an upload and the outbox drain that sends email (NFR: every async side effect is observable).
import 'reflect-metadata';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

export interface TestWorker {
  readonly app: INestApplicationContext;
  close(): Promise<void>;
}

/**
 * Call AFTER startApp() (which sets DATABASE_URL, VALKEY_URL and the rest) and after any extra env the
 * worker reads. WorkerModule is imported dynamically for the same reason as AppModule in app.ts: its
 * config is read from process.env, so the variables must exist before the module graph is built.
 */
export async function startWorker(): Promise<TestWorker> {
  const { WorkerModule } = await import('../../../src/worker.module');
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  // init() runs the lifecycle hooks: the BullMQ processors start consuming and the schedulers register.
  await app.init();
  return {
    app,
    close: () => app.close(),
  };
}
