import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Params } from 'nestjs-pino';
import { DrizzleQueryError } from 'drizzle-orm';
import { stdSerializers, stdTimeFunctions } from 'pino';

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

type LoggedRequest = { url?: unknown; query?: unknown; headers?: unknown };

/** The part of a URL before `?`. A query string carries customer values (search terms, emails, tokens). */
export function cutAtQuery(url: string): string {
  const queryAt = url.indexOf('?');
  return queryAt === -1 ? url : url.slice(0, queryAt);
}

/**
 * pino-http request serializer, run on pino's already-serialized request. Every logged request keeps its
 * path only: the url is cut at `?`, the parsed `query` (Express sets it, and the std serializer copies it)
 * is dropped, and so is the query of the referer header, which is a URL of the page that made the call.
 */
export function serializeLoggedRequest<T extends LoggedRequest>(req: T): T {
  if (typeof req.url === 'string') req.url = cutAtQuery(req.url);
  delete req.query;
  const headers = req.headers;
  if (typeof headers === 'object' && headers !== null && 'referer' in headers) {
    const referer = (headers as { referer?: unknown }).referer;
    // A copy: pino hands over the live request headers, and the real referer must stay as it was sent.
    if (typeof referer === 'string') {
      req.headers = { ...(headers as object), referer: cutAtQuery(referer) };
    }
  }
  return req;
}

/**
 * A Drizzle query error says `Failed query: <sql>\nparams: <values>` in its message, so its message and stack
 * (which starts with the message) carry the customer values the statement was run with. This keeps the query
 * text and drops everything from `params:` up to the stack frames (or the end of the text).
 */
export function scrubQueryParams(text: string): string {
  return text.replace(/(Failed query: [\s\S]*?)\nparams: [\s\S]*?(?=\n {4}at |$)/g, '$1');
}

/**
 * What to log for an error: the message and the stack, with no statement values. A Drizzle query error
 * logs its query text and its cause's stack (the Postgres error, which names the constraint but not the row
 * values); any other error logs its own message and stack, scrubbed the same way.
 */
export function describeErrorForLog(error: unknown): {
  message: string;
  stack: string | undefined;
} {
  if (error instanceof DrizzleQueryError) {
    const cause = error.cause instanceof Error ? error.cause : undefined;
    return {
      message: `Failed query: ${error.query}`,
      stack: cause?.stack === undefined ? undefined : scrubQueryParams(cause.stack),
    };
  }
  if (error instanceof Error) {
    return {
      message: scrubQueryParams(error.message),
      stack: error.stack === undefined ? undefined : scrubQueryParams(error.stack),
    };
  }
  return { message: scrubQueryParams(String(error)), stack: undefined };
}

function scrubLogValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubQueryParams(value);
  if (value instanceof Error) return value;
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of ['msg', 'message', 'stack']) {
    if (typeof out[key] === 'string') out[key] = scrubQueryParams(out[key]);
  }
  return out;
}

/**
 * pino's error serializer, scrubbed: used for `{ err }` bindings, so a Drizzle query error passed to the root
 * logger (the worker's processors log through it) never writes its params.
 */
function serializeLoggedError(error: Error): Record<string, unknown> {
  const out = stdSerializers.err(error) as unknown as Record<string, unknown>;
  // pino copies an error's own properties, and a Drizzle query error has the bound values in `params`.
  delete out['params'];
  for (const key of ['message', 'stack']) {
    if (typeof out[key] === 'string') out[key] = scrubQueryParams(out[key]);
  }
  return out;
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
      serializers: { req: serializeLoggedRequest, err: serializeLoggedError },
      // Every worker and sweeper log line goes through here, whatever it was handed: a string or object that
      // quotes a Drizzle query error loses its `params:` tail before it is written.
      hooks: {
        logMethod(args, method) {
          return method.apply(this, args.map(scrubLogValue) as Parameters<typeof method>);
        },
      },
      // Probes hit these every few seconds; logging each one buries real traffic.
      autoLogging: { ignore: (req) => req.url === '/health/live' },
    },
  };
}
