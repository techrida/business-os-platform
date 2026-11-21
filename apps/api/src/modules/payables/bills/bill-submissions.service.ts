// BillSubmissionsService: the staff side of the vendor portal's bill inbox (P4 unit A1d; Journey 11): list the
// bills vendors uploaded and reject one. Converting one into a bill is VendorBillsService.convertSubmission, because
// the bill and the row's move to `converted` must be one transaction with the bill's own insert and match.
// Serves the NFRs:
// - "one legal entity at a time": every read and write is scoped to the acting entity; a submission of another
//   entity is a 404, never a 403;
// - "no double effects" and "no lost updates": reject runs in withIdempotency and locks the row FOR UPDATE, so a
//   second reject, or a reject racing a convert, finds the row no longer `received` and is a 409;
// - "a decision leaves a trail": the reason, the reviewer and the time are on the row, and an audit event is written.
import { documentVersions, scoped, vendorBillSubmissions, vendorBills, vendors } from '@bos/db';
import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { withIdempotency } from '../../../platform/db/idempotency';
import { READ_ONLY, withTx, type TxScope } from '../../../platform/db/tx';
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
  /**
   * What the vendor said the bill totals, and its currency, as they submitted it. The row has no column for them:
   * they are read from the submission's audit event. Null when that event does not carry them.
   */
  claimedTotal: string | null;
  currency: string | null;
  /**
   * Earlier bills and other submissions of the same vendor with the same invoice number (compared as the bill
   * dedup key does: case, spaces, `/` and `-` ignored), in any status except rejected. A warning for staff, not a
   * block: converting stays allowed and the bill's own dedup rule still applies. Empty when there are none.
   */
  duplicates: InvoiceDuplicateDto[];
}

/** One earlier bill or submission with the same vendor and invoice number. */
export interface InvoiceDuplicateDto {
  kind: 'bill' | 'submission';
  id: string;
  /** The bill's number (null until it is numbered); always null for a submission, which has none. */
  number: string | null;
  vendorInvoiceNo: string;
  status: string;
  /** A bill's total incl. VAT, or a submission's claimed total; null when unknown. */
  amount: string | null;
  currency: string | null;
  /** When the bill was entered or the submission received. */
  at: string;
}

/** The bill dedup key's normalisation (vendor_bills.invoice_no_norm), applied to any invoice number column. */
const invoiceNorm = (column: unknown) =>
  sql<string>`upper(regexp_replace(${column}, '[[:space:]/-]', '', 'g'))`;
