// Names for the procurement and payables records an approval snapshot refers to by id (P4). The approval
// engine asks a subject for them when a reader who may already open the request reads it (ApprovalSubject
// .referenceNames), so an approver sees "Dev Vendor Co" and "PO-2083/84-00007" where the frozen snapshot holds
// ids, with no vendor, order or department directory read of their own. Reads only the ids the snapshot names, in
// the request's tenant (vendors are tenant level) and entity (departments, orders and bills); the snapshot is never
// changed.
import type { ReferenceName } from '@bos/contracts';
import { departments, purchaseOrders, scoped, vendorBills, vendors } from '@bos/db';
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
 * Vendors by legal name, departments by name, orders by number, bills by number (or the vendor's invoice number
 * before one).
 */
export async function procurementReferenceNames(
  q: Db,
  scope: TxScope,
  refs: {
    vendorIds?: readonly (string | undefined)[];
    departmentIds?: readonly (string | undefined)[];
    purchaseOrderIds?: readonly (string | undefined)[];
    vendorBillIds?: readonly (string | undefined)[];
  },
): Promise<ReferenceName[]> {
  const vendorIds = ids(refs.vendorIds ?? []);
  const departmentIds = ids(refs.departmentIds ?? []);
  const poIds = ids(refs.purchaseOrderIds ?? []);
  const billIds = ids(refs.vendorBillIds ?? []);
  const [vs, depts, pos, bills] = await Promise.all([
    vendorIds.length === 0
      ? []
      : q
          .select({ id: vendors.id, name: vendors.legalName })
          .from(vendors)
          .where(and(eq(vendors.tenantId, scope.tenantId), inArray(vendors.id, vendorIds))),
    departmentIds.length === 0
      ? []
      : q
          .select({ id: departments.id, name: departments.name })
          .from(departments)
          .where(scoped(scope).where(departments, inArray(departments.id, departmentIds))),
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
  ]);
  return [...vs, ...depts, ...pos, ...bills].filter((r) => r.name.trim() !== '');
}
