import 'server-only';

import {
  CurrencySchema,
  RfqListItemSchema,
  RfqStatusSchema,
  RfqSubmissionItemSchema,
  type ConvertSubmissionBody,
  type CreateRfqBody,
  type RecommendQuotationBody,
  type RecordQuotationBody,
  type RfqListItem,
  type RfqStatus,
  type RfqSubmissionItem,
  type ScoreQuotationBody,
} from '@bos/contracts';
import { z } from 'zod';

import { call, callList, jsonInit, listQuery, seg } from './api-procurement';
import type { Session } from './session';

/**
 * Typed calls from the workspace BFF to the P4 sourcing routes (`/v1/procurement/rfqs`, all behind
 * `procurement.sourcing`). Server-only: every call carries the user's access token. The contracts
 * hold the list and submission rows and every request body; the RFQ, quotation and comparison
 * responses have no contract schema yet, so the schemas below mirror `RfqDto`, `QuotationDto` and
 * `ComparisonRow` in `apps/api` (`sourcing.service.ts`). A response that drifts fails here (502)
 * instead of rendering `undefined`.
 *
 * Money is a string the server computed; nothing in this file adds or multiplies. Every write takes
 * the Idempotency-Key as a required argument (the API answers 400 without one), so a missing key
 * is a compile error. None of the RFQ bodies carries `expectedVersion`: the API's bodies are strict.
 */

const money = z.string().regex(/^-?\d+(\.\d+)?$/);

export const RfqDtoSchema = z.object({
  id: z.guid(),
  number: z.string(),
  purchaseRequestId: z.guid(),
  /** ISO timestamp. */
  deadline: z.string(),
  status: RfqStatusSchema,
  vendorIds: z.array(z.guid()),
  /** The invited vendors with their legal names, sent with the RFQ under its own grant (no vendor read). */
  vendors: z.array(z.object({ id: z.guid(), name: z.string() })),
  recommendedQuotationId: z.guid().nullable(),
  fewerThanThreeReason: z.string().nullable(),
  recommendationRationale: z.string().nullable(),
  commitmentApprovalRequestId: z.guid().nullable(),
  version: z.number().int().min(1),
});
export type RfqDto = z.infer<typeof RfqDtoSchema>;

export const QuotationDtoSchema = z.object({
  id: z.guid(),
  rfqId: z.guid(),
  vendorId: z.guid(),
  currency: CurrencySchema,
  subtotal: money,
  taxAmount: money,
  total: money,
  fxRate: money,
  totalNpr: money,
  deliveryDays: z.number().int().nullable(),
  documentId: z.guid(),
});
export type QuotationDto = z.infer<typeof QuotationDtoSchema>;

/** One line of a quotation as the vendor quoted it; `lineNo` is its request line's number. */
export const QuotationLineSchema = z.object({
  id: z.guid(),
  prLineId: z.guid(),
  lineNo: z.number().int().min(1),
  description: z.string(),
  quantity: money,
  unitPrice: money,
  taxCode: z.string(),
  taxRateBp: z.number().int().min(0),
  gross: money,
  taxAmount: money,
  lineTotal: money,
});
export type QuotationLine = z.infer<typeof QuotationLineSchema>;

export const ComparisonRowSchema = QuotationDtoSchema.extend({
  /** What the vendor quoted, in request-line order; the server's gross, tax and total per line. */
  lines: z.array(QuotationLineSchema),
  /** The quoting vendor's legal name, sent with the quotation. */
  vendorName: z.string(),
  /** The mean of the scores (two places), or null when nobody scored it yet. */
  averageScore: money.nullable(),
  scores: z.array(
    z.object({ criterion: z.string(), score: money, comment: z.string().nullable() }),
  ),
});
export type ComparisonRow = z.infer<typeof ComparisonRowSchema>;

const RFQ_PATH = '/v1/procurement/rfqs';

/** One page of `GET /v1/procurement/rfqs` with several statuses, a search and `offset`, plus the total of all matches. */
export function listRfqsPage(
  session: Session,
  query: { status?: readonly RfqStatus[]; q?: string; limit: number; offset: number },
): Promise<{ items: RfqListItem[]; total: number }> {
  return callList(
    session,
    listQuery(RFQ_PATH, {
      status: query.status?.map((s) => RfqStatusSchema.parse(s)),
      q: query.q,
      limit: query.limit,
      offset: query.offset,
    }),
    RfqListItemSchema,
  );
}

