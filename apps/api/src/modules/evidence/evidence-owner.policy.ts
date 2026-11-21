// The document owner policy of `evidence` (round 5 P2): a file uploaded in place as the evidence of one record.
// The owner id is that record's id, which is one of four kinds:
// - a sales order (Mark billable): upload with `sales_order.mark_billable` on the order, reached as the person who
//   confirmed it or as the owner of its quotation (the same two refs SalesOrdersService's canOnOrder checks);
//   attachable while the order is confirmed and still has a planned schedule line;
// - a quotation version (confirming its sales order, FU7): `sales_order.confirm`, reached through the quotation's
//   owner; attachable while the version is accepted and no confirmed order exists yet. The order does not exist when
//   the dialog opens, so the file belongs to the version and the confirm files it as the order's evidence;
// - a vendor bill (match exception): `payables.bill.enter` on the bill (its enterer owns it, as lockEnterable
//   checks); attachable before the bill is submitted (draft, matching, variance, exception_pending);
// - an RFQ (recording a vendor quotation): `procurement.sourcing` on the RFQ (its creator owns it); attachable
//   while the RFQ is open.
// A ResourceRef carries no record kind, so a plain `uploadPermission` list would let any one grant reach every kind
// (a sales-order grant uploading to a bill). `uploadGrants` resolves the id first and names only that kind's
// permission. Staff only: no portal hook (`allowsCounterparty`) and no background job (`allowsSystemActor`), so
// both are refused. A file a record already took (a billable line's evidence, a match exception's, a recorded
// quotation's) is frozen: no new bytes and no removal on the record's routes while the record stays open. The generic
// new-version and remove routes refuse every evidence file (`ownRoutesOnly`), and only a file's uploader sends its
// bytes or removes it.
// The type, size and scan rules are the generic ones: photos stay allowed, because a photographed
// delivery note is valid evidence. Every lookup is scoped to the caller's tenant and acting entity, so a record
// of another entity is null (404).
import {
  billingScheduleLines,
  matchExceptions,
  quotations,
  quotationVersions,
  rfqs,
  salesOrderEvidence,
  salesOrders,
  scoped,
  vendorBills,
  vendorQuotations,
} from '@bos/db';
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';

import type { ResourceRef } from '../../platform/authz/can';
import type { Db, DbTransaction } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';
import { EVIDENCE_OWNER_TYPE } from '../../platform/documents/evidence-document';
import type { DocumentOwnerPolicy, UploadGrant } from '../../platform/documents/documents.ports';

const Id = z.guid();

export type EvidenceRecordKind = 'sales_order' | 'quotation_version' | 'vendor_bill' | 'rfq';

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
  | {
      kind: 'quotation_version';
      /** The version's own status: only an accepted one is confirmed into an order. */
      status: string;
      quotationOwnerUserId: string | null;
      /** An order of the quotation that is no longer a draft (confirmed or beyond): confirming is over. */
      hasConfirmedOrder: boolean;
    }
  | { kind: 'vendor_bill'; status: string; enteredBy: string | null }
  | { kind: 'rfq'; status: string; createdBy: string | null };

/**
 * Whether the record already references this evidence file (a billable schedule line, a match exception, a recorded
 * vendor quotation, a confirmed order's evidence). With `tx`, the referencing rows are locked FOR SHARE.
 */
export type EvidenceReferenceLoader = (
  scope: TxScope,
  record: { kind: EvidenceRecordKind; id: string },
  documentId: string,
  tx?: DbTransaction,
) => Promise<boolean>;

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
    case 'quotation_version':
      return [{ action: 'sales_order.confirm', ref: refOf(scope, record.quotationOwnerUserId) }];
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
    case 'quotation_version':
      return record.status === 'accepted' && !record.hasConfirmedOrder;
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
    case 'quotation_version':
      return refOf(scope, record.quotationOwnerUserId);
    case 'vendor_bill':
      return refOf(scope, record.enteredBy);
    case 'rfq':
      return refOf(scope, record.createdBy);
  }
}

export class EvidenceOwnerPolicy implements DocumentOwnerPolicy {
  readonly ownerType = EVIDENCE_OWNER_TYPE;
  /** Changed only on the record's evidence routes, by the file's uploader (EvidenceDocumentsService). */
  readonly ownRoutesOnly = true;

  constructor(
    private readonly load: EvidenceRecordLoader,
    private readonly isReferenced: EvidenceReferenceLoader,
  ) {}

  /** The record this id names in the acting entity, else null (404). */
  async resource(scope: TxScope, ownerId: string): Promise<ResourceRef | null> {
    const record = await this.load(scope, ownerId);
    return record === undefined ? null : primaryRef(scope, record);
  }

  async uploadGrants(scope: TxScope, ownerId: string): Promise<readonly UploadGrant[] | null> {
    const record = await this.load(scope, ownerId);
    return record === undefined ? null : evidenceUploadGrants(scope, record);
  }

  /**
   * A new file while the record takes evidence; a new version, its bytes or a removal (`documentId`) only while the
   * record has not taken that file yet, so what a line, exception or quotation names cannot change under it.
   */
  async canAttach(
    scope: TxScope,
    ownerId: string,
    tx?: DbTransaction,
    documentId?: string,
  ): Promise<boolean> {
    const record = await this.load(scope, ownerId, tx);
    if (record === undefined || !evidenceAttachable(record)) return false;
    if (documentId === undefined) return true;
    return !(await this.isReferenced(scope, { kind: record.kind, id: ownerId }, documentId, tx));
  }

