import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { assertRoutePolicy } from './platform/authz/route-policy.check';
import { AppConfig } from './platform/config/config';
import { MetricsServer } from './platform/obs/metrics.server';

async function bootstrap(): Promise<void> {
  // bufferLogs holds early Nest logs until pino is ready, so every line is JSON.
  // rawBody keeps the unparsed bytes on req.rawBody: the ZITADEL webhook signature is an HMAC over
  // the exact body, and re-serialising parsed JSON would not reproduce it. It is a factory option,
  // so configureApp() cannot set it.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.useLogger(app.get(Logger));
  configureApp(app);

  // Refuse to boot with a route that has no @Can, @AnyAuthenticated or @Public marker. init() is
  // idempotent, so listen() below does not run the lifecycle hooks twice.
  await app.init();
  assertRoutePolicy(app);

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
