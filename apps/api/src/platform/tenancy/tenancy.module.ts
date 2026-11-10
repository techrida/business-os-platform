import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { CorrelationMiddleware } from './correlation.middleware';
import { ErrorBodyFilter } from './error-body.filter';
import { CLOCK, OrgResolver } from './org-resolver';
import { TenancyInterceptor } from './tenancy.interceptor';

/**
 * Request context, org resolution and the error body.
 *
 * Import this module BEFORE the logging module in AppModule: Nest runs middleware in registration
 * order, and pino-http's id generator reads `req.correlationId`, which only exists once
 * CorrelationMiddleware has run.
 */
@Module({
  providers: [
    OrgResolver,
    { provide: CLOCK, useValue: () => Date.now() },
    { provide: APP_INTERCEPTOR, useClass: TenancyInterceptor },
    { provide: APP_FILTER, useClass: ErrorBodyFilter },
  ],
  exports: [OrgResolver],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // '{*splat}' matches every path including '/' and paths no route handles, so a 404 gets an id too.
    consumer
      .apply(CorrelationMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
