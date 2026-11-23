// The vendor portal's view mappers (P4 unit PV1). Serves the NFR "a vendor sees only what we meant to show": every
// view is built field by field from named inputs and parsed by its strict contract schema, so a row with extra
// columns (an approval band, a cost centre, a match status, who entered a bill) cannot ride along, and a schema that
// gains a key is caught by portal-vendor.contract.test.ts.
// Rules kept here, pure, so the unit and contract tests pin them without a database:
// - a purchase order is shown only as its newest issued version (a `purchase_order_versions` row); while an
//   amendment waits for approval the vendor keeps seeing that version, with the status its receipts give;
// - a bill's status is coarse (received, under_review, approved_for_payment, rejected); a voided bill and a vendor
//   credit note are not shown;
// - an onboarding item is `missing`, `submitted`, `accepted`, `rejected` or `expired`, never a reviewer's note.
import {
  isVendorVisiblePoStatus,
  type PoStatus,
  vendorPortalCapability,
  VendorPortalBillViewSchema,
  VendorPortalOnboardingViewSchema,
  VendorPortalPurchaseOrderListItemSchema,
  VendorPortalPurchaseOrderViewSchema,
  type VendorKycDocType,
  type VendorPortalBillStatus,
  type VendorPortalBillView,
  type VendorPortalOnboardingView,
  type VendorPortalPurchaseOrderListItem,
  type VendorPortalPurchaseOrderView,
  type VendorStatus,
  VENDOR_KYC_DOC_TYPES,
} from '@bos/contracts';
import { z } from 'zod';

import { derivePoStatus } from '../procurement/receipts/receipt.rules';
import { kathmanduDay } from '../quotations/reference/reference.types';

// ---------------------------------------------------------------------------------------------- purchase orders

/** What the view reads of a version's frozen snapshot (snapshotOf in purchase-order.writes.ts). Extra keys ignored. */
const SnapshotSchema = z.object({
  purchaseOrder: z.object({ currency: z.string(), paymentTermsDays: z.number().int() }),
  lines: z.array(
    z.object({
      id: z.string(),
      lineNo: z.number().int(),
      description: z.string(),
      uom: z.string(),
      orderedQuantity: z.string(),
      cancelledQuantity: z.string(),
      unitPrice: z.string(),
    }),
  ),
});

/** One purchase order of the caller with its newest issued version, as the store reads it. */
export interface PoSource {
  id: string;
  number: string;
  status: PoStatus;
  version: { id: string; version: number; total: string; snapshot: unknown; createdAt: Date };
}

/**
 * The status a vendor sees, or undefined when the order is not for the vendor's eyes (a draft). While an amendment
 * waits for approval the last issued version stands, so its status is what the confirmed receipts give.
 */
export function vendorPoStatus(
  status: PoStatus,
  lines: readonly { id: string; orderedQuantity: string; cancelledQuantity: string }[],
  received: ReadonlyMap<string, string>,
): VendorPortalPurchaseOrderView['status'] | undefined {
  if (isVendorVisiblePoStatus(status)) return status;
  if (status !== 'amendment_pending') return undefined;
  const derived = derivePoStatus(
    lines.map((l) => ({
      orderedQuantity: l.orderedQuantity,
      cancelledQuantity: l.cancelledQuantity,
      receivedQuantity: received.get(l.id) ?? '0',
    })),
  );
  return isVendorVisiblePoStatus(derived) ? derived : undefined;
}

/** The list row of one order; undefined when the vendor may not see it. */
export function toPurchaseOrderListItem(
  src: PoSource,
  received: ReadonlyMap<string, string>,
): VendorPortalPurchaseOrderListItem | undefined {
  const snapshot = SnapshotSchema.parse(src.version.snapshot);
  const status = vendorPoStatus(src.status, snapshot.lines, received);
  if (status === undefined) return undefined;
  return VendorPortalPurchaseOrderListItemSchema.parse({
    id: src.id,
    number: src.number,
    version: src.version.version,
    status,
    issueDate: kathmanduDay(src.version.createdAt),
    currency: snapshot.purchaseOrder.currency,
    total: src.version.total,
  });
}

