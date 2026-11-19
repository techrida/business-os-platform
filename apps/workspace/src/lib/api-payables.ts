import 'server-only';

import {
  BillKindSchema,
  BillStatusSchema,
  CurrencySchema,
  MatchStatusSchema,
  DocumentVersionDtoSchema,
  type CreateVendorBillBody,
  type CreateDocumentBody,
  MatchExceptionStatusSchema,
  PaymentRequestStatusSchema,
  PaymentTypeSchema,
  type BillStatus,
  type PaymentRequestStatus,
  type RequestPaymentBody,
  type RequestMatchExceptionBody,
  type VendorBillLineBody,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import { callList, listQuery } from './api-procurement';
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
 * Includes match exceptions, payment requests and the purchase VAT register.
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
  vendorName: Text,
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

export const VendorBillSchema = z.object({
  ...billFields,
  /** Scan status of the newest non-rejected invoice version; absent in older API responses. */
  fileStatus: Text.nullable().optional(),
  lines: z.array(BillLineSchema),
});
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
  /** What the vendor said the bill totals, and its currency; null when unknown. Older APIs leave them out. */
  claimedTotal: Text.nullable().default(null),
  currency: Text.nullable().default(null),
  /**
   * Earlier bills and other submissions of this vendor with the same invoice number (any status but rejected).
   * A warning only: the bill can still be keyed.
   */
  duplicates: z
    .array(
      z.object({
        kind: z.enum(['bill', 'submission']),
        id: z.guid(),
        number: Text.nullable(),
        vendorInvoiceNo: Text,
        status: Text,
        amount: Text.nullable(),
        currency: Text.nullable(),
        at: Text,
      }),
    )
    .default([]),
});
export type BillSubmission = z.infer<typeof BillSubmissionSchema>;
export type InvoiceDuplicate = BillSubmission['duplicates'][number];

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

/**
 * One page of `GET .../bills` with several statuses, a search over number, vendor invoice and vendor name, and
 * `offset`, plus the total of all matches from `X-Total-Count`. The API scopes the rows; nothing here widens that.
 */
export function listBillsPage(
  session: Session,
  query: { status?: readonly BillStatus[]; q?: string; limit: number; offset: number },
): Promise<{ items: BillListItem[]; total: number }> {
  return callList(
    session,
    listQuery(BILLS, {
      status: query.status?.map((s) => BillStatusSchema.parse(s)),
      q: query.q,
      limit: query.limit,
      offset: query.offset,
    }),
    BillListItemSchema,
  );
}

export function getBill(session: Session, id: string): Promise<VendorBill> {
  return call(session, `${BILLS}/${seg(id)}`, VendorBillSchema);
}

export function createBill(
  session: Session,
  body: CreateVendorBillBody,
  key: string,
): Promise<VendorBill> {
  return call(session, BILLS, VendorBillSchema, post(key, body));
}

const BillDocumentSchema = z.object({
  documentId: z.guid(),
  versionId: z.guid(),
  uploadPath: Text,
});
type BillDocument = z.infer<typeof BillDocumentSchema>;
export function createBillDocument(
  session: Session,
  vendorPartyId: string,
  file: Pick<CreateDocumentBody, 'filename' | 'declaredMime' | 'sizeBytes'>,
): Promise<BillDocument> {
  return call(session, '/v1/payables/bill-documents', BillDocumentSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vendorPartyId, ...file }),
  });
}

export function replaceBillDocument(
  session: Session,
  documentId: string,
  file: Pick<CreateDocumentBody, 'filename' | 'declaredMime' | 'sizeBytes'>,
): Promise<BillDocument> {
  return call(
    session,
    `/v1/payables/bill-documents/${seg(documentId)}/versions`,
    BillDocumentSchema,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(file),
    },
  );
}

