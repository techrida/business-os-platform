import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { MetricsService } from './metrics.service';

/** Label for requests that matched no route (404s, scanners). One value keeps cardinality bounded. */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * The route template Express matched, e.g. `/v1/things/:id`, or UNMATCHED.
 * `req.route` is only set once routing has run, so call this after the response finished.
 */
export function routeTemplate(req: Request): string {
  const route: unknown = req.route;
  if (typeof route === 'object' && route !== null && 'path' in route) {
    const path = route.path;
    // Nest's own catch-all (used to attach middleware) is not a real route.
    if (typeof path === 'string' && !path.includes('*splat')) return path;
  }
  return UNMATCHED_ROUTE;
}

/**
 * Times every request and records it in the latency histogram.
 *
 * It is middleware rather than an interceptor on purpose: guards run before interceptors, so an
 * interceptor would never see the 401s the AuthGuard produces, and those are exactly the
 * requests we must be able to count. Recording on 'finish' also sees the final status code
 * after the exception filter ran.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.once('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.observeHttp(req.method, routeTemplate(req), res.statusCode, seconds);
    });
    next();
  }
}
