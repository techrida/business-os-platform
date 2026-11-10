import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ErrorBody } from '@bos/contracts';
import type { NextFunction, Request, Response } from 'express';

import { newCorrelationId } from './platform/obs/correlation';

/** Largest request body the API accepts (the telemetry route enforces a stricter 2 KB on top). */
export const BODY_LIMIT = '16kb';

/**
 * Body-parser rejects an oversized or malformed body before Nest routes the request, so the
 * exception filter never sees it. This Express error handler (registered right after the
 * parsers) gives those two failures the same `ErrorBody` shape as every other error.
 * Anything else is passed on untouched.
 *
 * The correlation middleware has not run yet at this point, so the id comes from a valid
 * `x-request-id` header or is freshly generated, and is echoed on the response.
 */
export function bodyParserErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const type = typeof err === 'object' && err !== null && 'type' in err ? err.type : undefined;
  const problem =
    type === 'entity.too.large'
      ? { status: 413, code: 'payload_too_large', message: `Request body exceeds ${BODY_LIMIT}` }
      : type === 'entity.parse.failed'
        ? { status: 400, code: 'bad_request', message: 'Request body is not valid JSON' }
        : undefined;
  if (problem === undefined) {
    next(err);
    return;
  }
  const header = req.headers['x-request-id'];
  const correlationId = newCorrelationId(typeof header === 'string' ? header : undefined);
  const body: ErrorBody = {
    error: { code: problem.code, message: problem.message, correlationId },
  };
  res.setHeader('x-request-id', correlationId);
  res.status(problem.status).json(body);
}

/**
 * Settings every HTTP app in this repo needs, applied by `main.ts` and by the e2e tests so tests
 * exercise the same configuration as production.
 *
 * - Body limits: a small cap on JSON and urlencoded bodies stops a caller from making the
 *   process buffer megabytes before any guard has looked at the request.
 * - Body-parser errors: mapped to the ErrorBody shape (see bodyParserErrorHandler).
 * - Trust proxy: Caddy sits in front, so `req.ip` and `X-Forwarded-*` come from one hop we
 *   control. `1` trusts exactly one proxy; `true` would let a client spoof its address.
 * - No global prefix: controllers spell out `v1/...` themselves and the health routes have none.
 * - Shutdown hooks: SIGTERM closes the HTTP server, the DB pool and the metrics server cleanly.
 */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  express.useBodyParser('json', { limit: BODY_LIMIT });
  express.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true });
  express.use(bodyParserErrorHandler);
  express.set('trust proxy', 1);
  express.disable('x-powered-by');
  app.enableShutdownHooks();
}
