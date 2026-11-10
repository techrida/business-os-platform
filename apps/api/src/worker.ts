import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { CoreConfig } from './platform/config/config';
import { MetricsServer } from './platform/obs/metrics.server';
import { WorkerHealth } from './platform/queue/worker-health';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  // An application context: the Nest container without an HTTP router.
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const config = app.get(CoreConfig);
  const health = app.get(WorkerHealth);
  // The worker has no API port, so it serves /metrics and /health on its own small server.
  await app.get(MetricsServer).listen(config.METRICS_PORT, { health: () => health.report() });
  app.get(Logger).log(`worker started, metrics and health on :${config.METRICS_PORT}`);
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
