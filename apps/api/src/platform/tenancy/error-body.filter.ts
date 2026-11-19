import {
  ErrorBodySchema,
  ErrorReasonSchema,
  type ErrorBody,
  type ErrorReason,
} from '@bos/contracts';
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
import { z } from 'zod';

import { STEP_UP_REQUIRED } from '../auth/step-up';
import { newCorrelationId } from '../obs/correlation';
import { REQUEST_ID_HEADER, type CorrelatedRequest } from './correlation.middleware';
import { currentCorrelationId } from './request-context';

/** Machine-readable codes clients can switch on. The message is for humans and may change. */
export type ErrorCode =
  | 'unauthenticated'
  | 'step_up_required'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'fx_rate_stale'
  | 'duplicate_pan_vat'
  | 'duplicate_found'
  | 'primary_contact_exists'
  | 'contact_email_required'
  | 'quotation_not_sent'
  | 'quotation_expired'
  | 'quotation_pdf_not_ready'
  | 'kyb_not_verified'
  | 'customer_merged'
  | 'idp_org_taken'
  | 'NO_ELIGIBLE_APPROVER'
  | 'APPROVER_NOT_ELIGIBLE'
  | 'evidence_policy_unmet'
  | 'decided_on_in_future'
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
  step_up_required: 'Sign in again to continue',
  forbidden: 'Forbidden',
  not_found: 'Not found',
  conflict: 'Conflict',
  fx_rate_stale: 'The exchange rate is too old',
  duplicate_pan_vat: 'Another customer already has this PAN/VAT number',
  duplicate_found: 'This looks like a record that already exists',
  primary_contact_exists: 'This customer already has a primary contact',
  contact_email_required: 'This customer needs a contact with an email',
  quotation_not_sent: 'This quotation is not open for an answer',
  quotation_expired: 'This quotation has expired',
  quotation_pdf_not_ready: 'The PDF of this quotation version is not ready to download',
  kyb_not_verified: 'Portal access needs an approved KYB verification case',
  customer_merged: 'This customer was merged into another',
  idp_org_taken: 'The portal organization is already used by another party',
  NO_ELIGIBLE_APPROVER: 'No one is eligible to approve this; an administrator has been told',
  APPROVER_NOT_ELIGIBLE: 'The chosen approver cannot approve this',
  evidence_policy_unmet: 'The evidence given does not meet the policy',
  decided_on_in_future: 'The decision date is in the future',
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

/**
 * True for a 401 thrown with `code: 'step_up_required'` (StepUpRequiredException, K7). Only a 401
 * may carry it, so no other error can tell the client to re-authenticate.
 */
function isStepUp(exception: HttpException): boolean {
  if (exception.getStatus() !== 401) return false;
  const response = exception.getResponse();
  return typeof response === 'object' && 'code' in response && response.code === STEP_UP_REQUIRED;
}

/**
 * A 409 may name its cause with a code a client can switch on. Only these pass: any other string a thrown
 * object carries still reads as plain `conflict`, so the body stays within what clients know.
 */
const CONFLICT_CODES: readonly ErrorCode[] = [
  'fx_rate_stale',
  'duplicate_pan_vat',
  'duplicate_found',
  'primary_contact_exists',
  // Q3b/PA-3: the quotation version was already answered, revised or expired (`quotation_not_sent`), or its
  // validity ended before the decision day (`quotation_expired`). The portal shows "already answered".
  'quotation_not_sent',
  'quotation_expired',
  // The staff PDF download: the version has no rendered file yet, or it has not scanned clean.
  'quotation_pdf_not_ready',
  // K8 portal access grant: the customer's KYB case is not approved, the customer was merged away, or the
  // portal org found by name is already linked to another party.
  'kyb_not_verified',
  'customer_merged',
  'idp_org_taken',
];

function conflictCodeOf(exception: HttpException): ErrorCode | undefined {
  if (exception.getStatus() !== 409) return undefined;
  const response = exception.getResponse();
  if (typeof response !== 'object' || !('code' in response)) return undefined;
  return CONFLICT_CODES.find((code) => code === response.code);
}

