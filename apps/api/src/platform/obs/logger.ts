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
  // The user's ID token, sent on Founder decisions for step-up (K7). A sign-in proof, never logged.
  '*.headers["x-bos-id-token"]',
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

/**
 * Routes whose query string carries personal data. The lead duplicates lookup sends the typed
 * email, phone, name and company as query parameters.
 */
const QUERY_FREE_PATH_PREFIXES = ['/v1/leads/duplicates'];

type LoggedRequest = { url?: unknown; query?: unknown };

/**
 * pino-http request serializer, run on pino's already-serialized request. For the routes above
 * it cuts the url at `?` and drops the parsed `query` (Express sets it, and the std serializer
 * copies it). The path compares lower-cased without trailing slashes, as Express routes it
 * (case-insensitive, non-strict), so `/V1/Leads/Duplicates/?email=` is cut too. Every other
 * request is returned as is.
 */
export function serializeLoggedRequest<T extends LoggedRequest>(req: T): T {
  if (typeof req.url !== 'string') return req;
  const queryAt = req.url.indexOf('?');
  const path = queryAt === -1 ? req.url : req.url.slice(0, queryAt);
  const routed = path.toLowerCase().replace(/\/+$/, '');
  if (!QUERY_FREE_PATH_PREFIXES.some((prefix) => routed.startsWith(prefix))) return req;
  req.url = path;
  delete req.query;
  return req;
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
      serializers: { req: serializeLoggedRequest },
      // Probes hit these every few seconds; logging each one buries real traffic.
      autoLogging: { ignore: (req) => req.url === '/health/live' },
    },
  };
}
