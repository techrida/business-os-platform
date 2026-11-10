import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { CoreConfig, type ServiceName } from '../config/config';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { buildLoggerParams } from './logger';
import { MetricsServer } from './metrics.server';
import { MetricsService } from './metrics.service';

export { MetricsService } from './metrics.service';
export { MetricsServer } from './metrics.server';

/**
 * Logging (pino), metrics (prom-client) and the HTTP latency middleware.
 * Global so U4's telemetry module can inject `MetricsService` without importing this module.
 */
@Module({})
export class ObsModule implements NestModule {
  static forRoot(options: { service: ServiceName }): DynamicModule {
    return {
      module: ObsModule,
      global: true,
      imports: [
        LoggerModule.forRootAsync({
          inject: [CoreConfig],
          useFactory: (config: CoreConfig) => buildLoggerParams(config, options.service),
        }),
      ],
      providers: [MetricsService, MetricsServer],
      exports: [MetricsService, MetricsServer, LoggerModule],
    };
  }

  /** Only runs where an HTTP adapter exists; the worker (no router) skips it. */
  configure(consumer: MiddlewareConsumer): void {
    // Same catch-all pattern nestjs-pino uses; the unnamed `*` is not valid on Express 5.
    consumer
      .apply(HttpMetricsMiddleware)
      .forRoutes({ path: '{/*splat}', method: RequestMethod.ALL });
  }
}
