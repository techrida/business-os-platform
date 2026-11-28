// SourcingService: RFQ, vendor quotations, comparison, recommendation and the commitment approval (P4 unit P2;
// AD3, AD4, AD8, AD10, AD12, AD13). Serves the NFRs:
// - "money moves only after the right people agree": the commitment route runs on the recommended quote's grand
//   total incl. VAT in NPR; the requester, the recommender and whoever submits never approve it; a route that cannot
//   be completed by distinct people (AD8 with one Management user) is a 422 NO_ELIGIBLE_APPROVER with no request row;
// - "only vetted vendors": an RFQ invites only `approved` vendors that trade with the acting entity (409 otherwise);
// - "no double effects" and "no lost updates": every write runs in withIdempotency and locks its row FOR UPDATE;
// - "one legal entity at a time": every read and write is scoped(); another entity's RFQ is a 404.
import {
  WorkflowSpecSchema,
  type ListRfqsQuery,
  type RecommendQuotationBody,
  type RfqListItem,
  type RfqSubmissionItem,
} from '@bos/contracts';
import {
  documentVersions,
  documents,
  purchaseRequestLines,
  purchaseRequests,
  rfqs,
  rfqVendors,
  scoped,
  taxCodes,
  vendorAccounts,
  vendorComparisonScores,
  vendorQuotationLines,
  vendorQuotationSubmissions,
  vendorQuotations,
  vendors,
} from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type TxScope } from '../../../platform/db/tx';
import { assertNotInfected } from '../../../platform/documents/documents.service';
import { assertEvidenceDocument } from '../../../platform/documents/evidence-document';
import { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import { searchPage } from '../../../platform/list';
import { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { ApprovalsService } from '../../approvals/requests.service';
import { PurchaseRequestsCaller } from '../requests/purchase-requests.caller';
import {
  DEFAULT_MIN_QUOTES,
  PR_COMMITMENT_DOCUMENT_TYPE,
  RFQ_AUDIT_ENTITY,
  RFQ_DEADLINE_PASSED,
  RFQ_DEADLINE_PASSED_MESSAGE,
  RFQ_SERIES,
  commitmentFactsOf,
  extendDeadlineVerdict,
  isLateQuotation,
  poBandOf,
  quotationLineAmounts,
  quoteCountVerdict,
  sumMoney,
  type ConvertSubmissionBody,
  type CreateRfqBody,
  type ExtendRfqDeadlineBody,
  type RecordQuotationBody,
  type ScoreQuotationBody,
} from './sourcing.rules';

/** Injection token for a test clock; production falls back to the system time. */
export const SOURCING_CLOCK = Symbol('SOURCING_CLOCK');

const RECOMMENDED_ACTION = 'procurement.rfq.recommended';

const notFound = (what = 'RFQ') =>
  new NotFoundException({ code: 'not_found', message: `${what} not found` });
const conflict = (message: string, code = 'conflict') => new ConflictException({ code, message });
const badRequest = (message: string) => new BadRequestException({ code: 'bad_request', message });

/** Thrown inside the commitment transaction so it rolls back (idempotency claim included). */
class NoEligibleApprover extends Error {
  constructor(readonly reason: string) {
    super('no eligible approver');
  }
}

type RfqRow = typeof rfqs.$inferSelect;
type QuotationRow = typeof vendorQuotations.$inferSelect;

export interface RfqDto {
  id: string;
  number: string;
  purchaseRequestId: string;
  deadline: string;
  status: RfqRow['status'];
  vendorIds: string[];
  /**
   * The invited vendors with their legal names, read with the RFQ under its own grant (procurement.sourcing), so
   * sourcing needs no vendor directory read to label them. Same vendors as `vendorIds`.
   */
  vendors: InvitedVendor[];
  recommendedQuotationId: string | null;
  fewerThanThreeReason: string | null;
  recommendationRationale: string | null;
  commitmentApprovalRequestId: string | null;
  version: number;
}

/** An invited vendor as the RFQ screens show it: its id and legal name, nothing else. */
export interface InvitedVendor {
  id: string;
  name: string;
}

export interface QuotationDto {
  id: string;
  rfqId: string;
  vendorId: string;
  currency: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  fxRate: string;
  totalNpr: string;
  deliveryDays: number | null;
  documentId: string;
}

/** One line of a quotation as the vendor quoted it; `lineNo` is its request line's number. */
export interface QuotationLineDto {
  id: string;
  prLineId: string;
  lineNo: number;
  description: string;
  quantity: string;
  unitPrice: string;
  taxCode: string;
  taxRateBp: number;
  gross: string;
  taxAmount: string;
  lineTotal: string;
}

export interface ComparisonRow extends QuotationDto {
  /** What the vendor quoted, in request-line order. gross, tax and total add up to the quotation's. */
  lines: QuotationLineDto[];
  /** The quoting vendor's legal name, read with the quotation (same tenant). */
  vendorName: string;
  /** The mean of the quotation's scores (two places), or null when nobody scored it yet. */
  averageScore: string | null;
  scores: { criterion: string; score: string; comment: string | null }[];
}

const toQuotationDto = (q: QuotationRow): QuotationDto => ({
  id: q.id,
  rfqId: q.rfqId,
  vendorId: q.vendorId,
  currency: q.currency,
  subtotal: q.subtotal,
  taxAmount: q.taxAmount,
  total: q.total,
  fxRate: q.fxRate,
  totalNpr: q.totalNpr,
  deliveryDays: q.deliveryDays,
  documentId: q.documentId,
});

@Injectable()
export class SourcingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly money: MoneyService,
    private readonly settings: SettingsService,
    private readonly caller: PurchaseRequestsCaller,
    @Optional()
    @Inject(SOURCING_CLOCK)
    private readonly clock: () => Date = () => new Date(),
    // Last and defaulted like the clock, so a hand-built service still checks currencies (D44); Nest injects it.
    private readonly currencies: CurrencyEnabledService = new CurrencyEnabledService(settings),
  ) {}

  // ------------------------------------------------------------------------------------------------- RFQ

  /**
   * Opens the RFQ of a `dept_approved` request and invites the vendors. 404 for another entity's request, 409 when
   * the request is not dept_approved, a vendor is not `approved` (VENDOR_NOT_APPROVED) or has no account in the
   * entity (VENDOR_NOT_IN_ENTITY). The request moves to `sourcing`.
   */
  async createRfq(body: CreateRfqBody, idempotencyKey: string): Promise<RfqDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'procurement.rfq.create', key: idempotencyKey, body },
        async () => {
          const [pr] = await tx
            .select()
            .from(purchaseRequests)
            .where(
              scoped(scope).where(
                purchaseRequests,
                eq(purchaseRequests.id, body.purchaseRequestId),
              ),
            )
            .for('update');
          if (pr === undefined) throw notFound('Purchase request');
          if (pr.status !== 'dept_approved') {
            throw conflict(
              `An RFQ needs a dept_approved purchase request; this one is ${pr.status}`,
            );
          }
          // A deadline that has passed would open an RFQ no invited vendor can ever quote on.
          if (new Date(body.deadline).getTime() <= now.getTime()) {
            throw new BadRequestException({
              code: 'bad_request',
              reason: 'deadline_in_past',
              message: 'The quotation deadline has passed. Choose a date and time in the future.',
            });
          }
          await this.assertInvitable(tx, scope, body.vendorIds);

          const { number } = await this.numbering.issue(tx, RFQ_SERIES, now);
          const [rfq] = await tx
            .insert(rfqs)
            .values({
              ...scope,
              purchaseRequestId: pr.id,
              number,
              deadline: new Date(body.deadline),
              createdBy: principal.userId,
            })
            .returning();
          await tx.insert(rfqVendors).values(
            body.vendorIds.map((vendorId) => ({
              ...scope,
              rfqId: rfq!.id,
              vendorId,
              invitedBy: principal.userId,
            })),
          );
          await this.setPrStatus(tx, scope, pr.id, 'dept_approved', 'sourcing', now);
          await this.audit.record(tx, {
            action: 'procurement.rfq.created',
            entityType: RFQ_AUDIT_ENTITY,
            entityId: rfq!.id,
            after: { number, purchaseRequestId: pr.id, vendorIds: body.vendorIds },
          });
          return {
            status: 201,
            response: this.toRfqDto(rfq!, await this.invitedOf(tx, scope, rfq!.id)),
          };
        },
      );
      return done.response;
    });
  }

  /**
   * One page of the acting entity's RFQs, newest first, optionally of some statuses and a search, with the total of
   * all matches. The two counts come from one grouped query each (not one per row); a quotation is a row of
   * vendor_quotations, an invitation a row of rfq_vendors.
   */
  async listRfqs(query: ListRfqsQuery): Promise<{ rows: RfqListItem[]; total: number }> {
    const { scope } = this.caller.current();
    const join = and(
      eq(purchaseRequests.tenantId, rfqs.tenantId),
      eq(purchaseRequests.organizationId, rfqs.organizationId),
      eq(purchaseRequests.id, rfqs.purchaseRequestId),
    );
    const page = await searchPage(this.db, {
      q: query.q,
      columns: [rfqs.number, purchaseRequests.number],
      where: scoped(scope).where(
        rfqs,
        query.status === undefined || query.status.length === 0
          ? undefined
          : inArray(rfqs.status, query.status),
      ),
      orderBy: [desc(rfqs.createdAt), desc(rfqs.id)],
      limit: query.limit,
      offset: query.offset,
      rows: (tx, p) =>
        tx
          .select({ rfq: rfqs, purchaseRequestNumber: purchaseRequests.number })
          .from(rfqs)
          .innerJoin(purchaseRequests, join)
          .where(p.where)
          .orderBy(...p.orderBy)
          .limit(p.limit)
          .offset(p.offset),
      count: async (tx, where) => {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(rfqs)
          .innerJoin(purchaseRequests, join)
          .where(where);
        return row?.n ?? 0;
      },
    });
    const rows = page.rows;
    const total = page.total;
    if (rows.length === 0) return { rows: [], total };
    const ids = rows.map((r) => r.rfq.id);
    const invited = await this.db
      .select({ rfqId: rfqVendors.rfqId, n: sql<number>`count(*)::int` })
      .from(rfqVendors)
      .where(scoped(scope).where(rfqVendors, inArray(rfqVendors.rfqId, ids)))
      .groupBy(rfqVendors.rfqId);
    const quoted = await this.db
      .select({ rfqId: vendorQuotations.rfqId, n: sql<number>`count(*)::int` })
      .from(vendorQuotations)
      .where(scoped(scope).where(vendorQuotations, inArray(vendorQuotations.rfqId, ids)))
      .groupBy(vendorQuotations.rfqId);
    const invitedBy = new Map(invited.map((r) => [r.rfqId, r.n]));
    const quotedBy = new Map(quoted.map((r) => [r.rfqId, r.n]));
    return {
      rows: rows.map((r) => ({
        id: r.rfq.id,
        number: r.rfq.number,
        purchaseRequestId: r.rfq.purchaseRequestId,
        purchaseRequestNumber: r.purchaseRequestNumber,
        status: r.rfq.status,
        deadline: r.rfq.deadline.toISOString(),
        invitedVendorCount: invitedBy.get(r.rfq.id) ?? 0,
        quotationCount: quotedBy.get(r.rfq.id) ?? 0,
      })),
      total,
    };
  }

  /**
   * The RFQ's `received` inbox submissions (uploads that name this RFQ), oldest first, each with the scan status of
   * its document's latest version. 404 outside the acting entity, before anything else is read.
   */
  async listSubmissions(rfqId: string): Promise<RfqSubmissionItem[]> {
    const { scope } = this.caller.current();
    await this.findRfq(this.db, scope, rfqId);
    const rows = await this.db
      .select({ sub: vendorQuotationSubmissions, vendorName: vendors.legalName })
      .from(vendorQuotationSubmissions)
      .innerJoin(
        vendors,
        and(
          eq(vendors.tenantId, vendorQuotationSubmissions.tenantId),
          eq(vendors.id, vendorQuotationSubmissions.vendorId),
        ),
      )
      .where(
        scoped(scope).where(
          vendorQuotationSubmissions,
          and(
            eq(vendorQuotationSubmissions.rfqId, rfqId),
            eq(vendorQuotationSubmissions.status, 'received'),
          ),
        ),
      )
      .orderBy(asc(vendorQuotationSubmissions.receivedAt), asc(vendorQuotationSubmissions.id));
    if (rows.length === 0) return [];
    const versions = await this.db
      .select({
        documentId: documentVersions.documentId,
        status: documentVersions.status,
      })
      .from(documentVersions)
      .where(
        scoped(scope).where(
          documentVersions,
          inArray(
            documentVersions.documentId,
            rows.map((r) => r.sub.documentId),
          ),
        ),
      )
      .orderBy(desc(documentVersions.version));
    // Newest version first, so the first row seen per document is its latest.
    const latest = new Map<string, RfqSubmissionItem['scanStatus']>();
    for (const v of versions) if (!latest.has(v.documentId)) latest.set(v.documentId, v.status);
    return rows.map((r) => ({
      id: r.sub.id,
      vendorId: r.sub.vendorId,
      vendorName: r.vendorName,
      vendorRef: r.sub.vendorRef,
      submittedAt: r.sub.receivedAt.toISOString(),
      documentId: r.sub.documentId,
      scanStatus: latest.get(r.sub.documentId) ?? null,
    }));
  }

  /** One RFQ with its invited vendors; 404 outside the acting entity. */
  async getRfq(id: string): Promise<RfqDto> {
    const { scope } = this.caller.current();
    const rfq = await this.findRfq(this.db, scope, id);
    return this.toRfqDto(rfq, await this.invitedOf(this.db, scope, id));
  }

  /**
   * F1-Q47: moves the quotation deadline of an open RFQ later. 409 unless the RFQ is open; 400 `deadline_in_past`
   * for an instant not after now, 400 for one not after the current deadline. Audited with both deadlines. An RFQ
   * whose deadline passed takes quotations again once extended.
   */
  async extendDeadline(
    rfqId: string,
    body: ExtendRfqDeadlineBody,
    idempotencyKey: string,
  ): Promise<RfqDto> {
    const { scope, actor } = this.caller.current();
    const now = this.clock();
    const next = new Date(body.deadline);
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'procurement.rfq.extend_deadline', key: idempotencyKey, body: { rfqId, body } },
        async () => {
          const rfq = await this.findRfq(tx, scope, rfqId, true);
          const verdict = extendDeadlineVerdict({
            status: rfq.status,
            current: rfq.deadline,
            next,
            now,
          });
          if (!verdict.ok) {
            if (verdict.refusal === 'not_open') {
              throw conflict(
                `Only an open RFQ's deadline can be extended; this one is ${rfq.status}`,
              );
            }
            if (verdict.refusal === 'deadline_in_past') {
              throw new BadRequestException({
                code: 'bad_request',
                reason: 'deadline_in_past',
                message: 'The new deadline has passed. Choose a date and time in the future.',
              });
            }
            throw badRequest('The new deadline must be later than the current one.');
          }
          const [row] = await tx
            .update(rfqs)
            .set({ deadline: next, version: sql`${rfqs.version} + 1`, updatedAt: now })
            .where(eq(rfqs.id, rfqId))
            .returning();
          await this.audit.record(tx, {
            action: 'procurement.rfq.deadline_extended',
            entityType: RFQ_AUDIT_ENTITY,
            entityId: rfqId,
            before: { deadline: rfq.deadline.toISOString() },
            after: { deadline: next.toISOString() },
          });
          return {
            status: 200,
            response: this.toRfqDto(row!, await this.invitedOf(tx, scope, rfqId)),
          };
        },
      );
      return done.response;
    });
  }

  // ------------------------------------------------------------------------------------------------- quotations

  /**
   * Records a quotation of an invited vendor on an open RFQ. 409 when the vendor was not invited or already quoted.
   * The quotation file must be evidence uploaded to this RFQ (round 5 P2): 422 `invalid_evidence_document` for any
   * other file (a picture, a vendor-inbox upload, a file of another record), 409 `document_infected`. Only this staff
   * path checks it: convertSubmission takes the vendor's own inbox file.
   */
  async recordQuotation(
    rfqId: string,
    body: RecordQuotationBody,
    idempotencyKey: string,
  ): Promise<QuotationDto> {
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'procurement.quotation.record', key: idempotencyKey, body: { rfqId, body } },
        async () => ({
          status: 201,
          // Typed in by staff now, so it arrives now (F1-Q47).
          response: await this.insertQuotation(
            tx,
            scope,
            rfqId,
            body,
            body.vendorId,
            body.documentId,
            this.clock(),
            { staffEvidence: true },
          ),
        }),
      );
      return done.response;
    });
  }

  /**
   * Converts a `received` inbox submission whose document scanned clean into a quotation of the same vendor, and
   * marks the submission converted. 409 when it is not `received`, names another RFQ or its file is not clean.
   */
  async convertSubmission(
    rfqId: string,
    body: ConvertSubmissionBody,
    idempotencyKey: string,
  ): Promise<QuotationDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'procurement.quotation.convert', key: idempotencyKey, body: { rfqId, body } },
        async () => {
          const [sub] = await tx
            .select()
            .from(vendorQuotationSubmissions)
            .where(
              scoped(scope).where(
                vendorQuotationSubmissions,
                eq(vendorQuotationSubmissions.id, body.submissionId),
              ),
            )
            .for('update');
          if (sub === undefined) throw notFound('Submission');
          if (sub.status !== 'received') throw conflict(`The submission is ${sub.status}`);
          if (sub.rfqId !== null && sub.rfqId !== rfqId) {
            throw conflict('The submission belongs to another RFQ');
          }
          const clean = await tx.execute<{ status: string }>(sql`
            SELECT status FROM app.document_versions
             WHERE tenant_id = ${scope.tenantId} AND organization_id = ${scope.organizationId}
               AND document_id = ${sub.documentId}
             ORDER BY version DESC LIMIT 1`);
          if (clean.rows[0]?.status !== 'clean') {
            throw conflict('The submitted file has not scanned clean');
          }
          const { submissionId: _s, ...fields } = body;
          // The vendor's upload arrived when the portal received it, however late staff convert it (F1-Q47).
          const quotation = await this.insertQuotation(
            tx,
            scope,
            rfqId,
            fields,
            sub.vendorId,
            sub.documentId,
            sub.receivedAt,
          );
          await tx
            .update(vendorQuotationSubmissions)
            .set({
              status: 'converted',
              convertedQuotationId: quotation.id,
              reviewedBy: principal.userId,
              reviewedAt: now,
              version: sql`${vendorQuotationSubmissions.version} + 1`,
              updatedAt: now,
            })
            .where(eq(vendorQuotationSubmissions.id, sub.id));
          return { status: 201, response: quotation };
        },
      );
      return done.response;
    });
  }

  /** Writes (or replaces) the caller's scores of one quotation of the RFQ. */
  async scoreQuotation(
    rfqId: string,
    quotationId: string,
    body: ScoreQuotationBody,
    idempotencyKey: string,
  ): Promise<ComparisonRow[]> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    await withTx(this.db, scope, actor, async (tx) => {
      await withIdempotency(
        tx,
        {
          command: 'procurement.quotation.score',
          key: idempotencyKey,
          body: { rfqId, quotationId, body },
        },
        async () => {
          await this.findRfq(tx, scope, rfqId);
          const [q] = await tx
            .select({ id: vendorQuotations.id })
            .from(vendorQuotations)
            .where(
              scoped(scope).where(
                vendorQuotations,
                and(eq(vendorQuotations.id, quotationId), eq(vendorQuotations.rfqId, rfqId)),
              ),
            );
          if (q === undefined) throw notFound('Quotation');
          for (const s of body.scores) {
            await tx
              .insert(vendorComparisonScores)
              .values({
                ...scope,
                vendorQuotationId: quotationId,
                criterion: s.criterion,
                score: s.score.toFixed(2),
                comment: s.comment ?? null,
                scoredBy: principal.userId,
              })
              .onConflictDoUpdate({
                target: [
                  vendorComparisonScores.tenantId,
                  vendorComparisonScores.vendorQuotationId,
                  vendorComparisonScores.criterion,
                ],
                set: {
                  score: s.score.toFixed(2),
                  comment: s.comment ?? null,
                  scoredBy: principal.userId,
                  updatedAt: now,
                },
              });
          }
          return { status: 200, response: null };
        },
      );
    });
    return this.comparison(rfqId);
  }

  /** The RFQ's quotations, cheapest NPR total first, with their scores. Internal only (never a portal view). */
  async comparison(rfqId: string): Promise<ComparisonRow[]> {
    const { scope } = this.caller.current();
    await this.findRfq(this.db, scope, rfqId);
    const rows = await this.db
      .select({ quote: vendorQuotations, vendorName: vendors.legalName })
      .from(vendorQuotations)
      .innerJoin(
        vendors,
        and(
          eq(vendors.tenantId, vendorQuotations.tenantId),
          eq(vendors.id, vendorQuotations.vendorId),
        ),
      )
      .where(scoped(scope).where(vendorQuotations, eq(vendorQuotations.rfqId, rfqId)));
    const quotes = rows.map((r) => r.quote);
    const nameOf = new Map(rows.map((r) => [r.quote.id, r.vendorName]));
    const scores =
      quotes.length === 0
        ? []
        : await this.db
            .select()
            .from(vendorComparisonScores)
            .where(
              scoped(scope).where(
                vendorComparisonScores,
                inArray(
                  vendorComparisonScores.vendorQuotationId,
                  quotes.map((q) => q.id),
                ),
              ),
            )
            .orderBy(asc(vendorComparisonScores.criterion));
    const lineRows =
      quotes.length === 0
        ? []
        : await this.db
            .select({
              line: vendorQuotationLines,
              lineNo: purchaseRequestLines.lineNo,
              taxCode: taxCodes.code,
              taxRateBp: taxCodes.rateBp,
            })
            .from(vendorQuotationLines)
            .innerJoin(
              purchaseRequestLines,
              and(
                eq(purchaseRequestLines.tenantId, vendorQuotationLines.tenantId),
                eq(purchaseRequestLines.organizationId, vendorQuotationLines.organizationId),
                eq(purchaseRequestLines.id, vendorQuotationLines.prLineId),
              ),
            )
            .innerJoin(
              taxCodes,
              and(
                eq(taxCodes.tenantId, vendorQuotationLines.tenantId),
                eq(taxCodes.id, vendorQuotationLines.taxCodeId),
              ),
            )
            .where(
              scoped(scope).where(
                vendorQuotationLines,
                inArray(
                  vendorQuotationLines.vendorQuotationId,
                  quotes.map((q) => q.id),
                ),
              ),
            )
            .orderBy(asc(purchaseRequestLines.lineNo));
    return quotes
      .map((q) => {
        const own = scores.filter((s) => s.vendorQuotationId === q.id);
        const avg =
          own.length === 0
            ? null
            : (Number(sumMoney(own.map((s) => s.score))) / own.length).toFixed(2);
        return {
          ...toQuotationDto(q),
          lines: lineRows
            .filter((r) => r.line.vendorQuotationId === q.id)
            .map((r) => ({
              id: r.line.id,
              prLineId: r.line.prLineId,
              lineNo: r.lineNo,
              description: r.line.description,
              quantity: r.line.quantity,
              unitPrice: r.line.unitPrice,
              taxCode: r.taxCode,
              taxRateBp: r.taxRateBp,
              gross: r.line.gross,
              taxAmount: r.line.taxAmount,
              lineTotal: r.line.lineTotal,
            })),
          vendorName: nameOf.get(q.id) ?? '',
          averageScore: avg,
          scores: own.map((s) => ({ criterion: s.criterion, score: s.score, comment: s.comment })),
        };
      })
      .sort((a, b) => Number(a.totalNpr) - Number(b.totalNpr));
  }

  // ------------------------------------------------------------------------------------------------- recommendation

  /**
   * Recommends one of the RFQ's quotations (AD13: fewer than `procurement.min_quotes` needs fewerThanThreeReason;
   * an emergency request may use its emergency reason, AD12). An open RFQ is closed first, in the same transaction
   * (RFQ_TRANSITIONS allows open → closed → recommended, not open → recommended; the close is audited as
   * procurement.rfq.closed). 409 when the RFQ is not open or closed, or the quote count is short without a reason.
   */
  async recommend(
    rfqId: string,
    body: RecommendQuotationBody,
    idempotencyKey: string,
  ): Promise<RfqDto> {
    const { scope, actor } = this.caller.current();
    const now = this.clock();
    const minQuotes = await this.minQuotes(scope);
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'procurement.rfq.recommend', key: idempotencyKey, body: { rfqId, body } },
        async () => {
          const rfq = await this.findRfq(tx, scope, rfqId, true);
          if (rfq.status !== 'open' && rfq.status !== 'closed') {
            throw conflict(`A ${rfq.status} RFQ cannot take a recommendation`);
          }
          const pr = await this.prOf(tx, scope, rfq.purchaseRequestId);
          const quotes = await tx
            .select({ id: vendorQuotations.id })
            .from(vendorQuotations)
            .where(scoped(scope).where(vendorQuotations, eq(vendorQuotations.rfqId, rfqId)));
          if (!quotes.some((q) => q.id === body.vendorQuotationId)) {
            throw badRequest('The recommended quotation is not one of this RFQ');
          }
          const verdict = quoteCountVerdict({
            count: quotes.length,
            minQuotes,
            fewerThanThreeReason: body.fewerThanThreeReason,
            isEmergency: pr.isEmergency,
            emergencyReason: pr.emergencyReason,
          });
          if (!verdict.ok) throw conflict(verdict.message, 'FEWER_THAN_MIN_QUOTES');
          if (rfq.status === 'open') {
            // RFQ_TRANSITIONS has no open → recommended: close first, in this same transaction.
            await tx
              .update(rfqs)
              .set({ status: 'closed', version: sql`${rfqs.version} + 1`, updatedAt: now })
              .where(eq(rfqs.id, rfqId));
            await this.audit.record(tx, {
              action: 'procurement.rfq.closed',
              entityType: RFQ_AUDIT_ENTITY,
              entityId: rfqId,
              before: { status: 'open' },
              after: { status: 'closed' },
            });
          }
          const [row] = await tx
            .update(rfqs)
            .set({
              status: 'recommended',
              recommendedQuotationId: body.vendorQuotationId,
              recommendationRationale: body.rationale,
              fewerThanThreeReason: verdict.fewerThanThreeReason,
              version: sql`${rfqs.version} + 1`,
              updatedAt: now,
            })
            .where(eq(rfqs.id, rfqId))
            .returning();
          await this.audit.record(tx, {
            action: RECOMMENDED_ACTION,
            entityType: RFQ_AUDIT_ENTITY,
            entityId: rfqId,
            before: { status: 'closed' },
            after: {
              status: 'recommended',
              recommendedQuotationId: body.vendorQuotationId,
              quoteCount: quotes.length,
              fewerThanThreeReason: verdict.fewerThanThreeReason,
            },
          });
          return {
            status: 200,
            response: this.toRfqDto(row!, await this.invitedOf(tx, scope, rfqId)),
          };
        },
      );
      return done.response;
    });
  }

  // ------------------------------------------------------------------------------------------------- commitment

  /**
   * Submits the recommended quote to the `pr_commitment` route (AD10). Facts: amountNpr (the quote's total incl.
   * VAT in NPR, AD3), requesterIsFounder (AD8), isEmergency. SoD: the requester, every recommender and the
   * submitter. 422 NO_ELIGIBLE_APPROVER (nothing written) when a step has nobody or the steps cannot get distinct
   * approvers. The request moves to commitment_pending.
   */
  async submitCommitment(rfqId: string, idempotencyKey: string): Promise<RfqDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency(
          tx,
          { command: 'procurement.commitment.submit', key: idempotencyKey, body: { rfqId } },
          async () => {
            const rfq = await this.findRfq(tx, scope, rfqId, true);
            if (rfq.status !== 'recommended' || rfq.recommendedQuotationId === null) {
              throw conflict(`A ${rfq.status} RFQ has no recommendation to commit`);
            }
            const pr = await this.prOf(tx, scope, rfq.purchaseRequestId);
            if (pr.status !== 'sourcing') {
              throw conflict(`The purchase request is ${pr.status}, not sourcing`);
            }
            const [quote] = await tx
              .select()
              .from(vendorQuotations)
              .where(
                scoped(scope).where(
                  vendorQuotations,
                  eq(vendorQuotations.id, rfq.recommendedQuotationId),
                ),
              );
            const requesterIsFounder = await this.holdsRole(
              tx,
              scope,
              pr.requesterUserId,
              'founder',
            );
            const facts = commitmentFactsOf({
              amountNpr: quote!.totalNpr,
              requesterIsFounder,
              isEmergency: pr.isEmergency,
            });
            const recommenders = await this.audit.entityUserActors(tx, RFQ_AUDIT_ENTITY, rfqId, [
              RECOMMENDED_ACTION,
            ]);
            const sodUserIds = [
              ...new Set([pr.requesterUserId, ...recommenders, principal.userId]),
            ];
            const reference = `Commitment ${rfq.number}`;
            const request = await this.approvals.submit(tx, {
              documentType: PR_COMMITMENT_DOCUMENT_TYPE,
              documentId: rfq.id,
              documentNumber: rfq.number,
              title: `${reference} (${pr.number ?? pr.id.slice(0, 8)})`,
              snapshot: {
                commitment: {
                  rfqNumber: rfq.number,
                  purchaseRequestNumber: pr.number,
                  vendorId: quote!.vendorId,
                  currency: quote!.currency,
                  subtotal: quote!.subtotal,
                  taxAmount: quote!.taxAmount,
                  total: quote!.total,
                  fxRate: quote!.fxRate,
                  totalNpr: quote!.totalNpr,
                  rationale: rfq.recommendationRationale,
                  fewerThanThreeReason: rfq.fewerThanThreeReason,
                  isEmergency: pr.isEmergency,
                },
              },
              facts,
              requesterUserId: pr.requesterUserId,
              submittedByUserId: principal.userId,
              sodUserIds,
            });
            if (request.status === 'blocked') throw new NoEligibleApprover('No eligible approver');

            const [row] = await tx
              .update(rfqs)
              .set({
                commitmentApprovalRequestId: request.requestId,
                version: sql`${rfqs.version} + 1`,
                updatedAt: now,
              })
              .where(eq(rfqs.id, rfqId))
              .returning();
            await this.setPrStatus(tx, scope, pr.id, 'sourcing', 'commitment_pending', now);
            await this.audit.record(tx, {
              action: 'procurement.commitment.submitted',
              entityType: RFQ_AUDIT_ENTITY,
              entityId: rfqId,
              after: {
                approvalRequestId: request.requestId,
                amountNpr: facts.amountNpr,
                band: poBandOf(facts.amountNpr),
                requesterIsFounder,
              },
            });
            return {
              status: 200,
              response: this.toRfqDto(row!, await this.invitedOf(tx, scope, rfqId)),
            };
          },
        );
        return done.response;
      });
    } catch (error) {
      if (!(error instanceof NoEligibleApprover)) throw error;
      throw new UnprocessableEntityException({
        code: 'NO_ELIGIBLE_APPROVER',
        message: `This commitment cannot be submitted: ${error.reason}`,
      });
    }
  }

  // ------------------------------------------------------------------------------------------------- helpers

  private async insertQuotation(
    tx: DbTransaction,
    scope: TxScope,
    rfqId: string,
    body: Omit<RecordQuotationBody, 'vendorId' | 'documentId'>,
    vendorId: string,
    documentId: string,
    arrivedAt: Date,
    opts: { staffEvidence?: boolean } = {},
  ): Promise<QuotationDto> {
    const { principal } = this.caller.current();
    const now = this.clock();
    // Before any read or write: 422 CURRENCY_NOT_ENABLED for a currency the company has not switched on (D44).
    await this.currencies.assertEnabled(scope, body.currency);
    const rfq = await this.findRfq(tx, scope, rfqId, true);
    if (rfq.status !== 'open') throw conflict(`A ${rfq.status} RFQ takes no quotation`);
    // F1-Q47: nothing that arrived after the deadline is taken; Procurement extends the deadline instead.
    if (isLateQuotation(rfq.deadline, arrivedAt)) {
      throw conflict(RFQ_DEADLINE_PASSED_MESSAGE, RFQ_DEADLINE_PASSED);
    }
    const invited = await this.vendorIdsOf(tx, scope, rfqId);
    if (!invited.includes(vendorId)) throw conflict('The vendor was not invited to this RFQ');
    if (opts.staffEvidence === true) {
      // Round 5 P2, staff only: a file uploaded to this RFQ as its evidence (422 invalid_evidence_document).
      await assertEvidenceDocument(tx, scope, documentId, rfqId);
    } else {
      // The inbox conversion: the vendor's own submission file, which its caller already checked is clean.
      const [doc] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          scoped(scope).where(
            documents,
            and(eq(documents.id, documentId), isNull(documents.removedAt)),
          ),
        );
      if (doc === undefined) throw badRequest('Unknown document');
      await assertNotInfected(tx, scope, [documentId]);
    }

    const prLines = await tx
      .select({ id: purchaseRequestLines.id, description: purchaseRequestLines.description })
      .from(purchaseRequestLines)
      .where(
        scoped(scope).where(
          purchaseRequestLines,
          eq(purchaseRequestLines.purchaseRequestId, rfq.purchaseRequestId),
        ),
      );
    const prLineText = new Map(prLines.map((l) => [l.id, l.description]));
    const taxIds = [...new Set(body.lines.map((l) => l.taxCodeId))];
    const taxes = await tx
      .select({ id: taxCodes.id, rateBp: taxCodes.rateBp })
      .from(taxCodes)
      .where(and(eq(taxCodes.tenantId, scope.tenantId), inArray(taxCodes.id, taxIds)));
    const rateOf = new Map(taxes.map((t) => [t.id, t.rateBp]));
    const lines = body.lines.map((l) => {
      const requestText = prLineText.get(l.prLineId);
      if (requestText === undefined) throw badRequest('A line prices no line of the request');
      const rate = rateOf.get(l.taxCodeId);
      if (rate === undefined) throw badRequest('Unknown tax code');
      return {
        ...l,
        description: l.description ?? requestText,
        ...quotationLineAmounts(l.quantity, l.unitPrice, rate),
      };
    });
    const subtotal = sumMoney(lines.map((l) => l.gross));
    const taxAmount = sumMoney(lines.map((l) => l.taxAmount));
    const total = sumMoney([subtotal, taxAmount]);
    const fx = await this.money.toNprSnapshot(
      tx,
      scope,
      { amount: total, currency: body.currency },
      now,
    );
    const isNpr = body.currency === 'NPR';

    let quote: QuotationRow;
    try {
      [quote] = (await tx
        .insert(vendorQuotations)
        .values({
          ...scope,
          rfqId,
          purchaseRequestId: rfq.purchaseRequestId,
          vendorId,
          vendorRef: body.vendorRef ?? null,
          validUntil: body.validUntil ?? null,
          currency: body.currency,
          subtotal,
          taxAmount,
          total,
          fxRate: fx.rate,
          fxSource: isNpr ? null : fx.rateSource,
          fxDate: isNpr ? null : fx.rateDate,
          totalNpr: fx.amountNpr,
          deliveryDays: body.deliveryDays ?? null,
          warranty: body.warranty ?? null,
          terms: body.terms ?? null,
          documentId,
          recordedBy: principal.userId,
        })
        .returning()) as [QuotationRow];
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw conflict('This vendor already quoted on this RFQ');
      }
      throw error;
    }
    await tx.insert(vendorQuotationLines).values(
      lines.map((l) => ({
        ...scope,
        vendorQuotationId: quote.id,
        purchaseRequestId: rfq.purchaseRequestId,
        prLineId: l.prLineId,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxCodeId: l.taxCodeId,
        gross: l.gross,
        taxAmount: l.taxAmount,
        lineTotal: l.lineTotal,
      })),
    );
    await this.audit.record(tx, {
      action: 'procurement.quotation.recorded',
      entityType: RFQ_AUDIT_ENTITY,
      entityId: rfqId,
      after: { quotationId: quote.id, vendorId, total, totalNpr: fx.amountNpr },
    });
    return toQuotationDto(quote);
  }

  /** 409 unless every vendor is `approved` and has an active account in the acting entity. */
  private async assertInvitable(
    tx: DbTransaction,
    scope: TxScope,
    vendorIds: string[],
  ): Promise<void> {
    const rows = await tx
      .select({ id: vendors.id, status: vendors.status })
      .from(vendors)
      .where(and(eq(vendors.tenantId, scope.tenantId), inArray(vendors.id, vendorIds)));
    const statusOf = new Map(rows.map((r) => [r.id, r.status]));
    for (const id of vendorIds) {
      const status = statusOf.get(id);
      if (status === undefined) throw badRequest(`Unknown vendor ${id}`);
      if (status !== 'approved') {
        throw conflict(
          `Vendor ${id} is ${status}; only approved vendors are invited`,
          'VENDOR_NOT_APPROVED',
        );
      }
    }
    const accounts = await tx
      .select({ vendorId: vendorAccounts.vendorId })
      .from(vendorAccounts)
      .where(
        scoped(scope).where(
          vendorAccounts,
          and(inArray(vendorAccounts.vendorId, vendorIds), eq(vendorAccounts.active, true)),
        ),
      );
    const withAccount = new Set(accounts.map((a) => a.vendorId));
    for (const id of vendorIds) {
      if (!withAccount.has(id)) {
        throw conflict(`Vendor ${id} has no account in this entity`, 'VENDOR_NOT_IN_ENTITY');
      }
    }
  }

  /** Whether the user holds `role` in the acting entity, read from the engine's own directory. */
  private async holdsRole(
    tx: DbTransaction,
    scope: TxScope,
    userId: string,
    role: 'founder',
  ): Promise<boolean> {
    const probe = WorkflowSpecSchema.parse({
      documentType: PR_COMMITMENT_DOCUMENT_TYPE,
      steps: [{ id: 'probe', kind: 'role', role, reason: 'role lookup' }],
    });
    const data = await this.approvals.loadDirectory(tx, scope, probe);
    return (data.roleMembers.get(role) ?? []).includes(userId);
  }

  private async minQuotes(scope: TxScope): Promise<number> {
    const value = await this.settings.get(scope, 'procurement.min_quotes');
    return typeof value === 'number' ? value : DEFAULT_MIN_QUOTES;
  }

  private async findRfq(
    q: Pick<Db, 'select'>,
    scope: TxScope,
    id: string,
    lock = false,
  ): Promise<RfqRow> {
    const query = q
      .select()
      .from(rfqs)
      .where(scoped(scope).where(rfqs, eq(rfqs.id, id)));
    const [row] = lock ? await query.for('update') : await query;
    if (row === undefined) throw notFound();
    return row;
  }

  private async prOf(tx: DbTransaction, scope: TxScope, id: string) {
    const [pr] = await tx
      .select()
      .from(purchaseRequests)
      .where(scoped(scope).where(purchaseRequests, eq(purchaseRequests.id, id)))
      .for('update');
    if (pr === undefined) throw notFound('Purchase request');
    return pr;
  }

  private async setPrStatus(
    tx: DbTransaction,
    scope: TxScope,
    id: string,
    from: (typeof purchaseRequests.$inferSelect)['status'],
    to: (typeof purchaseRequests.$inferSelect)['status'],
    now: Date,
  ): Promise<void> {
    const updated = await tx
      .update(purchaseRequests)
      .set({ status: to, version: sql`${purchaseRequests.version} + 1`, updatedAt: now })
      .where(
        scoped(scope).where(
          purchaseRequests,
          and(eq(purchaseRequests.id, id), eq(purchaseRequests.status, from)),
        ),
      )
      .returning({ id: purchaseRequests.id });
    if (updated.length === 0) throw conflict(`The purchase request is no longer ${from}`);
  }

  private async vendorIdsOf(
    q: Pick<Db, 'select'>,
    scope: TxScope,
    rfqId: string,
  ): Promise<string[]> {
    const rows = await q
      .select({ vendorId: rfqVendors.vendorId })
      .from(rfqVendors)
      .where(scoped(scope).where(rfqVendors, eq(rfqVendors.rfqId, rfqId)));
    return rows.map((r) => r.vendorId);
  }

  /** The RFQ's invited vendors with their legal names, by name. Vendors are tenant level: joined on (tenant, id). */
  private async invitedOf(
    q: Pick<Db, 'select'>,
    scope: TxScope,
    rfqId: string,
  ): Promise<InvitedVendor[]> {
    return q
      .select({ id: rfqVendors.vendorId, name: vendors.legalName })
      .from(rfqVendors)
      .innerJoin(
        vendors,
        and(eq(vendors.tenantId, rfqVendors.tenantId), eq(vendors.id, rfqVendors.vendorId)),
      )
      .where(scoped(scope).where(rfqVendors, eq(rfqVendors.rfqId, rfqId)))
      .orderBy(asc(vendors.legalName), asc(rfqVendors.vendorId));
  }

  private toRfqDto(r: RfqRow, invited: InvitedVendor[]): RfqDto {
    return {
      id: r.id,
      number: r.number,
      purchaseRequestId: r.purchaseRequestId,
      deadline: r.deadline.toISOString(),
      status: r.status,
      vendorIds: invited.map((v) => v.id),
      vendors: invited,
      recommendedQuotationId: r.recommendedQuotationId,
      fewerThanThreeReason: r.fewerThanThreeReason,
      recommendationRationale: r.recommendationRationale,
      commitmentApprovalRequestId: r.commitmentApprovalRequestId,
      version: r.version,
    };
  }
}
