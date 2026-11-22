import 'server-only';

import {
  type AmendPurchaseOrderBody,
  type ConfirmReceiptBody,
  PoStatusSchema,
  PurchaseOrderAdvancePercentSchema,
  ReceiptKindSchema,
  ReceiptStatusSchema,
  type PoStatus,
  type SignedLinkDto,
  SignedLinkDtoSchema,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import { callList, listQuery } from './api-procurement';
import type { Session } from './session';

/**
 * Typed calls from the workspace BFF to the P4 purchase order routes (`/v1/procurement/purchase-orders`)
 * and the goods and service receipt routes (`/v1/procurement/receipts`). Server-only: every call
 * carries the user's access token. The contracts package holds the request bodies but no response
 * schemas for these two modules, so the schemas below mirror the API's DTOs (apps/api
 * purchase-orders.service.ts and receipt.rules.ts); an API that drifts fails here (502) instead of
 * rendering `undefined`.
 *
 * Money and quantities are strings, exactly as the server sent them: nothing here or in the screens
 * adds, multiplies or rounds them. Every POST takes the Idempotency-Key as a required argument, so a
 * missing key is a compile error (the API answers 400 without one).
 */

const Text = z.string();

export const PoLineSchema = z.object({
  id: z.guid(),
  lineNo: z.number().int(),
  prLineId: z.guid().nullable(),
  kind: Text,
  description: Text,
  uom: Text,
  orderedQuantity: Text,
  cancelledQuantity: Text,
  unitPrice: Text,
  taxCodeId: z.guid(),
  gross: Text,
  taxAmount: Text,
  lineTotal: Text,
  requiresSerials: z.boolean(),
});

const poFields = {
  id: z.guid(),
  number: Text,
  status: PoStatusSchema,
  purchaseRequestId: z.guid(),
  rfqId: z.guid().nullable(),
  vendorQuotationId: z.guid().nullable(),
  vendorId: z.guid(),
  currency: Text,
  paymentTermsDays: z.number().int(),
  advancePercent: PurchaseOrderAdvancePercentSchema,
  approvedTotal: Text,
  fxRate: Text,
  approvedTotalNpr: Text,
  approvedBand: Text,
  currentVersion: z.number().int(),
  issuedAt: Text.nullable(),
  closedReason: Text.nullable(),
  version: z.number().int(),
};

/** A row of the list: the PO without its lines, always with its vendor's legal name. */
export const PoListItemSchema = z.object({ ...poFields, vendorName: Text });
export type PoListItem = z.infer<typeof PoListItemSchema>;

export const PurchaseOrderSchema = z.object({
  ...poFields,
  /** The vendor's legal name: sent by the detail read, left out by the write routes. */
  vendorName: Text.optional(),
  lines: z.array(PoLineSchema),
  /** A draft with no lines yet: the approved quotation's lines that issue will copy in. Read-only. */
  proposedLines: z.array(PoLineSchema).optional(),
  /**
   * What the caller may do from this order, from their live grants. Sent by the detail read only: `enterBill` on an
   * order a bill can be entered against, `receive` on one that still takes receipts (the warehouse, or the requester
   * of a service). A read-only reader gets false for both.
   */
  can: z.object({ enterBill: z.boolean(), receive: z.boolean() }).optional(),
  /** A draft whose change of vendor waits for approval: it cannot be issued until that is decided. */
  pendingVendorChange: z
    .object({ approvalRequestId: z.guid(), vendorId: z.guid(), total: Text })
    .nullable()
    .optional(),
});
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;

export const PoVersionSchema = z.object({
  id: z.guid(),
  version: z.number().int().min(1),
  reason: Text.nullable(),
  total: Text,
  totalNpr: Text,
  band: Text,
  approvalRequestId: z.guid().nullable(),
  createdBy: z.guid(),
  createdAt: Text,
  snapshot: z.unknown(),
});
export type PoVersion = z.infer<typeof PoVersionSchema>;

export const AmendResultSchema = z.object({
  outcome: z.enum(['applied', 'pending_approval']),
  approvalRequestId: z.guid().nullable(),
  purchaseOrder: PurchaseOrderSchema,
});
export type AmendResult = z.infer<typeof AmendResultSchema>;

export const PoProgressLineSchema = z.object({
  poLineId: z.guid(),
  lineNo: z.number().int(),
  kind: ReceiptKindSchema,
  description: Text,
  uom: Text,
  requiresSerials: z.boolean(),
  orderedQuantity: Text,
  cancelledQuantity: Text,
  receivedQuantity: Text,
  pendingQuantity: Text,
  openQuantity: Text,
  billedQuantity: Text,
});
export type PoProgressLine = z.infer<typeof PoProgressLineSchema>;

export const PoProgressSchema = z.object({
  purchaseOrderId: z.guid(),
  vendorId: z.guid(),
  vendorName: Text,
  number: Text,
  status: PoStatusSchema,
  lines: z.array(PoProgressLineSchema),
  /** Which kinds of receipt the person may make on this order, from their live grants on it. */
  can: z.object({ goods: z.boolean(), service: z.boolean() }).optional(),
});
export type PoProgress = z.infer<typeof PoProgressSchema>;

export const ReceiptLineSchema = z.object({
  id: z.guid(),
  lineNo: z.number().int(),
  poLineId: z.guid(),
  quantity: Text,
  reversesReceiptLineId: z.guid().nullable(),
  inspection: Text.nullable(),
  discrepancyNote: Text.nullable(),
  serials: z.array(
    z.object({ serialNo: Text, batchNo: Text.nullable(), warrantyUntil: Text.nullable() }),
  ),
});

export const ReceiptSchema = z.object({
  id: z.guid(),
  number: Text,
  purchaseOrderId: z.guid(),
  kind: ReceiptKindSchema,
  receivedAt: Text,
  location: Text.nullable(),
  status: ReceiptStatusSchema,
  createdBy: z.guid(),
  confirmedBy: z.guid().nullable(),
  confirmedAt: Text.nullable(),
  reversesReceiptId: z.guid().nullable(),
  reversalReason: Text.nullable(),
  version: z.number().int(),
  createdAt: Text,
  lines: z.array(ReceiptLineSchema),
  /**
   * What the person may do with this receipt, from their live grants on the order and its statuses. Sent by the list
   * and detail reads; the write routes leave it out.
   */
  can: z.object({ confirm: z.boolean(), discard: z.boolean(), reverse: z.boolean() }).optional(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

/**
 * A row of the receiving picker (apps/api receivable-orders.service.ts). Strict: a field the DTO
 * does not have fails the parse. `openQuantity` is the server's decimal text (four places).
 */
export const ReceivableOrderSchema = z.strictObject({
  id: z.guid(),
  number: Text,
  vendorId: z.guid(),
  vendorName: Text,
  kind: z.enum(['goods', 'service', 'mixed']),
  status: z.enum(['issued', 'partially_received']),
  issuedAt: Text.optional(),
  openQuantity: Text,
});
export type ReceivableOrder = z.infer<typeof ReceivableOrderSchema>;

/**
 * A row of the warehouse's recently received list (apps/api receivable-orders.service.ts, U18-Q3): an order that is
 * fully received, closed or short-closed. Strict: a field the DTO does not have fails the parse.
 */
export const ReceivedOrderSchema = z.strictObject({
  id: z.guid(),
  number: Text,
  vendorId: z.guid(),
  vendorName: Text,
  kind: z.enum(['goods', 'service', 'mixed']),
  status: z.enum(['fully_received', 'closed', 'short_closed']),
  lastReceivedAt: Text.optional(),
});
export type ReceivedOrder = z.infer<typeof ReceivedOrderSchema>;

/** One purchase order raised from the caller's own purchase requests: the receipts picker of a requester. */
export const RequestedOrderSchema = z.strictObject({
  id: z.guid(),
  number: Text,
  status: PoStatusSchema,
  vendorName: Text,
});
export type RequestedOrder = z.infer<typeof RequestedOrderSchema>;

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

const PO = '/v1/procurement/purchase-orders';
const GRN = '/v1/procurement/receipts';

// ------------------------------------------------------------------------------- purchase orders

/** One page of the purchase orders with several statuses, a search over number and vendor, and `offset`, plus the total of all matches. */
export function listPurchaseOrdersPage(
  session: Session,
  query: { status?: readonly PoStatus[]; q?: string; limit: number; offset: number },
): Promise<{ items: PoListItem[]; total: number }> {
  return callList(
    session,
    listQuery(PO, {
      status: query.status?.map((s) => PoStatusSchema.parse(s)),
      q: query.q,
      limit: query.limit,
      offset: query.offset,
    }),
    PoListItemSchema,
  );
}

export function getPurchaseOrder(session: Session, id: string): Promise<PurchaseOrder> {
  return call(session, `${PO}/${seg(id)}`, PurchaseOrderSchema);
}

/** Every issued version, oldest first. */
export function listPoVersions(session: Session, id: string): Promise<PoVersion[]> {
  return call(session, `${PO}/${seg(id)}/versions`, z.array(PoVersionSchema));
}

/** Ordered, received, pending, open and billed per line. Open to whoever may read or confirm receipts. */
export function getPoProgress(session: Session, id: string): Promise<PoProgress> {
  return call(session, `${PO}/${seg(id)}/progress`, PoProgressSchema);
}

/**
 * 409 `VENDOR_NOT_APPROVED`, `VENDOR_NOT_IN_ENTITY`, `PO_HAS_NO_LINES`, or `invalid_transition` unless a draft. With
 * `expectedVersion` (the `version` the person saw), 409 `PO_CHANGED` when the order was edited since; without it, no body.
 */
export function issuePurchaseOrder(
  session: Session,
  id: string,
  idempotencyKey: string,
  expectedVersion?: number,
): Promise<PurchaseOrder> {
  return call(
    session,
    `${PO}/${seg(id)}/issue`,
    PurchaseOrderSchema,
    post(idempotencyKey, expectedVersion === undefined ? undefined : { expectedVersion }),
  );
}

/** `applied` writes version N+1; `pending_approval` leaves the PO in `amendment_pending` (a band rise). */
export function amendPurchaseOrder(
  session: Session,
  id: string,
  body: AmendPurchaseOrderBody,
  idempotencyKey: string,
): Promise<AmendResult> {
  return call(session, `${PO}/${seg(id)}/amend`, AmendResultSchema, post(idempotencyKey, body));
}

export function shortClosePurchaseOrder(
  session: Session,
  id: string,
  reason: string,
  idempotencyKey: string,
): Promise<PurchaseOrder> {
  return call(
    session,
    `${PO}/${seg(id)}/short-close`,
    PurchaseOrderSchema,
    post(idempotencyKey, { reason }),
  );
}

/** 409 `PO_HAS_RECEIPTS` once anything was received. */
export function cancelPurchaseOrder(
  session: Session,
  id: string,
  reason: string,
  idempotencyKey: string,
): Promise<PurchaseOrder> {
  return call(
    session,
    `${PO}/${seg(id)}/cancel`,
    PurchaseOrderSchema,
    post(idempotencyKey, { reason }),
  );
}

/**
 * Moves a draft to another vendor (F1-Q40 a): lines, prices and total stay, the payment terms come from the new
 * vendor. 409 `PO_VENDOR_CHANGE_NOT_DRAFT` unless a draft, `PO_VENDOR_UNCHANGED`, `VENDOR_NOT_APPROVED`,
 * `VENDOR_NOT_IN_ENTITY` or `VENDOR_NO_VERIFIED_BANK_ACCOUNT`.
 */
export function changePurchaseOrderVendor(
  session: Session,
  id: string,
  vendorId: string,
  idempotencyKey: string,
  acknowledgeVatWarning = false,
): Promise<PurchaseOrder> {
  return call(
    session,
    `${PO}/${seg(id)}/change-vendor`,
    PurchaseOrderSchema,
    post(
      idempotencyKey,
      acknowledgeVatWarning ? { vendorId, acknowledgeVatWarning } : { vendorId },
    ),
  );
}

/** Cancels an issued order and answers the NEW draft raised from it. 409 unless issued, `PO_HAS_RECEIPTS`. */
export function cancelAndRecreatePurchaseOrder(
  session: Session,
  id: string,
  reason: string,
  idempotencyKey: string,
): Promise<PurchaseOrder> {
  return call(
    session,
    `${PO}/${seg(id)}/cancel-and-recreate`,
    PurchaseOrderSchema,
    post(idempotencyKey, { reason }),
  );
}

/**
 * `GET .../:id/versions/:version/document`: a short-lived, single-use signed link to that version's
 * PDF. 409 while the file is being prepared, 424 once its render was given up, 404 when there is none
 * to hand out. A refusal issues no link; every successful call issues a new one.
 */
export function issuePoDocumentLink(
  session: Session,
  id: string,
  version: number,
): Promise<SignedLinkDto> {
  return call(
    session,
    `${PO}/${seg(id)}/versions/${seg(String(version))}/document`,
    SignedLinkDtoSchema,
  );
}

// ----------------------------------------------------------------------------------------- receipts

/** The receipts of one purchase order, newest first. The query is strict: only `purchaseOrderId`. */
export function listReceipts(session: Session, purchaseOrderId: string): Promise<Receipt[]> {
  return call(
    session,
    `${GRN}?purchaseOrderId=${encodeURIComponent(purchaseOrderId)}`,
    z.array(ReceiptSchema),
  );
}

/**
 * `GET /v1/procurement/receivable-orders[?limit=]` (needs `procurement.receipt.confirm`): the
 * purchase orders that still take receipts, newest issued first. The query is strict: only `limit`
 * (1 to 200, 50 when left out).
 */
export function listReceivableOrders(session: Session, limit?: number): Promise<ReceivableOrder[]> {
  const path =
    limit === undefined
      ? '/v1/procurement/receivable-orders'
      : `/v1/procurement/receivable-orders?limit=${encodeURIComponent(String(limit))}`;
  return call(session, path, z.array(ReceivableOrderSchema));
}

/** The orders the warehouse has finished with (needs procurement.receipt.confirm), most recently received first. */
export function listReceivedOrders(session: Session): Promise<ReceivedOrder[]> {
  return call(session, '/v1/procurement/received-orders', z.array(ReceivedOrderSchema));
}

/** The purchase orders of the caller's own purchase requests (needs procurement.pr.read), newest first. */
export function listRequestedOrders(session: Session): Promise<RequestedOrder[]> {
  return call(session, '/v1/procurement/requested-orders', z.array(RequestedOrderSchema));
}

export function getReceipt(session: Session, id: string): Promise<Receipt> {
  return call(session, `${GRN}/${seg(id)}`, ReceiptSchema);
}

/** 201 with a draft receipt (the GRN number is taken). 422 for an over-receipt, serial counts and the like. */
export function createReceipt(
  session: Session,
  body: ConfirmReceiptBody,
  idempotencyKey: string,
): Promise<Receipt> {
  return call(session, GRN, ReceiptSchema, post(idempotencyKey, body));
}

export function confirmReceipt(
  session: Session,
  id: string,
  idempotencyKey: string,
): Promise<Receipt> {
  return call(session, `${GRN}/${seg(id)}/confirm`, ReceiptSchema, post(idempotencyKey));
}

/** Discards only a draft, releasing its reserved quantity; repeats return the discarded receipt. */
export function discardReceipt(
  session: Session,
  id: string,
  idempotencyKey: string,
): Promise<Receipt> {
  return call(session, `${GRN}/${seg(id)}/discard`, ReceiptSchema, post(idempotencyKey));
}

/** Answers the reversal: a new confirmed receipt with negative quantities. */
export function reverseReceipt(
  session: Session,
  id: string,
  reason: string,
  idempotencyKey: string,
): Promise<Receipt> {
  return call(
    session,
    `${GRN}/${seg(id)}/reverse`,
    ReceiptSchema,
    post(idempotencyKey, { reason }),
  );
}