/**
 * A 422 may name its cause the same way. `NO_ELIGIBLE_APPROVER` (P2 M4, upper case as the plan names it): a
 * quotation submit found an approval step nobody may decide, so nothing was submitted and admins were told.
 * `evidence_policy_unmet` and `decided_on_in_future` (Q3b/PA-3): an acceptance without the evidence the entity's
 * policy asks for, or an answer dated after today in Kathmandu.
 */
const UNPROCESSABLE_CODES: readonly ErrorCode[] = [
  'contact_email_required',
  'NO_ELIGIBLE_APPROVER',
  // A quotation submit named an approver who may not decide its first step (or the author themselves).
  'APPROVER_NOT_ELIGIBLE',
  'evidence_policy_unmet',
  'decided_on_in_future',
];

function unprocessableCodeOf(exception: HttpException): ErrorCode | undefined {
  if (exception.getStatus() !== 422) return undefined;
  const response = exception.getResponse();
  if (typeof response !== 'object' || !('code' in response)) return undefined;
  return UNPROCESSABLE_CODES.find((code) => code === response.code);
}

/** The `details` of a coded 409: string and number values only, so the body satisfies ErrorBodySchema. */
function detailsOf(exception: HttpException): Record<string, string | number> | undefined {
  const response = exception.getResponse();
  if (typeof response !== 'object' || !('details' in response)) return undefined;
  const parsed = ErrorBodySchema.shape.error.shape.details.safeParse(response.details);
  return parsed.success ? parsed.data : undefined;
}

/**
 * One possible duplicate of a lead's customer or contact. The same shape the workspace parses in
 * `apps/workspace/src/components/p2/crm/duplicates.ts`: for a contact, `customerId` names the customer it
 * belongs to, so "use existing" can link both.
 */
export const DuplicateCandidateSchema = z.strictObject({
  kind: z.enum(['customer', 'contact']),
  id: z.guid(),
  label: z.string().max(300),
  /** What matched: name, pan, email or phone. */
  matchedOn: z.string().max(50),
  customerId: z.guid().optional(),
});
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;

const DuplicateListSchema = z.array(DuplicateCandidateSchema).min(1).max(50);

/**
 * The candidates of a `duplicate_found` 409, validated so a stray object never reaches the client. They go to
 * `error.duplicates` (a sibling of `code`, not inside `details`, which only holds strings and numbers).
 * ErrorBodySchema is not strict, so a client that parses with it still accepts the body.
 */
function duplicatesOf(exception: HttpException): DuplicateCandidate[] | undefined {
  const response = exception.getResponse();
  if (typeof response !== 'object' || !('duplicates' in response)) return undefined;
  const parsed = DuplicateListSchema.safeParse(response.duplicates);
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
    let stepUp = false;
    let conflictCode: ErrorCode | undefined;
    let details: Record<string, string | number> | undefined;
    let duplicates: DuplicateCandidate[] | undefined;
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      exposedMessage = messageOf(exception);
      // 403 for authz denials; 400 for `invalid_entity` (a malformed X-Entity-Id, ADR 0027 §4).
      const reportedReason = reasonOf(exception);
      if (status === 403 || status === 400 || (status === 409 && reportedReason === 'stale_memo')) {
        reason = reportedReason;
      }
      stepUp = isStepUp(exception);
      conflictCode = conflictCodeOf(exception) ?? unprocessableCodeOf(exception);
      if (conflictCode !== undefined) details = detailsOf(exception);
      if (conflictCode === 'duplicate_found') duplicates = duplicatesOf(exception);
    } else {
      status = statusOfPlainError(exception) ?? HttpStatus.INTERNAL_SERVER_ERROR;
    }

    const code: ErrorCode = stepUp ? 'step_up_required' : (conflictCode ?? codeForStatus(status));
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
    const body: ErrorBody & { error: { duplicates?: DuplicateCandidate[] } } = {
      error: {
        code,
        message,
        correlationId,
        ...(reason === undefined ? {} : { reason }),
        ...(details === undefined ? {} : { details }),
        ...(duplicates === undefined ? {} : { duplicates }),
      },
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
