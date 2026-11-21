// The document owner policy of `evidence` (round 5 P2): a file uploaded in place as the evidence of one record.
// The owner id is that record's id, which is one of three kinds:
// - a sales order (Mark billable): upload with `sales_order.mark_billable` on the order, reached as the person who
//   confirmed it or as the owner of its quotation (the same two refs SalesOrdersService's canOnOrder checks);
//   attachable while the order is confirmed and still has a planned schedule line;
// - a vendor bill (match exception): `payables.bill.enter` on the bill (its enterer owns it, as lockEnterable
//   checks); attachable before the bill is submitted (draft, matching, variance, exception_pending);
// - an RFQ (recording a vendor quotation): `procurement.sourcing` on the RFQ (its creator owns it); attachable
//   while the RFQ is open.
// A ResourceRef carries no record kind, so a plain `uploadPermission` list would let any one grant reach every kind
// (a sales-order grant uploading to a bill). `uploadGrants` resolves the id first and names only that kind's
// permission. Staff only: no portal hook (`allowsCounterparty`) and no background job (`allowsSystemActor`), so
// both are refused. The type, size and scan rules are the generic ones: photos stay allowed, because a photographed
// delivery note is valid evidence. Every lookup is scoped to the caller's tenant and acting entity, so a record
// of another entity is null (404).
import { billingScheduleLines, quotations, rfqs, salesOrders, scoped, vendorBills } from '@bos/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { ResourceRef } from '../../platform/authz/can';
import type { Db, DbTransaction } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';
import { EVIDENCE_OWNER_TYPE } from '../../platform/documents/evidence-document';
import type { DocumentOwnerPolicy, UploadGrant } from '../../platform/documents/documents.ports';

const Id = z.guid();

export type EvidenceRecordKind = 'sales_order' | 'vendor_bill' | 'rfq';

/** The bill states before submit: the ones a match exception and its evidence belong to. */
export const BILL_EVIDENCE_STATES: readonly string[] = [
  'draft',
  'matching',
  'variance',
  'exception_pending',
];

/** The record an evidence owner id names, with what its permission and attach rule need. */
export type EvidenceRecord =
  | {
      kind: 'sales_order';
      status: string;
      createdBy: string | null;
      quotationOwnerUserId: string | null;
      hasPlannedLine: boolean;
    }
  | { kind: 'vendor_bill'; status: string; enteredBy: string | null }
  | { kind: 'rfq'; status: string; createdBy: string | null };

/** With `tx`, the record's head row is locked FOR SHARE, so an attach cannot interleave with its state change. */
export type EvidenceRecordLoader = (
  scope: TxScope,
  recordId: string,
  tx?: DbTransaction,
) => Promise<EvidenceRecord | undefined>;

const refOf = (scope: TxScope, ownerUserId: string | null): ResourceRef => ({
  tenantId: scope.tenantId,
  organizationId: scope.organizationId,
  ownerUserId,
});

/** The grants that authorise an evidence upload to this record: only its own kind's permission. */
export function evidenceUploadGrants(scope: TxScope, record: EvidenceRecord): UploadGrant[] {
  switch (record.kind) {
    case 'sales_order':
      return [
        { action: 'sales_order.mark_billable', ref: refOf(scope, record.createdBy) },
        { action: 'sales_order.mark_billable', ref: refOf(scope, record.quotationOwnerUserId) },
      ];
    case 'vendor_bill':
      return [{ action: 'payables.bill.enter', ref: refOf(scope, record.enteredBy) }];
    case 'rfq':
      return [{ action: 'procurement.sourcing', ref: refOf(scope, record.createdBy) }];
  }
}

/** Whether the record still takes evidence. */
export function evidenceAttachable(record: EvidenceRecord): boolean {
  switch (record.kind) {
    case 'sales_order':
      return record.status === 'confirmed' && record.hasPlannedLine;
    case 'vendor_bill':
      return BILL_EVIDENCE_STATES.includes(record.status);
    case 'rfq':
      return record.status === 'open';
  }
}

