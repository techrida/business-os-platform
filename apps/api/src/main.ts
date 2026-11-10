import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { AppConfig } from './platform/config/config';
import { MetricsServer } from './platform/obs/metrics.server';

async function bootstrap(): Promise<void> {
  // bufferLogs holds early Nest logs until pino is ready, so every line is JSON.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);

  const config = app.get(AppConfig);
  await app.listen(config.API_PORT, '0.0.0.0');
  // Metrics live on their own port, never on the API router (see MetricsServer).
  await app.get(MetricsServer).listen(config.METRICS_PORT);
  app.get(Logger).log(`API listening on :${config.API_PORT}, metrics on :${config.METRICS_PORT}`);
}

bootstrap().catch((error: unknown) => {
  // A ConfigError lists variable names and reasons only, never values, so printing it is safe.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
