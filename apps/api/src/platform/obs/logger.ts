import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Params } from 'nestjs-pino';
import { stdTimeFunctions } from 'pino';

import type { CoreConfig, ServiceName } from '../config/config';
import { newCorrelationId } from './correlation';

/**
 * Fields that must never reach a log line. `*.password` is one level deep; the explicit
 * header paths cover the shape pino-http uses (`req.headers.authorization`).
 */
export const REDACT_PATHS = [
  'authorization',
  'cookie',
  'password',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.headers.authorization',
  '*.headers.cookie',
  'res.headers["set-cookie"]',
];

type CorrelatedRequest = IncomingMessage & { correlationId?: string };

/**
 * The request id for pino-http. The tenancy middleware sets `req.correlationId` and echoes it
 * in the `x-request-id` response header. When pino runs first (middleware order between
 * modules is not guaranteed), we generate the id the same way and store it on the request, so
 * a middleware that respects an existing `req.correlationId` stays in agreement with the log.
 */
export function genReqId(req: CorrelatedRequest, _res?: ServerResponse): string {
  if (typeof req.correlationId === 'string') return req.correlationId;
  const header = req.headers['x-request-id'];
  const id = newCorrelationId(typeof header === 'string' ? header : undefined);
  req.correlationId = id;
  return id;
}

/** nestjs-pino settings: JSON to stdout, redaction, correlation id as the request id. */
export function buildLoggerParams(config: CoreConfig, service: ServiceName): Params {
  return {
    pinoHttp: {
      level: config.LOG_LEVEL,
      base: { service: `bos-${service}` },
      timestamp: stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
      genReqId,
      // Probes hit these every few seconds; logging each one buries real traffic.
      autoLogging: { ignore: (req) => req.url === '/health/live' },
    },
  };
}
