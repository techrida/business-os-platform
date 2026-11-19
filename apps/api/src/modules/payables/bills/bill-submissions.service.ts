// BillSubmissionsService: the staff side of the vendor portal's bill inbox (P4 unit A1d; Journey 11): list the
// bills vendors uploaded and reject one. Converting one into a bill is VendorBillsService.convertSubmission, because
// the bill and the row's move to `converted` must be one transaction with the bill's own insert and match.
// Serves the NFRs:
// - "one legal entity at a time": every read and write is scoped to the acting entity; a submission of another
//   entity is a 404, never a 403;
// - "no double effects" and "no lost updates": reject runs in withIdempotency and locks the row FOR UPDATE, so a
//   second reject, or a reject racing a convert, finds the row no longer `received` and is a 409;
// - "a decision leaves a trail": the reason, the reviewer and the time are on the row, and an audit event is written.
import { documentVersions, scoped, vendorBillSubmissions, vendors } from '@bos/db';
import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { DB, type Db } from '../../../platform/db/db.module';
import { withIdempotency } from '../../../platform/db/idempotency';
import { withTx } from '../../../platform/db/tx';
import { searchPage } from '../../../platform/list';
import type { ListBillSubmissionsQuery, RejectBillSubmissionBody } from './bill-submissions.types';
import { VendorBillsCaller } from './vendor-bills.caller';

/** Injection token for a test clock; production falls back to the system time. */
export const BILL_SUBMISSIONS_CLOCK = Symbol('BILL_SUBMISSIONS_CLOCK');

/** An inbox row as staff see it. `fileStatus` is the scan status of the newest version of the file. */
export interface BillSubmissionDto {
  id: string;
  vendorPartyId: string | null;
  vendorName: string | null;
  purchaseOrderId: string | null;
  vendorInvoiceNo: string | null;
  invoiceDate: string | null;
  documentId: string;
  fileStatus: string | null;
  note: string | null;
  status: 'received';
  receivedAt: string;
}

export interface RejectedBillSubmissionDto {
  id: string;
  status: 'rejected';
  rejectionReason: string;
}

/** LIMIT for a list without a limit: larger than any inbox, so every row is returned. */
const NO_LIMIT = 2_147_483_647;

@Injectable()
export class BillSubmissionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly caller: VendorBillsCaller,
    @Optional()
    @Inject(BILL_SUBMISSIONS_CLOCK)
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * One page of the entity's `received` submissions, oldest first (the order to work them in), optionally searched
   * by the vendor's invoice number or the vendor name, with the total of all matches. Without a limit every row
   * comes back.
   */
  async list(
    query: ListBillSubmissionsQuery = { offset: 0 },
  ): Promise<{ rows: BillSubmissionDto[]; total: number }> {
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      // The vendor is optional on a submission, so the join stays a left join in the rows and the count.
      const vendorJoin = and(
        eq(vendors.tenantId, vendorBillSubmissions.tenantId),
        eq(vendors.id, vendorBillSubmissions.vendorPartyId),
      );
      const { rows, total } = await searchPage(tx, {
        q: query.q,
        columns: [vendorBillSubmissions.vendorInvoiceNo, vendors.legalName],
        where: scoped(scope).where(
          vendorBillSubmissions,
          eq(vendorBillSubmissions.status, 'received'),
        ),
        orderBy: [asc(vendorBillSubmissions.receivedAt), asc(vendorBillSubmissions.id)],
        limit: query.limit ?? NO_LIMIT,
        offset: query.offset,
        rows: (reader, p) =>
          reader
            .select({ sub: vendorBillSubmissions, vendorName: vendors.legalName })
            .from(vendorBillSubmissions)
            .leftJoin(vendors, vendorJoin)
            .where(p.where)
            .orderBy(...p.orderBy)
            .limit(p.limit)
            .offset(p.offset),
        count: async (reader, where) => {
          const [row] = await reader
            .select({ n: sql<number>`count(*)::int` })
            .from(vendorBillSubmissions)
            .leftJoin(vendors, vendorJoin)
            .where(where);
          return row?.n ?? 0;
        },
      });
      const documentIds = [...new Set(rows.map((r) => r.sub.documentId))];
      const fileStatus = new Map<string, string>();
      if (documentIds.length > 0) {
        const versions = await tx
          .select({ documentId: documentVersions.documentId, status: documentVersions.status })
          .from(documentVersions)
          .where(
            and(
              eq(documentVersions.tenantId, scope.tenantId),
              eq(documentVersions.organizationId, scope.organizationId),
              inArray(documentVersions.documentId, documentIds),
            ),
          )
          .orderBy(desc(documentVersions.version));
        // Newest first, so the first row seen for a file is its newest version.
        for (const v of versions)
          if (!fileStatus.has(v.documentId)) fileStatus.set(v.documentId, v.status);
      }
      const items = rows.map(({ sub, vendorName }) => ({
        id: sub.id,
        vendorPartyId: sub.vendorPartyId,
        vendorName: vendorName ?? null,
        purchaseOrderId: sub.purchaseOrderId,
        vendorInvoiceNo: sub.vendorInvoiceNo,
        invoiceDate: sub.invoiceDate,
        documentId: sub.documentId,
        fileStatus: fileStatus.get(sub.documentId) ?? null,
        note: sub.note,
        status: 'received' as const,
        receivedAt: sub.receivedAt.toISOString(),
      }));
      return { rows: items, total };
    });
  }

  /**
   * Marks a `received` submission rejected with the reason, the reviewer and the time. 404 outside the acting
   * entity; 409 SUBMISSION_NOT_RECEIVED when it is converted, rejected or withdrawn already.
   */
  async reject(
    id: string,
    body: RejectBillSubmissionBody,
    idempotencyKey: string,
  ): Promise<RejectedBillSubmissionDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'payables.bill_submission.reject', key: idempotencyKey, body: { id, body } },
        async () => {
          const [sub] = await tx
            .select({ id: vendorBillSubmissions.id, status: vendorBillSubmissions.status })
            .from(vendorBillSubmissions)
            .where(scoped(scope).where(vendorBillSubmissions, eq(vendorBillSubmissions.id, id)))
            .for('update');
          if (sub === undefined) {
            throw new NotFoundException({ code: 'not_found', message: 'Submission not found' });
          }
          if (sub.status !== 'received') {
            throw new ConflictException({
              code: 'SUBMISSION_NOT_RECEIVED',
              message: `The submission is ${sub.status}`,
            });
          }
          await tx
            .update(vendorBillSubmissions)
            .set({
              status: 'rejected',
              rejectionReason: body.reason,
              reviewedBy: principal.userId,
              reviewedAt: now,
              version: sql`${vendorBillSubmissions.version} + 1`,
              updatedAt: now,
            })
            .where(scoped(scope).where(vendorBillSubmissions, eq(vendorBillSubmissions.id, id)));
          await this.audit.record(tx, {
            action: 'payables.bill_submission.rejected',
            entityType: 'vendor_bill_submission',
            entityId: id,
            after: { reason: body.reason },
          });
          const response: RejectedBillSubmissionDto = {
            id,
            status: 'rejected',
            rejectionReason: body.reason,
          };
          return { status: 200, response };
        },
      );
      return done.response;
    });
  }
}
