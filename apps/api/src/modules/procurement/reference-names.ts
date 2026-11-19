// Names for the procurement and payables records an approval snapshot refers to by id (P4). The approval
// engine asks a subject for them when a reader who may already open the request reads it (ApprovalSubject
// .referenceNames), so an approver sees "Dev Vendor Co" and "PO-2083/84-00007" where the frozen snapshot holds
// ids, with no vendor or order directory read of their own. Reads only the ids the snapshot names, in the
// request's tenant (vendors are tenant level) and entity (orders and bills); the snapshot is never changed.
import type { ReferenceName } from '@bos/contracts';
import {
  costCenters,
  departments,
  purchaseOrderLines,
  purchaseOrders,
  scoped,
  vendorBills,
  vendors,
} from '@bos/db';
import { and, eq, inArray } from 'drizzle-orm';

import type { Db } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The value at `path` in `snapshot` when it is a uuid, else undefined. */
export function idAt(snapshot: unknown, ...path: string[]): string | undefined {
  let at: unknown = snapshot;
  for (const key of path) {
    if (at === null || typeof at !== 'object' || Array.isArray(at)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return typeof at === 'string' && UUID.test(at) ? at.toLowerCase() : undefined;
}

const ids = (values: readonly (string | undefined)[]): string[] => [
  ...new Set(values.filter((v): v is string => v !== undefined)),
];

/**
 * Vendors by legal name, orders by number, bills by number (or the vendor's invoice number before one), departments
 * and cost centres by name, order lines as "Line N: description".
 */
export async function procurementReferenceNames(
  q: Db,
  scope: TxScope,
  refs: {
    vendorIds?: readonly (string | undefined)[];
    purchaseOrderIds?: readonly (string | undefined)[];
    vendorBillIds?: readonly (string | undefined)[];
    departmentIds?: readonly (string | undefined)[];
    costCenterIds?: readonly (string | undefined)[];
    purchaseOrderLineIds?: readonly (string | undefined)[];
  },
): Promise<ReferenceName[]> {
  const vendorIds = ids(refs.vendorIds ?? []);
  const poIds = ids(refs.purchaseOrderIds ?? []);
  const billIds = ids(refs.vendorBillIds ?? []);
  const deptIds = ids(refs.departmentIds ?? []);
  const ccIds = ids(refs.costCenterIds ?? []);
  const lineIds = ids(refs.purchaseOrderLineIds ?? []);
  const [vs, pos, bills, depts, ccs, lines] = await Promise.all([
    vendorIds.length === 0
      ? []
      : q
          .select({ id: vendors.id, name: vendors.legalName })
          .from(vendors)
          .where(and(eq(vendors.tenantId, scope.tenantId), inArray(vendors.id, vendorIds))),
    poIds.length === 0
      ? []
      : q
          .select({ id: purchaseOrders.id, name: purchaseOrders.number })
          .from(purchaseOrders)
          .where(scoped(scope).where(purchaseOrders, inArray(purchaseOrders.id, poIds))),
    billIds.length === 0
      ? []
      : q
          .select({
            id: vendorBills.id,
            number: vendorBills.number,
            invoiceNo: vendorBills.vendorInvoiceNo,
          })
          .from(vendorBills)
          .where(scoped(scope).where(vendorBills, inArray(vendorBills.id, billIds)))
          .then((rows) => rows.map((r) => ({ id: r.id, name: r.number ?? r.invoiceNo }))),
    deptIds.length === 0
      ? []
      : q
          .select({ id: departments.id, name: departments.name })
          .from(departments)
          .where(scoped(scope).where(departments, inArray(departments.id, deptIds))),
    ccIds.length === 0
      ? []
      : q
          .select({ id: costCenters.id, name: costCenters.name })
          .from(costCenters)
          .where(scoped(scope).where(costCenters, inArray(costCenters.id, ccIds))),
    lineIds.length === 0
      ? []
      : q
          .select({
            id: purchaseOrderLines.id,
            lineNo: purchaseOrderLines.lineNo,
            description: purchaseOrderLines.description,
          })
          .from(purchaseOrderLines)
          .where(scoped(scope).where(purchaseOrderLines, inArray(purchaseOrderLines.id, lineIds)))
          .then((rows) =>
            rows.map((r) => ({ id: r.id, name: `Line ${r.lineNo}: ${r.description}` })),
          ),
  ]);
  return [...vs, ...pos, ...bills, ...depts, ...ccs, ...lines].filter((r) => r.name.trim() !== '');
}
