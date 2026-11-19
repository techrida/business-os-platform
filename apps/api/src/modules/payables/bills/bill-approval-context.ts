// The approval context of a vendor bill (U18 #2), shared by the vendor_bill, match_exception and payment_request
// subjects: the bill's main facts with its vendor and order named, and the bill's own file. Read under the approval
// request's read, so Management and Finance judge the bill without `payables.bill.read` or `vendor.read`. Only the
// bill's own document is listed (bill files are owned by the vendor, so listing the owner's files would show every
// other bill of that vendor), and only when the reader could open it through the documents routes.
import type { ApprovalContext, ApprovalContextField } from '@bos/contracts';
import { purchaseOrders, scoped, vendorBills, vendors } from '@bos/db';
import { and, eq, inArray } from 'drizzle-orm';

import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import type { DocumentOwnerPolicy } from '../../../platform/documents/documents.ports';
import { fact, hrefFor, readableDocuments } from '../../approvals/context';
import { vendorIntakeOwnerPolicy } from '../../portal-vendor/inbox/vendor-intake.policy';
import { billDocumentOwnerPolicy } from './bill-documents.service';

/** The policies of the owner types a bill's file can have: keyed in by staff, or sent by the vendor from the portal. */
export function billFileOwners(q: Db): DocumentOwnerPolicy[] {
  return [billDocumentOwnerPolicy(q), vendorIntakeOwnerPolicy(q)];
}

export interface BillHead {
  id: string;
  number: string | null;
  vendorInvoiceNo: string;
  vendorName: string | null;
  purchaseOrderNumber: string | null;
  invoiceDate: string;
  dueDate: string | null;
  currency: string;
  netTotal: string;
  vatTotal: string;
  status: string;
  documentId: string;
}

/** The bills by id in the acting entity, with the vendor's legal name and the order's number. */
export async function billHeads(
  q: Db,
  scope: TxScope,
  ids: readonly string[],
): Promise<BillHead[]> {
  if (ids.length === 0) return [];
  return q
    .select({
      id: vendorBills.id,
      number: vendorBills.number,
      vendorInvoiceNo: vendorBills.vendorInvoiceNo,
      vendorName: vendors.legalName,
      purchaseOrderNumber: purchaseOrders.number,
      invoiceDate: vendorBills.invoiceDate,
      dueDate: vendorBills.dueDate,
      currency: vendorBills.currency,
      netTotal: vendorBills.netTotal,
      vatTotal: vendorBills.vatTotal,
      status: vendorBills.status,
      documentId: vendorBills.documentId,
    })
    .from(vendorBills)
    .leftJoin(
      vendors,
      and(eq(vendors.tenantId, vendorBills.tenantId), eq(vendors.id, vendorBills.vendorId)),
    )
    .leftJoin(
      purchaseOrders,
      and(
        eq(purchaseOrders.tenantId, vendorBills.tenantId),
        eq(purchaseOrders.organizationId, vendorBills.organizationId),
        eq(purchaseOrders.id, vendorBills.purchaseOrderId),
      ),
    )
    .where(scoped(scope).where(vendorBills, inArray(vendorBills.id, [...ids])));
}

/** A bill's label: its number, or the vendor's invoice number before it has one. */
export const billLabel = (bill: Pick<BillHead, 'number' | 'vendorInvoiceNo'>): string =>
  bill.number ?? bill.vendorInvoiceNo;

export function billFields(bill: BillHead): ApprovalContextField[] {
  return [
    ...fact.text('bill', 'Bill', bill.number),
    ...fact.text('vendorInvoiceNo', 'Vendor invoice number', bill.vendorInvoiceNo),
    ...fact.text('vendor', 'Vendor', bill.vendorName),
    ...fact.text('purchaseOrder', 'Purchase order', bill.purchaseOrderNumber),
    ...fact.date('invoiceDate', 'Invoice date', bill.invoiceDate),
    ...fact.date('dueDate', 'Due date', bill.dueDate),
    ...fact.money('netTotal', 'Net amount', bill.netTotal, bill.currency),
    ...fact.money('vatTotal', 'VAT', bill.vatTotal, bill.currency),
    ...fact.status(bill.status),
  ];
}

/** The context of one bill, or null when it is not in the acting entity. */
export async function billContext(
  q: Db,
  scope: TxScope,
  billId: string,
  viewer: Principal,
): Promise<ApprovalContext | null> {
  const [bill] = await billHeads(q, scope, [billId]);
  if (bill === undefined) return null;
  return {
    title: `Bill ${billLabel(bill)}`,
    fields: billFields(bill),
    documents: await readableDocuments(q, scope, viewer, [bill.documentId], billFileOwners(q)),
    // The bill routes check the grant alone (every bill of the entity), so the link does too.
    href: hrefFor(viewer, `/payables/bills/${bill.id}`, 'payables.bill.read'),
  };
}
