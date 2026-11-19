import { ErrorReasonSchema, type ErrorBody, type ErrorReason } from '@bos/contracts';
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

import { newCorrelationId } from '../obs/correlation';
import { REQUEST_ID_HEADER, type CorrelatedRequest } from './correlation.middleware';
import { currentCorrelationId } from './request-context';

/** Machine-readable codes clients can switch on. The message is for humans and may change. */
export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'bad_request'
  | 'unavailable'
  | 'internal';

export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 503:
      return 'unavailable';
    default:
      // Any other 4xx is the caller's fault (400, 405, 422, 429 ...); anything else is ours.
      return status >= 400 && status < 500 ? 'bad_request' : 'internal';
  }
}

const GENERIC_MESSAGE: Record<ErrorCode, string> = {
  unauthenticated: 'Authentication required',
  forbidden: 'Forbidden',
  not_found: 'Not found',
  conflict: 'Conflict',
  payload_too_large: 'Payload too large',
  unsupported_media_type: 'Unsupported media type',
  bad_request: 'Bad request',
  unavailable: 'Service unavailable',
  internal: 'Internal server error',
};

/** Pulls the text out of an HttpException body: a string, `{ message: string }` or `{ message: string[] }`. */
function messageOf(exception: HttpException): string | undefined {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  if ('message' in response) {
    const { message } = response;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) {
      return message.filter((m): m is string => typeof m === 'string').join('; ');
    }
  }
  return undefined;
}

/**
 * The optional `reason` a 403 or a 400 can carry, e.g. `new ForbiddenException({ code: 'forbidden',
 * reason: 'out_of_scope' })`. Only the known reasons pass, so the body always satisfies
 * ErrorBodySchema and a stray string from a thrown object never reaches the client.
 */
function reasonOf(exception: HttpException): ErrorReason | undefined {
  const response = exception.getResponse();
  if (typeof response !== 'object' || !('reason' in response)) return undefined;
  const parsed = ErrorReasonSchema.safeParse(response.reason);
  return parsed.success ? parsed.data : undefined;
}

/** What `routeOf` returns when Express matched no route (a middleware refused the request first). */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * The matched route pattern (`/v1/approvals/requests/:id`), else `UNMATCHED_ROUTE`. Never the request path:
 * a path carries record ids, and the query string can carry a searched name. Nest mounts controller routes on
 * the root router, so their `baseUrl` is empty. A non-empty `baseUrl` is the concrete path a middleware was
 * mounted at (`/v1/blocked/<id>`), and `req.route` is then left over from an earlier layer, so neither is used.
 */
export function routeOf(req: { route?: unknown; baseUrl?: string }): string {
  const route = req.route as { path?: unknown } | undefined;
  if (typeof route?.path !== 'string' || (req.baseUrl ?? '') !== '') return UNMATCHED_ROUTE;
  return route.path;
}

/** The fields of one `http.forbidden` line. Every value is a fixed vocabulary or the response's request id. */
interface ForbiddenEvent {
  event: 'http.forbidden';
  status: 403;
  method: string;
  route: string;
  code: ErrorCode;
  reason: ErrorReason | null;
  correlationId: string;
}

/**
 * Writes the `http.forbidden` line with the root pino logger, not the per-request one. nestjs-pino's request
 * logger is bound to the serialized request (url with query string, params, client address, headers), and every
 * line written through it carries those bindings. The root logger has only the base fields and the redaction of
 * `buildLoggerParams`. Without nestjs-pino (unit tests, a bare Nest app) the Nest logger has no request bindings
 * either, so it is the fallback.
 */
function logForbidden(fallback: Logger, event: ForbiddenEvent): void {
  // Unset until nestjs-pino's LoggerModule builds its middleware, although the type says otherwise.
  const root: PinoLogger['logger'] | undefined = PinoLogger.root;
  if (root === undefined) {
    fallback.warn({ msg: 'request forbidden', ...event });
    return;
  }
  root.warn({ context: 'ErrorBodyFilter', ...event }, 'request forbidden');
}

/** body-parser and other Express middleware throw plain errors that carry an HTTP status. */
function statusOfPlainError(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const { status, statusCode } = exception as { status?: unknown; statusCode?: unknown };
  const value = typeof status === 'number' ? status : statusCode;
  return typeof value === 'number' && value >= 400 && value <= 599 ? value : undefined;
}

/**
 * Turns every exception into `{ error: { code, message, correlationId, reason? } }` (ErrorBodySchema).
 *
 * Leak rules: a server-side failure (any 5xx except 503) always returns a fixed message; the real
 * error and its stack go only to the log, next to the correlation id so support can find them.
 * Responses never contain a stack.
 */
@Catch()
export class ErrorBodyFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorBodyFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }
    const http = host.switchToHttp();
    const req = http.getRequest<CorrelatedRequest>();
    const res = http.getResponse<Response>();

    let status: number;
    let exposedMessage: string | undefined;
    let reason: ErrorReason | undefined;
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      exposedMessage = messageOf(exception);
      // 403 for authz denials; 400 for `invalid_entity` (a malformed X-Entity-Id, ADR 0027 §4).
      const reportedReason = reasonOf(exception);
      if (status === 403 || status === 400 || (status === 409 && reportedReason === 'stale_memo')) {
        reason = reportedReason;
      }
    } else {
      status = statusOfPlainError(exception) ?? HttpStatus.INTERNAL_SERVER_ERROR;
    }

    const code = codeForStatus(status);
    // 5xx other than 503 may carry internal detail in the message, so those are never shown.
    const message =
      status >= 500 && status !== 503
        ? GENERIC_MESSAGE.internal
        : (exposedMessage ?? GENERIC_MESSAGE[code]);
    const correlationId = this.correlationIdFor(req);

    if (status >= 500) {
      // req.path excludes the query string, which could carry secrets.
      const stack = exception instanceof Error ? exception.stack : String(exception);
      this.logger.error(
        `${req.method} ${req.path} failed with ${status} (correlationId=${correlationId})`,
        stack,
      );
    }

    if (status === 403) {
      // One structured line per denial, so a 403 the client shows can be traced to the check that made it
      // (role, entity, scope, separation of duties ...). Only the fields listed here: no url, query, ids, user,
      // token or body. The correlation id (also in the response header) links it to the request log.
      logForbidden(this.logger, {
        event: 'http.forbidden',
        status: 403,
        method: req.method,
        route: routeOf(req),
        code,
        reason: reason ?? null,
        correlationId,
      });
    }

    if (res.headersSent) {
      return;
    }
    const body: ErrorBody = {
      error: { code, message, correlationId, ...(reason === undefined ? {} : { reason }) },
    };
    res.setHeader(REQUEST_ID_HEADER, correlationId);
    res.status(status).json(body);
  }

  /** The request's id from the async context, else the request header, else a fresh one. Always valid. */
  private correlationIdFor(req: CorrelatedRequest): string {
    const header = req.headers[REQUEST_ID_HEADER];
    return (
      currentCorrelationId() ??
      req.correlationId ??
      newCorrelationId(typeof header === 'string' ? header : undefined)
    );
  }
}
