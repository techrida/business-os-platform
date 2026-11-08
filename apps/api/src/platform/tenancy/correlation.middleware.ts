import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { newCorrelationId } from '../obs/correlation';
import { runWithRequestStore } from './request-context';

/** Request with the id this middleware attaches (read by pino-http's genReqId and the error filter). */
export type CorrelatedRequest = Request & { correlationId?: string };

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Gives every request a correlation id and opens the AsyncLocalStorage store for it.
 *
 * A caller-supplied `x-request-id` is kept only when it matches `^[A-Za-z0-9-]{8,64}$`
 * (newCorrelationId decides), otherwise a fresh UUID replaces it. The check matters because the id
 * ends up in logs and response headers: an unchecked value would allow log forging.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: CorrelatedRequest, res: Response, next: NextFunction): void {
    const incoming = req.headers[REQUEST_ID_HEADER];
    // A repeated header arrives as an array; treat it as invalid rather than picking one.
    const correlationId = newCorrelationId(typeof incoming === 'string' ? incoming : undefined);
    req.correlationId = correlationId;
    res.setHeader(REQUEST_ID_HEADER, correlationId);
    // next() must be called inside run(): everything downstream (guards, handlers) inherits the store.
    runWithRequestStore(correlationId, () => next());
  }
}
