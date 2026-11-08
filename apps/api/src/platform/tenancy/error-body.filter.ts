import type { ErrorBody } from '@bos/contracts';
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

import { newCorrelationId } from '../obs/correlation';
import { REQUEST_ID_HEADER, type CorrelatedRequest } from './correlation.middleware';
import { currentCorrelationId } from './request-context';

/** Machine-readable codes clients can switch on. The message is for humans and may change. */
export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'payload_too_large'
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
    case 413:
      return 'payload_too_large';
    case 503:
      return 'unavailable';
    default:
      // Any other 4xx is the caller's fault (400, 405, 409, 415, 422, 429 ...); anything else is ours.
      return status >= 400 && status < 500 ? 'bad_request' : 'internal';
  }
}

const GENERIC_MESSAGE: Record<ErrorCode, string> = {
  unauthenticated: 'Authentication required',
  forbidden: 'Forbidden',
  not_found: 'Not found',
  payload_too_large: 'Payload too large',
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

/** body-parser and other Express middleware throw plain errors that carry an HTTP status. */
function statusOfPlainError(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const { status, statusCode } = exception as { status?: unknown; statusCode?: unknown };
  const value = typeof status === 'number' ? status : statusCode;
  return typeof value === 'number' && value >= 400 && value <= 599 ? value : undefined;
}

/**
 * Turns every exception into `{ error: { code, message, correlationId } }` (ErrorBodySchema).
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
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      exposedMessage = messageOf(exception);
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

    if (res.headersSent) {
      return;
    }
    const body: ErrorBody = { error: { code, message, correlationId } };
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