  /** No job adds evidence. */
  allowsSystemActor(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * The `evidence` policy as an approval context reads it (approvals/context.ts readableDocuments): only files uploaded
 * to `recordId` itself, so a row naming another record's evidence lists nothing. The read rule is the generic one.
 */
export function evidenceOwnerPolicyFor(
  db: Db,
  recordId: string,
): Pick<DocumentOwnerPolicy, 'ownerType' | 'resource'> {
  const policy = new EvidenceOwnerPolicy(
    drizzleEvidenceRecordLoader(db),
    drizzleEvidenceReferenceLoader(db),
  );
  return {
    ownerType: policy.ownerType,
    resource: (scope, ownerId) =>
      ownerId === recordId ? policy.resource(scope, ownerId) : Promise.resolve(null),
  };
}

/** Resolves an id to the sales order, quotation version, vendor bill or RFQ of this tenant and acting entity that owns it. */
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

    // Lock order of the confirm: the quotation, then its version.
    const versionPeek = await reader
      .select({ quotationId: quotationVersions.quotationId })
      .from(quotationVersions)
      .where(s.where(quotationVersions, eq(quotationVersions.id, recordId)))
      .limit(1);
    if (versionPeek[0] !== undefined) {
      const quotationQuery = reader
        .select({ ownerUserId: quotations.ownerUserId })
        .from(quotations)
        .where(s.where(quotations, eq(quotations.id, versionPeek[0].quotationId)))
        .limit(1);
      const [quotation] =
        tx === undefined ? await quotationQuery : await quotationQuery.for('share');
      const versionQuery = reader
        .select({ status: quotationVersions.status })
        .from(quotationVersions)
        .where(s.where(quotationVersions, eq(quotationVersions.id, recordId)))
        .limit(1);
      const [version] = tx === undefined ? await versionQuery : await versionQuery.for('share');
      if (quotation === undefined || version === undefined) return undefined;
      const [confirmed] = await reader
        .select({ id: salesOrders.id })
        .from(salesOrders)
        .where(
          s.where(
            salesOrders,
            and(
              eq(salesOrders.quotationId, versionPeek[0].quotationId),
              ne(salesOrders.status, 'draft'),
              ne(salesOrders.status, 'cancelled'),
            ),
          ),
        )
        .limit(1);
      return {
        kind: 'quotation_version',
        status: version.status,
        quotationOwnerUserId: quotation.ownerUserId,
        hasConfirmedOrder: confirmed !== undefined,
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

/** The record's own references to an evidence file, in this tenant and acting entity. */
export function drizzleEvidenceReferenceLoader(db: Db): EvidenceReferenceLoader {
  return async (scope, record, documentId, tx) => {
    if (!Id.safeParse(documentId).success) return false;
    const reader = tx ?? db;
    const s = scoped(scope);
    if (record.kind === 'sales_order') {
      const query = reader
        .select({ id: billingScheduleLines.id })
        .from(billingScheduleLines)
        .where(
          s.where(
            billingScheduleLines,
            and(
              eq(billingScheduleLines.salesOrderId, record.id),
              eq(billingScheduleLines.billableEvidenceDocumentId, documentId),
            ),
          ),
        )
        .limit(1);
      const rows = tx === undefined ? await query : await query.for('share');
      return rows.length > 0;
    }
    if (record.kind === 'quotation_version') {
      const query = reader
        .select({ id: salesOrderEvidence.id })
        .from(salesOrderEvidence)
        .innerJoin(
          salesOrders,
          and(
            eq(salesOrders.tenantId, salesOrderEvidence.tenantId),
            eq(salesOrders.organizationId, salesOrderEvidence.organizationId),
            eq(salesOrders.id, salesOrderEvidence.salesOrderId),
          ),
        )
        .where(
          s.where(
            salesOrderEvidence,
            and(
              eq(salesOrders.quotationVersionId, record.id),
              eq(salesOrderEvidence.documentId, documentId),
            ),
          ),
        )
        .limit(1);
      const rows = tx === undefined ? await query : await query.for('share');
      return rows.length > 0;
    }
    if (record.kind === 'vendor_bill') {
      const query = reader
        .select({ id: matchExceptions.id })
        .from(matchExceptions)
        .where(
          s.where(
            matchExceptions,
            and(
              eq(matchExceptions.vendorBillId, record.id),
              eq(matchExceptions.evidenceDocumentId, documentId),
            ),
          ),
        )
        .limit(1);
      const rows = tx === undefined ? await query : await query.for('share');
      return rows.length > 0;
    }
    const query = reader
      .select({ id: vendorQuotations.id })
      .from(vendorQuotations)
      .where(
        s.where(
          vendorQuotations,
          and(eq(vendorQuotations.rfqId, record.id), eq(vendorQuotations.documentId, documentId)),
        ),
      )
      .limit(1);
    const rows = tx === undefined ? await query : await query.for('share');
    return rows.length > 0;
  };
}
