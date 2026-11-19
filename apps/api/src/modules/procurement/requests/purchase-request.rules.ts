// Pure rules of the purchase request (P4 unit P1): line arithmetic, the approval facts and snapshot, the response
// shapes, and the `purchase_request` workflow spec. No I/O, so every rule is cheap to table-test.
// Serves the NFRs "amounts are exact" (decimal.js, ROUND_HALF_UP, strings only: the estimate the approval bands
// read is the sum of lines rounded the way Postgres rounds them) and "approvals are auditable" (the approver
// sees a frozen snapshot of what was asked for).
import {
  PrStatusSchema,
  limitOffset,
  multi,
  searchParam,
  type CreatePurchaseRequestBody,
  type PrRequestType,
  type PrStatus,
  type PurchaseRequestLineBody,
} from '@bos/contracts';
import { PURCHASE_REQUEST_EDITABLE_STATUSES, type purchaseRequests } from '@bos/db';
import { UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { z } from 'zod';

/** approval_requests.document_type of a purchase request; the document id is the request id. */
export const PURCHASE_REQUEST_DOCUMENT_TYPE = 'purchase_request';

/** The numbering series key. Its prefix is `PR`, as in PR-2082/83-00001. */
export const PURCHASE_REQUEST_SERIES = 'PR';

/** The audit entity type of the module's domain events. */
export const PURCHASE_REQUEST_AUDIT_ENTITY = 'purchase_requests';

/** The audit actions that mean "this user edited the request" (the editors of the separation-of-duties list). */
export const PURCHASE_REQUEST_EDIT_ACTIONS: readonly string[] = [
  'procurement.pr.created',
  'procurement.pr.updated',
];

/**
 * The workflow the seed unit publishes for `purchase_request` (v1). AD10: the department head only, no Accountant
 * or Finance step (those belong to the commitment route on the recommended quote). AD11: the head, or
 * `operations_head` when the department has none or the head is the requester. AD12: an emergency request adds
 * Management. Kept here as the one copy the tests and the hand-back quote; the seed copies it word for word.
 */
export const PURCHASE_REQUEST_WORKFLOW_SPEC: unknown = {
  documentType: PURCHASE_REQUEST_DOCUMENT_TYPE,
  steps: [
    {
      id: 'department_head',
      kind: 'department_head',
      fallbackRole: 'operations_head',
      reason: 'Base route: the head of the requesting department approves the need',
    },
  ],
  rules: [
    {
      id: 'emergency',
      when: { field: 'isEmergency', op: 'eq', value: true },
      add: {
        id: 'management',
        kind: 'role',
        role: 'management',
        reason: 'Management approval because this is an emergency purchase request',
      },
      position: 'end',
      reason: 'Emergency purchase request',
    },
  ],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
};

// ---------------------------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------------------------

/** The statuses in which the request and its lines may still change (the DB trigger enforces the same). */
export const isPrEditable = (status: string): boolean =>
  (PURCHASE_REQUEST_EDITABLE_STATUSES as readonly string[]).includes(status);

/** What a decided approval does to a submitted request (AD10: the department route ends at dept_approved). */
export const PR_STATUS_AFTER_DECISION = {
  approved: 'dept_approved',
  returned: 'returned',
  rejected: 'rejected',
} as const satisfies Record<'approved' | 'returned' | 'rejected', PrStatus>;

/**
 * The optional optimistic-lock guard of a command body. The contract bodies of procurement.ts are strict and
 * carry no version, and Zod 4 will not extend a refined schema, so `expectedVersion` is split off the raw body
 * before the contract schema sees the rest. Absent means "the row I lock now" (no lost update either way, since
 * the row is locked FOR UPDATE).
 */
const ExpectedVersionSchema = z.number().int().min(1);
export const ExpectedVersionEnvelopeSchema = z.looseObject({
  expectedVersion: ExpectedVersionSchema.optional(),
});

/** Body of submit and cancel: nothing but an optional `expectedVersion`. */
export const PurchaseRequestCommandBodySchema = z.strictObject({
  expectedVersion: ExpectedVersionSchema.optional(),
});

/** Query of the list route. */
export const ListPurchaseRequestsQuerySchema = z.strictObject({
  status: multi(PrStatusSchema),
  q: searchParam,
  ...limitOffset({ max: 200, fallback: 50 }),
});
export type ListPurchaseRequestsQuery = z.infer<typeof ListPurchaseRequestsQuerySchema>;

// ---------------------------------------------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------------------------------------------

/** round(quantity * unitPrice, 2), half up: what purchase_request_lines_amount_check recomputes in SQL. */
export function lineAmount(quantity: string, unitPrice: string): string {
  return new Decimal(quantity)
    .times(unitPrice)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

/** The sum of the lines' amounts, as a numeric(18,2) string. */
export function sumAmounts(amounts: readonly string[]): string {
  return amounts.reduce((acc, a) => acc.plus(a), new Decimal(0)).toFixed(2);
}

export interface PurchaseRequestLineInsert {
  lineNo: number;
  description: string;
  specification: string | null;
  requiresSerials: boolean;
  uom: string;
  quantity: string;
  estimatedUnitPrice: string;
  estimatedAmount: string;
}

/** The stored lines of a body: numbered from 1 in body order, amounts computed here and never taken from the client. */
export function lineRowsOf(
  lines: readonly PurchaseRequestLineBody[],
  requestType: PrRequestType,
): PurchaseRequestLineInsert[] {
  if (requestType === 'service' && lines.some((line) => line.requiresSerials)) {
    throw new UnprocessableEntityException({
      code: 'serials_not_allowed',
      message: 'Service purchase request lines cannot require serial numbers',
    });
  }
  return lines.map((l, i) => ({
    lineNo: i + 1,
    description: l.description,
    specification: l.specification ?? null,
    requiresSerials: l.requiresSerials ?? false,
    uom: l.uom,
    quantity: l.quantity,
    estimatedUnitPrice: l.estimatedUnitPrice,
    estimatedAmount: lineAmount(l.quantity, l.estimatedUnitPrice),
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Approval facts and snapshot
// ---------------------------------------------------------------------------------------------------------------

export interface PurchaseRequestFacts extends Record<string, unknown> {
  departmentId: string;
  isEmergency: boolean;
  /** The NPR estimate as a numeric(18,2) string; a later band rule may read it. */
  amountNpr: string;
}

export function approvalFactsOf(pr: {
  departmentId: string;
  isEmergency: boolean;
  amountNpr: string;
}): PurchaseRequestFacts {
  return {
    departmentId: pr.departmentId,
    isEmergency: pr.isEmergency,
    amountNpr: pr.amountNpr,
  };
}

export type PurchaseRequestRow = typeof purchaseRequests.$inferSelect;

export interface PurchaseRequestLineRow {
  id: string;
  lineNo: number;
  description: string;
  specification: string | null;
  requiresSerials?: boolean;
  uom: string;
  quantity: string;
  estimatedUnitPrice: string;
  estimatedAmount: string;
}

/** What the department head is shown: frozen at submit and hashed by the approval engine. */
export function buildApprovalSnapshot(i: {
  number: string;
  pr: Pick<
    PurchaseRequestRow,
    | 'requestType'
    | 'departmentId'
    | 'requesterUserId'
    | 'justification'
    | 'requiredBy'
    | 'budgetCode'
    | 'currency'
    | 'isEmergency'
    | 'emergencyReason'
  >;
  estimatedTotal: string;
  estimatedTotalNpr: string;
  lines: readonly PurchaseRequestLineRow[];
}): Record<string, unknown> {
  return {
    purchaseRequest: {
      number: i.number,
      requestType: i.pr.requestType,
      departmentId: i.pr.departmentId,
      requesterUserId: i.pr.requesterUserId,
      justification: i.pr.justification,
      requiredBy: i.pr.requiredBy,
      budgetCode: i.pr.budgetCode,
      currency: i.pr.currency,
      estimatedTotal: i.estimatedTotal,
      estimatedTotalNpr: i.estimatedTotalNpr,
      isEmergency: i.pr.isEmergency,
      emergencyReason: i.pr.emergencyReason,
      lines: i.lines.map((l) => ({
        lineNo: l.lineNo,
        description: l.description,
        requiresSerials: l.requiresSerials ?? false,
        uom: l.uom,
        quantity: l.quantity,
        estimatedUnitPrice: l.estimatedUnitPrice,
        estimatedAmount: l.estimatedAmount,
      })),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Response shapes (procurement.ts has no response DTO yet; proposed for the contracts unit)
// ---------------------------------------------------------------------------------------------------------------

export interface PurchaseRequestLineDto {
  id: string;
  lineNo: number;
  description: string;
  specification: string | null;
  requiresSerials: boolean;
  uom: string;
  /** numeric(18,4) as stored, e.g. "2.0000". */
  quantity: string;
  estimatedUnitPrice: string;
  estimatedAmount: string;
}

export interface PurchaseRequestListItem {
  id: string;
  /** Null until submit: the PR number is taken from the series at submit. */
  number: string | null;
  requestType: PrRequestType;
  departmentId: string;
  requesterUserId: string;
  costCenterId: string;
  justification: string;
  requiredBy: string;
  deliveryLocation: string | null;
  budgetCode: string;
  projectId: string | null;
  currency: string;
  estimatedTotal: string;
  /** The NPR estimate and its FX snapshot; null while the request is a draft or returned for edit. */
  estimatedTotalNpr: string | null;
  fxRate: string | null;
  fxSource: string | null;
  fxDate: string | null;
  isEmergency: boolean;
  emergencyReason: string | null;
  status: PrStatus;
  approvalRequestId: string | null;
  /** The request's live RFQ (not cancelled; at most one exists), or null before sourcing starts. */
  rfqId: string | null;
  submittedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseRequestDto extends PurchaseRequestListItem {
  lines: PurchaseRequestLineDto[];
}

export function toListItem(row: PurchaseRequestRow, rfqId: string | null): PurchaseRequestListItem {
  return {
    id: row.id,
    number: row.number,
    requestType: row.requestType,
    departmentId: row.departmentId,
    requesterUserId: row.requesterUserId,
    costCenterId: row.costCenterId,
    justification: row.justification,
    requiredBy: row.requiredBy,
    deliveryLocation: row.deliveryLocation,
    budgetCode: row.budgetCode,
    projectId: row.projectId,
    currency: row.currency,
    estimatedTotal: row.estimatedTotal,
    estimatedTotalNpr: row.estimatedTotalNpr,
    fxRate: row.fxRate,
    fxSource: row.fxSource,
    fxDate: row.fxDate,
    isEmergency: row.isEmergency,
    emergencyReason: row.emergencyReason,
    status: row.status,
    approvalRequestId: row.approvalRequestId,
    rfqId,
    submittedAt: row.submittedAt === null ? null : row.submittedAt.toISOString(),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toDto(
  row: PurchaseRequestRow,
  lines: readonly PurchaseRequestLineRow[],
  rfqId: string | null,
): PurchaseRequestDto {
  return {
    ...toListItem(row, rfqId),
    lines: [...lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        description: l.description,
        specification: l.specification,
        requiresSerials: l.requiresSerials ?? false,
        uom: l.uom,
        quantity: l.quantity,
        estimatedUnitPrice: l.estimatedUnitPrice,
        estimatedAmount: l.estimatedAmount,
      })),
  };
}

/** The columns of a body that live on the request row itself (everything but the lines). */
export function headerColumnsOf(body: CreatePurchaseRequestBody) {
  return {
    requestType: body.requestType,
    departmentId: body.departmentId,
    costCenterId: body.costCenterId,
    justification: body.justification,
    requiredBy: body.requiredBy,
    deliveryLocation: body.deliveryLocation ?? null,
    budgetCode: body.budgetCode,
    projectId: body.projectId ?? null,
    currency: body.currency,
    isEmergency: body.isEmergency,
    emergencyReason: body.isEmergency ? (body.emergencyReason ?? null) : null,
  };
}