const normOf = (invoiceNo: string) => invoiceNo.replace(/[\s/-]/g, '').toUpperCase();

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
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
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
        const duplicates = await this.duplicatesOf(
          tx,
          scope,
          rows.map((r) => r.sub),
        );
        const claims = await this.claimsOf(scope, [
          ...rows.map((r) => r.sub.id),
          ...[...duplicates.values()]
            .flat()
            .flatMap((d) => (d.kind === 'submission' ? [d.id] : [])),
        ]);
        const withClaim = (d: InvoiceDuplicateDto): InvoiceDuplicateDto =>
          d.kind === 'submission'
            ? {
                ...d,
                amount: claims.get(d.id)?.claimedTotal ?? null,
                currency: claims.get(d.id)?.currency ?? null,
              }
            : d;
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
          claimedTotal: claims.get(sub.id)?.claimedTotal ?? null,
          currency: claims.get(sub.id)?.currency ?? null,
          duplicates: (duplicates.get(sub.id) ?? []).map(withClaim),
        }));
        return { rows: items, total };
      },
      READ_ONLY,
    );
  }

  /**
   * For each submission, the earlier bills and other live submissions of its vendor with the same normalised
   * invoice number, in the acting entity. Rejected ones are left out; a converted submission is represented by
   * its bill. Read-only.
   */
  private async duplicatesOf(
    tx: DbTransaction,
    scope: TxScope,
    subs: readonly (typeof vendorBillSubmissions.$inferSelect)[],
  ): Promise<Map<string, InvoiceDuplicateDto[]>> {
    const out = new Map<string, InvoiceDuplicateDto[]>();
    const keyed = subs.flatMap((s) =>
      s.vendorPartyId !== null && s.vendorInvoiceNo !== null
        ? [{ id: s.id, vendorId: s.vendorPartyId, norm: normOf(s.vendorInvoiceNo) }]
        : [],
    );
    if (keyed.length === 0) return out;
    const vendorIds = [...new Set(keyed.map((k) => k.vendorId))];
    const norms = [...new Set(keyed.map((k) => k.norm))];
    const [bills, others] = await Promise.all([
      tx
        .select({
          id: vendorBills.id,
          vendorId: vendorBills.vendorId,
          number: vendorBills.number,
          vendorInvoiceNo: vendorBills.vendorInvoiceNo,
          norm: invoiceNorm(vendorBills.vendorInvoiceNo),
          status: vendorBills.status,
          amount: sql<string>`(${vendorBills.netTotal} + ${vendorBills.vatTotal})::text`,
          currency: vendorBills.currency,
          at: vendorBills.createdAt,
        })
        .from(vendorBills)
        .where(
          scoped(scope).where(
            vendorBills,
            and(
              inArray(vendorBills.vendorId, vendorIds),
              inArray(invoiceNorm(vendorBills.vendorInvoiceNo), norms),
              ne(vendorBills.status, 'rejected'),
            ),
          ),
        )
        .orderBy(asc(vendorBills.createdAt)),
      tx
        .select({
          id: vendorBillSubmissions.id,
          vendorId: vendorBillSubmissions.vendorPartyId,
          vendorInvoiceNo: vendorBillSubmissions.vendorInvoiceNo,
          norm: invoiceNorm(vendorBillSubmissions.vendorInvoiceNo),
          status: vendorBillSubmissions.status,
          at: vendorBillSubmissions.receivedAt,
        })
        .from(vendorBillSubmissions)
        .where(
          scoped(scope).where(
            vendorBillSubmissions,
            and(
              inArray(vendorBillSubmissions.vendorPartyId, vendorIds),
              inArray(invoiceNorm(vendorBillSubmissions.vendorInvoiceNo), norms),
              ne(vendorBillSubmissions.status, 'rejected'),
              sql`${vendorBillSubmissions.convertedBillId} IS NULL`,
            ),
          ),
        )
        .orderBy(asc(vendorBillSubmissions.receivedAt)),
    ]);
    for (const k of keyed) {
      const found: InvoiceDuplicateDto[] = [
        ...bills
          .filter((b) => b.vendorId === k.vendorId && b.norm === k.norm)
          .map((b) => ({
            kind: 'bill' as const,
            id: b.id,
            number: b.number,
            vendorInvoiceNo: b.vendorInvoiceNo,
            status: b.status,
            amount: b.amount,
            currency: b.currency,
            at: b.at.toISOString(),
          })),
        ...others
          .filter((o) => o.id !== k.id && o.vendorId === k.vendorId && o.norm === k.norm)
          .map((o) => ({
            kind: 'submission' as const,
            id: o.id,
            number: null,
            vendorInvoiceNo: o.vendorInvoiceNo ?? '',
            status: o.status,
            amount: null,
            currency: null,
            at: o.at.toISOString(),
          })),
      ];
      if (found.length > 0) out.set(k.id, found);
    }
    return out;
  }

  /** The claimed total and currency of each submission, from its `portal.vendor.bill_submitted` audit event. */
  private async claimsOf(
    scope: TxScope,
    ids: readonly string[],
  ): Promise<Map<string, { claimedTotal: string | null; currency: string | null }>> {
    const out = new Map<string, { claimedTotal: string | null; currency: string | null }>();
    for (const id of new Set(ids)) {
      const events = await this.audit.list(scope, {
        entityType: 'vendor_bill_submission',
        entityId: id,
        limit: 20,
      });
      const after = events.find((e) => e.action === 'portal.vendor.bill_submitted')?.after as
        { claimedTotal?: unknown; currency?: unknown } | null | undefined;
      out.set(id, {
        claimedTotal: typeof after?.claimedTotal === 'string' ? after.claimedTotal : null,
        currency: typeof after?.currency === 'string' ? after.currency : null,
      });
    }
    return out;
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