/** The full view of one order at its newest issued version; undefined when the vendor may not see it. */
export function toPurchaseOrderView(
  src: PoSource,
  received: ReadonlyMap<string, string>,
  file: { documentId: string; filename: string; sha256: string } | null,
): VendorPortalPurchaseOrderView | undefined {
  const snapshot = SnapshotSchema.parse(src.version.snapshot);
  const status = vendorPoStatus(src.status, snapshot.lines, received);
  if (status === undefined) return undefined;
  return VendorPortalPurchaseOrderViewSchema.parse({
    id: src.id,
    number: src.number,
    version: src.version.version,
    status,
    issueDate: kathmanduDay(src.version.createdAt),
    currency: snapshot.purchaseOrder.currency,
    total: src.version.total,
    paymentTermsDays: snapshot.purchaseOrder.paymentTermsDays,
    lines: [...snapshot.lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        lineNo: l.lineNo,
        description: l.description,
        uom: l.uom,
        quantity: l.orderedQuantity,
        unitPrice: l.unitPrice,
        receivedQuantity: received.get(l.id) ?? '0.0000',
      })),
    file: file === null ? null : { ...file },
  });
}

// ---------------------------------------------------------------------------------------------- bills

/** The internal bill statuses (mirrors BILL_STATUSES of @bos/db and @bos/contracts payables). */
export type InternalBillStatus =
  | 'draft'
  | 'matching'
  | 'variance'
  | 'exception_pending'
  | 'pending_approval'
  | 'approved'
  | 'partially_paid'
  | 'paid'
  | 'voided'
  | 'discarded'
  | 'rejected';

const BILL_STATUS_FOR_VENDOR: Readonly<Record<InternalBillStatus, VendorPortalBillStatus | null>> =
  {
    draft: 'received',
    matching: 'under_review',
    variance: 'under_review',
    exception_pending: 'under_review',
    pending_approval: 'under_review',
    approved: 'approved_for_payment',
    partially_paid: 'approved_for_payment',
    paid: 'approved_for_payment',
    rejected: 'rejected',
    // A voided bill has no coarse status: it is not shown.
    voided: null,
    discarded: null,
  };

/** The coarse status a vendor sees, or null when the bill is not shown. */
export const vendorBillStatus = (s: InternalBillStatus): VendorPortalBillStatus | null =>
  BILL_STATUS_FOR_VENDOR[s];

export interface BillSource {
  id: string;
  kind: 'bill' | 'vendor_credit_note';
  number: string | null;
  vendorInvoiceNo: string;
  invoiceDate: string;
  currency: string;
  payableTotal: string;
  tdsTotal: string;
  status: InternalBillStatus;
}

/** A bill as the vendor sees it; undefined for a credit note, an unnumbered bill or a voided bill. */
export function toBillView(src: BillSource): VendorPortalBillView | undefined {
  const status = vendorBillStatus(src.status);
  if (src.kind !== 'bill' || src.number === null || src.number === '' || status === null) {
    return undefined;
  }
  return VendorPortalBillViewSchema.parse({
    id: src.id,
    number: src.number,
    vendorInvoiceNo: src.vendorInvoiceNo,
    invoiceDate: src.invoiceDate,
    currency: src.currency,
    payableTotal: src.payableTotal,
    tdsAmount: src.tdsTotal,
    status,
    // Payout is out of P4's scope (AD1): no payment is executed yet, so none is listed.
    payments: [],
  });
}

// ---------------------------------------------------------------------------------------------- onboarding

/** One KYB checklist item as stored in verification_cases.checklist (ChecklistItem of @bos/contracts crm). */
export interface ChecklistSource {
  key: string;
  status: 'missing' | 'provided' | 'accepted' | 'rejected';
  expiresOn: string | null;
}

/**
 * The onboarding view: the vendor's status, what it may do, and one row per vendor KYC document type. A type the
 * case does not hold (or no case yet) is `missing`; an accepted item past its expiry is `expired`.
 */
export function toOnboardingView(
  status: VendorStatus,
  checklist: readonly ChecklistSource[] | undefined,
  today: string,
  detailsChanged: { at: string; by: string | null } | null = null,
): VendorPortalOnboardingView {
  const byKey = new Map((checklist ?? []).map((i) => [i.key, i]));
  return VendorPortalOnboardingViewSchema.parse({
    status,
    capability: vendorPortalCapability(status),
    detailsChanged,
    documents: VENDOR_KYC_DOC_TYPES.map((docType: VendorKycDocType) => {
      const item = byKey.get(docType);
      return {
        docType,
        state: onboardingState(item, today),
        validUntil: item?.expiresOn ?? null,
      };
    }),
  });
}

function onboardingState(
  item: ChecklistSource | undefined,
  today: string,
): VendorPortalOnboardingView['documents'][number]['state'] {
  if (item === undefined) return 'missing';
  switch (item.status) {
    case 'missing':
      return 'missing';
    case 'provided':
      return 'submitted';
    case 'rejected':
      return 'rejected';
    case 'accepted':
      return item.expiresOn !== null && item.expiresOn < today ? 'expired' : 'accepted';
  }
}