export function uploadBillDocumentContent(
  session: Session,
  created: BillDocument,
  upload: { body: ReadableStream<Uint8Array>; contentLength: number; contentType: string },
) {
  const expected = `/v1/payables/bill-documents/${created.documentId}/versions/${created.versionId}/content`;
  if (created.uploadPath !== expected)
    throw new ApiError(502, 'The invoice upload returned an unexpected content path');
  const init: RequestInit & { duplex: 'half' } = {
    method: 'PUT',
    headers: { 'content-type': upload.contentType, 'content-length': String(upload.contentLength) },
    body: upload.body,
    duplex: 'half',
  };
  return call(session, expected, DocumentVersionDtoSchema, init);
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

/** Discards only a draft, releasing its invoice-number reservation. */
export function discardBill(
  session: Session,
  id: string,
  idempotencyKey: string,
): Promise<VendorBill> {
  return call(session, `${BILLS}/${seg(id)}/discard`, VendorBillSchema, post(idempotencyKey));
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
 * One page of the inbox with a search over the vendor invoice number and vendor name, plus the total of all
 * matches. Only the page asks for a window; `listBillSubmissions` stays the whole list.
 */
export function listBillSubmissionsPage(
  session: Session,
  query: { q?: string; limit: number; offset: number },
): Promise<{ items: BillSubmission[]; total: number }> {
  return callList(
    session,
    listQuery(SUBMISSIONS, { q: query.q, limit: query.limit, offset: query.offset }),
    BillSubmissionSchema,
  );
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

export const MatchExceptionSchema = z.object({
  id: z.guid(),
  vendorBillId: z.guid(),
  reason: Text,
  status: MatchExceptionStatusSchema,
  requestedBy: z.guid(),
  decidedBy: z.guid().nullable(),
  approvalRequestId: z.guid().nullable(),
});

export function requestBillException(
  session: Session,
  id: string,
  body: RequestMatchExceptionBody,
  key: string,
) {
  return call(session, `${BILLS}/${seg(id)}/exceptions`, MatchExceptionSchema, post(key, body));
}

const paymentFields = {
  id: z.guid(),
  number: Text.nullable(),
  vendorPartyId: z.guid(),
  paymentType: PaymentTypeSchema,
  purchaseOrderId: z.guid().nullable(),
  currency: Text,
  totalAmount: Text,
  fromBankAccountId: z.guid(),
  vendorBankAccountId: z.guid(),
  bankLast4: Text,
  status: PaymentRequestStatusSchema,
  requestedBy: z.guid(),
  approvalRequestId: z.guid().nullable(),
  cancelReason: Text.nullable(),
  version: z.number().int(),
};
export const PaymentRequestListSchema = z.object(paymentFields);
export const PaymentRequestSchema = z.object({
  ...paymentFields,
  lines: z.array(
    z.object({
      id: z.guid(),
      lineNo: z.number().int(),
      openItemId: z.guid(),
      amount: Text,
    }),
  ),
});
export type PaymentRequest = z.infer<typeof PaymentRequestSchema>;
export type PaymentRequestListItem = z.infer<typeof PaymentRequestListSchema>;
const REQUESTS = '/v1/payables/payment-requests';

export const PaymentRequestItemSchema = z.object({
  openItemId: z.guid(),
  vendorPartyId: z.guid(),
  vendorName: Text,
  vendorBillId: z.guid(),
  billNumber: Text.nullable(),
  vendorInvoiceNo: Text,
  currency: CurrencySchema,
  openAmount: Text,
  claimedAmount: Text,
  availableAmount: Text,
});
export type PaymentRequestItem = z.infer<typeof PaymentRequestItemSchema>;

/** Approved bill items with availability calculated by the server after existing payment requests. */
export function listPaymentRequestItems(session: Session): Promise<PaymentRequestItem[]> {
  return call(session, `${REQUESTS}/items`, z.array(PaymentRequestItemSchema));
}

export function listPaymentRequests(
  session: Session,
  status?: PaymentRequestStatus,
): Promise<PaymentRequestListItem[]> {
  const query = status === undefined ? '' : `?status=${PaymentRequestStatusSchema.parse(status)}`;
  return call(session, `${REQUESTS}${query}`, z.array(PaymentRequestListSchema));
}

/**
 * One page of `GET .../payment-requests` with several statuses, a search over number and vendor name, and
 * `offset`, plus the total of all matches from `X-Total-Count`.
 */
export function listPaymentRequestsPage(
  session: Session,
  query: { status?: readonly PaymentRequestStatus[]; q?: string; limit: number; offset: number },
): Promise<{ items: PaymentRequestListItem[]; total: number }> {
  return callList(
    session,
    listQuery(REQUESTS, {
      status: query.status?.map((s) => PaymentRequestStatusSchema.parse(s)),
      q: query.q,
      limit: query.limit,
      offset: query.offset,
    }),
    PaymentRequestListSchema,
  );
}

export function getPaymentRequest(session: Session, id: string): Promise<PaymentRequest> {
  return call(session, `${REQUESTS}/${seg(id)}`, PaymentRequestSchema);
}

export function createPaymentRequest(
  session: Session,
  body: RequestPaymentBody,
  key: string,
): Promise<PaymentRequest> {
  return call(session, REQUESTS, PaymentRequestSchema, post(key, body));
}

export function submitPaymentRequest(
  session: Session,
  id: string,
  key: string,
): Promise<PaymentRequest> {
  return call(session, `${REQUESTS}/${seg(id)}/submit`, PaymentRequestSchema, post(key));
}

export function cancelPaymentRequest(
  session: Session,
  id: string,
  reason: string,
  key: string,
): Promise<PaymentRequest> {
  return call(
    session,
    `${REQUESTS}/${seg(id)}/cancel`,
    PaymentRequestSchema,
    post(key, { reason }),
  );
}

export const VatPeriodSchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((v) => v.from <= v.to, {
    message: 'The end date must be on or after the start date.',
    path: ['to'],
  });
export const VatRegisterSchema = z.object({
  from: Text,
  to: Text,
  rows: z.array(
    z.object({
      vendorBillId: z.guid(),
      billNumber: Text.nullable(),
      vendorPartyId: z.guid(),
      vendorName: Text,
      vendorPan: Text.nullable(),
      vendorInvoiceNo: Text,
      invoiceDate: Text,
      invoiceDateBs: Text,
      taxableAmount: Text,
      vatAmount: Text,
    }),
  ),
  total: z.object({ taxableAmount: Text, vatAmount: Text }),
});
export type VatRegister = z.infer<typeof VatRegisterSchema>;

export function getVatRegister(session: Session, from: string, to: string): Promise<VatRegister> {
  const period = VatPeriodSchema.parse({ from, to });
  return call(
    session,
    `/v1/payables/vat-register?${new URLSearchParams(period)}`,
    VatRegisterSchema,
  );
}