/** `GET /v1/procurement/rfqs/:id`: 404 for another entity's RFQ. */
export function getRfq(session: Session, id: string): Promise<RfqDto> {
  return call(session, `${RFQ_PATH}/${seg(id)}`, RfqDtoSchema);
}

/** `GET .../:id/quotations`: the comparison, quotations cheapest first, each with its scores. */
export function getComparison(session: Session, id: string): Promise<ComparisonRow[]> {
  return call(session, `${RFQ_PATH}/${seg(id)}/quotations`, z.array(ComparisonRowSchema));
}

/** `GET .../:id/submissions`: the RFQ's `received` vendor uploads, for the convert screen. */
export function listSubmissions(session: Session, id: string): Promise<RfqSubmissionItem[]> {
  return call(session, `${RFQ_PATH}/${seg(id)}/submissions`, z.array(RfqSubmissionItemSchema));
}

/**
 * `POST /v1/procurement/rfqs`: 201. 404 for another entity's request; 409 unless the request is
 * `dept_approved`, or `VENDOR_NOT_APPROVED` / `VENDOR_NOT_IN_ENTITY` for an invited vendor.
 */
export function createRfq(
  session: Session,
  body: CreateRfqBody,
  idempotencyKey: string,
): Promise<RfqDto> {
  return call(session, RFQ_PATH, RfqDtoSchema, jsonInit('POST', body, idempotencyKey));
}

/** `POST .../:id/quotations`: 201. 409 when the vendor was not invited, already quoted, or the RFQ is not open. */
export function recordQuotation(
  session: Session,
  id: string,
  body: RecordQuotationBody,
  idempotencyKey: string,
): Promise<QuotationDto> {
  return call(
    session,
    `${RFQ_PATH}/${seg(id)}/quotations`,
    QuotationDtoSchema,
    jsonInit('POST', body, idempotencyKey),
  );
}

/** `POST .../:id/quotations/convert`: 201. A `clean` `received` submission becomes a quotation. */
export function convertSubmission(
  session: Session,
  id: string,
  body: ConvertSubmissionBody,
  idempotencyKey: string,
): Promise<QuotationDto> {
  return call(
    session,
    `${RFQ_PATH}/${seg(id)}/quotations/convert`,
    QuotationDtoSchema,
    jsonInit('POST', body, idempotencyKey),
  );
}

/** `POST .../:id/quotations/:quotationId/scores`: 200 with the refreshed comparison. */
export function scoreQuotation(
  session: Session,
  id: string,
  quotationId: string,
  body: ScoreQuotationBody,
  idempotencyKey: string,
): Promise<ComparisonRow[]> {
  return call(
    session,
    `${RFQ_PATH}/${seg(id)}/quotations/${seg(quotationId)}/scores`,
    z.array(ComparisonRowSchema),
    jsonInit('POST', body, idempotencyKey),
  );
}

/** `POST .../:id/recommendation`: 200. 409 `FEWER_THAN_MIN_QUOTES` without a reason. */
export function recommendQuotation(
  session: Session,
  id: string,
  body: RecommendQuotationBody,
  idempotencyKey: string,
): Promise<RfqDto> {
  return call(
    session,
    `${RFQ_PATH}/${seg(id)}/recommendation`,
    RfqDtoSchema,
    jsonInit('POST', body, idempotencyKey),
  );
}

/** `POST .../:id/commitment`: 200. 422 `NO_ELIGIBLE_APPROVER` (nothing submitted) when a step has nobody. */
export function commitRfq(session: Session, id: string, idempotencyKey: string): Promise<RfqDto> {
  return call(
    session,
    `${RFQ_PATH}/${seg(id)}/commitment`,
    RfqDtoSchema,
    jsonInit('POST', {}, idempotencyKey),
  );
}

/**
 * `POST .../:id/deadline`: 200 with the RFQ. Moves an open RFQ's quotation deadline later (F1-Q47);
 * 409 unless open, 400 `deadline_in_past` for a past instant, 400 for one not after the current one.
 */
export function extendRfqDeadline(
  session: Session,
  id: string,
  body: { deadline: string },
  idempotencyKey: string,
): Promise<RfqDto> {
  return call(
    session,
    `${RFQ_PATH}/${seg(id)}/deadline`,
    RfqDtoSchema,
    jsonInit('POST', body, idempotencyKey),
  );
}