/** The ref reads (`documents.read`) are checked on: the record's primary owner. */
function primaryRef(scope: TxScope, record: EvidenceRecord): ResourceRef {
  switch (record.kind) {
    case 'sales_order':
      return refOf(scope, record.createdBy);
    case 'vendor_bill':
      return refOf(scope, record.enteredBy);
    case 'rfq':
      return refOf(scope, record.createdBy);
  }
}

export class EvidenceOwnerPolicy implements DocumentOwnerPolicy {
  readonly ownerType = EVIDENCE_OWNER_TYPE;

  constructor(private readonly load: EvidenceRecordLoader) {}

  /** The record this id names in the acting entity, else null (404). */
  async resource(scope: TxScope, ownerId: string): Promise<ResourceRef | null> {
    const record = await this.load(scope, ownerId);
    return record === undefined ? null : primaryRef(scope, record);
  }

  async uploadGrants(scope: TxScope, ownerId: string): Promise<readonly UploadGrant[] | null> {
    const record = await this.load(scope, ownerId);
    return record === undefined ? null : evidenceUploadGrants(scope, record);
  }

  async canAttach(scope: TxScope, ownerId: string, tx?: DbTransaction): Promise<boolean> {
    const record = await this.load(scope, ownerId, tx);
    return record !== undefined && evidenceAttachable(record);
  }

  /** No job adds evidence. */
  allowsSystemActor(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** Resolves an id to the sales order, vendor bill or RFQ of this tenant and acting entity that owns it. */
export function drizzleEvidenceRecordLoader(db: Db): EvidenceRecordLoader {
  return async (scope, recordId, tx) => {
    if (!Id.safeParse(recordId).success) return undefined;
    const reader = tx ?? db;
    const s = scoped(scope);

    const orderQuery = reader
      .select({
        status: salesOrders.status,
        createdBy: salesOrders.createdBy,
        quotationId: salesOrders.quotationId,
      })
      .from(salesOrders)
      .where(s.where(salesOrders, eq(salesOrders.id, recordId)))
      .limit(1);
    const [order] = tx === undefined ? await orderQuery : await orderQuery.for('share');
    if (order !== undefined) {
      const [quotation] = await reader
        .select({ ownerUserId: quotations.ownerUserId })
        .from(quotations)
        .where(s.where(quotations, eq(quotations.id, order.quotationId)))
        .limit(1);
      const [planned] = await reader
        .select({ id: billingScheduleLines.id })
        .from(billingScheduleLines)
        .where(
          s.where(
            billingScheduleLines,
            and(
              eq(billingScheduleLines.salesOrderId, recordId),
              eq(billingScheduleLines.status, 'planned'),
            ),
          ),
        )
        .limit(1);
      return {
        kind: 'sales_order',
        status: order.status,
        createdBy: order.createdBy,
        quotationOwnerUserId: quotation?.ownerUserId ?? null,
        hasPlannedLine: planned !== undefined,
      };
    }

    const billQuery = reader
      .select({ status: vendorBills.status, enteredBy: vendorBills.enteredBy })
      .from(vendorBills)
      .where(s.where(vendorBills, eq(vendorBills.id, recordId)))
      .limit(1);
    const [bill] = tx === undefined ? await billQuery : await billQuery.for('share');
    if (bill !== undefined) return { kind: 'vendor_bill', ...bill };

    const rfqQuery = reader
      .select({ status: rfqs.status, createdBy: rfqs.createdBy })
      .from(rfqs)
      .where(s.where(rfqs, eq(rfqs.id, recordId)))
      .limit(1);
    const [rfq] = tx === undefined ? await rfqQuery : await rfqQuery.for('share');
    if (rfq !== undefined) return { kind: 'rfq', ...rfq };
    return undefined;
  };
}
