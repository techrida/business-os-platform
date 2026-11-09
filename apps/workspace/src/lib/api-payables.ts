import 'server-only';

import {
  BillKindSchema,
  BillStatusSchema,
  MatchStatusSchema,
  type BillStatus,
  type VendorBillLineBody,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import type { Session } from './session';

/**
 * Typed calls from the workspace BFF to the payables routes: vendor bills (`/v1/payables/bills`) and
 * the vendor bill inbox (`/v1/payables/bill-submissions`). Server-only: every call carries the
 * user's access token. The contracts package holds the request bodies but no response schemas for
 * these two modules, so the schemas below mirror the API's DTOs (apps/api vendor-bills.service.ts
 * and bill-submissions.service.ts); an API that drifts fails here (502) instead of rendering
 * `undefined`.
 *
 * Money and quantities are strings, exactly as the server sent them: nothing here or in the screens
 * adds, multiplies or rounds them (a bill's totals are the server's). Every POST takes the
 * Idempotency-Key as a required argument, so a missing key is a compile error (the API answers 400
 * without one).
 *
 * Not here yet: match exceptions, payment requests and the VAT register (the next unit).
 */

const Text = z.string();

/** The newest match run of a line. `status` comes from a database enum, so a new value must not be a 502. */
export const BillLineMatchSchema = z.object({
  runNo: z.number().int(),
  status: Text,
  receivedQuantity: Text.nullable(),
  billedQuantity: Text,
  quantityVariance: Text,
  priceVariance: Text,
  taxVariance: Text,
});
export type BillLineMatch = z.infer<typeof BillLineMatchSchema>;

export const BillLineSchema = z.object({
  id: z.guid(),
  lineNo: z.number().int(),
  poLineId: z.guid().nullable(),
  receiptLineId: z.guid().nullable(),
  description: Text,
  accountId: z.guid(),
  quantity: Text,
  unitPrice: Text,
  netAmount: Text,
  taxCodeId: z.guid(),
  vatAmount: Text,
  tdsCodeId: z.guid().nullable(),
  tdsAmount: Text,
  match: BillLineMatchSchema.nullable(),
});
export type BillLine = z.infer<typeof BillLineSchema>;

const billFields = {
  id: z.guid(),
  kind: BillKindSchema,
  number: Text.nullable(),
  vendorPartyId: z.guid(),
  vendorInvoiceNo: Text,
  invoiceDate: Text,
  fiscalYear: Text,
  currency: Text,
  purchaseOrderId: z.guid().nullable(),
  documentId: z.guid(),
  status: BillStatusSchema,
  matchStatus: MatchStatusSchema,
  netTotal: Text,
  vatTotal: Text,
  tdsTotal: Text,
  payableTotal: Text,
  enteredBy: z.guid(),
  approvalRequestId: z.guid().nullable(),
  version: z.number().int(),
};

/** A row of the list: the bill without its lines. */
export const BillListItemSchema = z.object(billFields);
export type BillListItem = z.infer<typeof BillListItemSchema>;

export const VendorBillSchema = z.object({ ...billFields, lines: z.array(BillLineSchema) });
export type VendorBill = z.infer<typeof VendorBillSchema>;

export const BillSubmissionSchema = z.object({
  id: z.guid(),
  vendorPartyId: z.guid().nullable(),
  vendorName: Text.nullable(),
  purchaseOrderId: z.guid().nullable(),
  vendorInvoiceNo: Text.nullable(),
  invoiceDate: Text.nullable(),
  documentId: z.guid(),
  /** The scan status of the newest version of the file; null when it has no version yet. */
  fileStatus: Text.nullable(),
  note: Text.nullable(),
  status: z.literal('received'),
  receivedAt: Text,
});
export type BillSubmission = z.infer<typeof BillSubmissionSchema>;

export const RejectedSubmissionSchema = z.object({
  id: z.guid(),
  status: z.literal('rejected'),
  rejectionReason: Text,
});
export type RejectedSubmission = z.infer<typeof RejectedSubmissionSchema>;

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** One path segment from a caller-supplied id: encoded, so `../` can never climb out of the route. */
const seg = (id: string): string => encodeURIComponent(id);

async function call<T>(
  session: Session,
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const res = await apiFetch(session, path, init);
  const body = await readBody(res);
  const label = `${init?.method ?? 'GET'} ${path.split('?')[0] ?? path}`;
  if (!res.ok) throw new ApiError(res.status, `${label} failed with ${res.status}`, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // 502: the upstream answered, but not with the shape the contract promises.
    throw new ApiError(502, `${label} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

function post(key: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method: 'POST', headers: { 'idempotency-key': key } }
    : {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      };
}

const BILLS = '/v1/payables/bills';
const SUBMISSIONS = '/v1/payables/bill-submissions';

// ------------------------------------------------------------------------------------------ bills

/** `GET .../bills[?status=]` (needs `payables.bill.read`): a bare array, newest first. The query is strict: only `status`. */
export function listBills(session: Session, status?: BillStatus): Promise<BillListItem[]> {
  const path =
    status === undefined
      ? BILLS
      : `${BILLS}?status=${encodeURIComponent(BillStatusSchema.parse(status))}`;
  return call(session, path, z.array(BillListItemSchema));
}

export function getBill(session: Session, id: string): Promise<VendorBill> {
  return call(session, `${BILLS}/${seg(id)}`, VendorBillSchema);
}

/** A new match run (needs `payables.bill.enter`). 409 `MATCH_NOT_REQUIRED` for a bill without a purchase order. */
export function matchBill(
  session: Session,
  id: string,
  idempotencyKey: string,
): Promise<VendorBill> {
  return call(session, `${BILLS}/${seg(id)}/match`, VendorBillSchema, post(idempotencyKey));
}

/** Sends the bill for approval. 409 `BILL_NOT_MATCHED`; 422 `NO_ELIGIBLE_APPROVER`. */
export function submitBill(
  session: Session,
  id: string,
  idempotencyKey: string,
): Promise<VendorBill> {
  return call(session, `${BILLS}/${seg(id)}/submit`, VendorBillSchema, post(idempotencyKey));
}

/** 409 `BILL_NOT_POSTED`, `BILL_HAS_ALLOCATIONS`, `BILL_HAS_PAYMENT_REQUEST`, or `invalid_transition` unless approved. */
export function voidBill(
  session: Session,
  id: string,
  reason: string,
  idempotencyKey: string,
): Promise<VendorBill> {
  return call(
    session,
    `${BILLS}/${seg(id)}/void`,
    VendorBillSchema,
    post(idempotencyKey, { reason }),
  );
}

// ----------------------------------------------------------------------------- bill submissions

/** The entity's `received` submissions, oldest first. There is no route for one submission. */
export function listBillSubmissions(session: Session): Promise<BillSubmission[]> {
  return call(session, SUBMISSIONS, z.array(BillSubmissionSchema));
}

/**
 * Turns a submission into a bill: the lines are the only input, the header comes from the
 * submission. 201. 409 `SUBMISSION_NOT_RECEIVED`, `SUBMISSION_FILE_NOT_CLEAN`, `DUPLICATE_BILL`.
 */
export function convertBillSubmission(
  session: Session,
  id: string,
  lines: readonly VendorBillLineBody[],
  idempotencyKey: string,
): Promise<VendorBill> {
  return call(
    session,
    `${SUBMISSIONS}/${seg(id)}/convert`,
    VendorBillSchema,
    post(idempotencyKey, { lines }),
  );
}

export function rejectBillSubmission(
  session: Session,
  id: string,
  reason: string,
  idempotencyKey: string,
): Promise<RejectedSubmission> {
  return call(
    session,
    `${SUBMISSIONS}/${seg(id)}/reject`,
    RejectedSubmissionSchema,
    post(idempotencyKey, { reason }),
  );
}
