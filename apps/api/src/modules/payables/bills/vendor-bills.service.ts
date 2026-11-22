// VendorBillsService: vendor bills, their three-way match and the match exceptions (P4 unit A1; AD5, AD6, AD14).
// Serves the NFRs:
// - "amounts are exact": net = round(qty x price, 2) and VAT from the tax code's rate, decimal.js strings; the
//   client never sends a total (CreateVendorBillBodySchema is strict);
// - "no duplicates": the generated invoice_no_norm makes INV-001 and inv 001 one invoice of a vendor in a fiscal
//   year; the unique key refuses the second and the API answers 409 (check 8);
// - "money moves only after the right people agree": submit is refused (409) unless every line is within the AD6
//   tolerance (from settings) or Finance approved a match exception; the bill route has the person who entered it
//   in sod_user_ids, so its Accountant step is another accountant (AD5);
// - "no double effects" and "no lost updates": every write runs in withIdempotency and locks the bill FOR UPDATE
//   before it changes it; a match run also locks the PO lines it reads (ascending id, after the bill), so two bills
//   against one receipt are matched one after the other and the second sees the first's quantity;
// - "one legal entity at a time": every read is scoped to the acting entity; a bill, PO or line of another entity
//   is a 404 (or a 422 for a line), never a 403;
// - "a saved reach is the reach enforced" (U20a phase 2): list and get read through the `payables.bill.read` scope
//   (scopeWhereFor, so the count and the rows agree with the record check), and every command on a bill first needs
//   that read (404 outside it) and then `payables.bill.enter` on the bill (403). Whoever entered a bill owns it and
//   bills carry no department, so `own` and `department` both reach the bills the caller entered; a new bill is
//   always the caller's own;
// - "a void leaves a trail" (unit A1c): open items are append-only, so a void opens a vendor_debit_note payable
//   debit for the full amount and allocates it against the bill's credit item through LedgerService; only a bill
//   with nothing allocated yet and no live payment request on it may be voided;
// - "a portal invoice becomes a bill once" (unit A1d): converting an inbox submission locks the row, checks its file
//   scanned clean, creates the bill and marks the row converted in one transaction, so a second convert is a 409;
// - the purchase VAT register (check 17): its total is the creditable VAT of the approved bills of the period.
// Approval of a bill (the payable open item and `vendor_bill_posted`) is the subject's (vendor-bill.subject.ts).
import { randomUUID } from 'node:crypto';

import type {
  BillStatus,
  CreateVendorBillBody,
  MatchStatus,
  RequestMatchExceptionBody,
  VendorBillCan,
  VoidVendorBillBody,
} from '@bos/contracts';
import {
  documents,
  matchExceptions,
  matchResults,
  openItems,
  paymentRequestLines,
  paymentRequests,
  poLineProgress,
  purchaseOrderLines,
  purchaseOrders,
  receiptLines,
  scoped,
  taxCodes,
  vendorAccounts,
  vendorBillLines,
  vendorBillSubmissions,
  vendorBills,
  vendors,
  withholdingCodes,
} from '@bos/db';
import { fiscalYearOf, formatBs, kathmanduDate } from '@bos/locale';
import { parseDecimal, type MatchTolerance } from '@bos/money-rules';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, asc, between, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { scopeWhereFor } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { DenyReason, Principal, ResourceRef } from '../../../platform/authz/principal';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type TxScope, READ_ONLY } from '../../../platform/db/tx';
import { searchPage } from '../../../platform/list';
import {
  assertNotInfected,
  newestDocumentVersion,
} from '../../../platform/documents/documents.service';
import { assertEvidenceDocument } from '../../../platform/documents/evidence-document';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { ApprovalsService } from '../../approvals/requests.service';
import { CompanyAccountsLookup } from '../../company-accounts/company-accounts.lookup';
import { LedgerService } from '../../ledger/ledger.service';
import { CLAIMING_REQUEST_STATUSES } from '../payment-requests/payment-request.rules';
import {
  BILLABLE_PO_STATUSES,
  BILL_AUDIT_ENTITY,
  BILL_DEDUP_CONSTRAINT,
  MATCH_EXCEPTION_AUDIT_ENTITY,
  MATCH_EXCEPTION_DOCUMENT_TYPE,
  VENDOR_BILL_DOCUMENT_TYPE,
  afterMatch,
  assertInvoiceDateByToday,
  billFactsOf,
  billTotals,
  invoiceInstant,
  lineAmounts,
  matchLine,
  submittable,
  type ListBillsQuery,
} from './vendor-bill.rules';
import type { ConvertBillSubmissionBody } from './bill-submissions.types';
import { VendorBillsCaller } from './vendor-bills.caller';

/** Injection token for a test clock; production falls back to the system time. */
export const VENDOR_BILLS_CLOCK = Symbol('VENDOR_BILLS_CLOCK');

type BillRow = typeof vendorBills.$inferSelect;
type SubmissionRow = typeof vendorBillSubmissions.$inferSelect;
type BillLineRow = typeof vendorBillLines.$inferSelect;
type MatchResultRow = typeof matchResults.$inferSelect;
type ExceptionRow = typeof matchExceptions.$inferSelect;

export interface VendorBillLineDto {
  id: string;
  lineNo: number;
  poLineId: string | null;
  receiptLineId: string | null;
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  netAmount: string;
  taxCodeId: string;
  vatAmount: string;
  tdsCodeId: string | null;
  tdsAmount: string;
  /** The latest match run of the line, when the bill is matched against a PO. */
  match: {
    runNo: number;
    status: MatchResultRow['status'];
    receivedQuantity: string | null;
    billedQuantity: string;
    quantityVariance: string;
    priceVariance: string;
    taxVariance: string;
  } | null;
}

export interface VendorBillDto {
  id: string;
  kind: BillRow['kind'];
  number: string | null;
  vendorPartyId: string;
  vendorName: string;
  vendorInvoiceNo: string;
  invoiceDate: string;
  fiscalYear: string;
  currency: BillRow['currency'];
  purchaseOrderId: string | null;
  /**
   * The PO's number, joined in the bill's own tenant and entity, so a reader of the bill (Finance included) sees it
   * with no purchase order read of their own. Null when the bill names no PO.
   */
  purchaseOrderNumber: string | null;
  documentId: string;
  fileStatus?: string | null;
  status: BillStatus;
  matchStatus: MatchStatus;
  netTotal: string;
  vatTotal: string;
  tdsTotal: string;
  payableTotal: string;
  enteredBy: string;
  approvalRequestId: string | null;
  version: number;
  lines: VendorBillLineDto[];
  /** The caller's moves on this bill from their live grants (GET list and detail only; see billCan). */
  can?: VendorBillCan;
}

export interface MatchExceptionDto {
  id: string;
  vendorBillId: string;
  reason: string;
  status: ExceptionRow['status'];
  requestedBy: string;
  decidedBy: string | null;
  approvalRequestId: string | null;
}

export interface VatRegisterRowDto {
  vendorBillId: string;
  billNumber: string | null;
  vendorPartyId: string;
  vendorName: string;
  /** Absent only for a foreign vendor. */
  vendorPan: string | null;
  vendorInvoiceNo: string;
  invoiceDate: string;
  /** The invoice date in Bikram Sambat, YYYY-MM-DD. */
  invoiceDateBs: string;
  /** Net of the lines whose tax code is creditable (a vendor credit note counts negative). */
  taxableAmount: string;
  /** VAT of the lines whose tax code is creditable (a vendor credit note counts negative). */
  vatAmount: string;
}

export interface VatRegisterDto {
  from: string;
  to: string;
  rows: VatRegisterRowDto[];
  total: { taxableAmount: string; vatAmount: string };
}

/** Bills whose input VAT is claimed: approved and onward, never voided, rejected or still in approval. */
const VAT_REGISTER_STATUSES = ['approved', 'partially_paid', 'paid'] as const;

const notFound = (what: string) =>
  new NotFoundException({ code: 'not_found', message: `${what} not found` });
const conflict = (code: string, message: string) => new ConflictException({ code, message });
const forbidden = (reason: DenyReason) =>
  new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason });

/**
 * The record authz decides a bill on: whoever entered it owns it (record-reach.ts names the same column for the
 * list), and a bill has no department.
 */
const billRef = (
  bill: Pick<BillRow, 'tenantId' | 'organizationId' | 'enteredBy'>,
): ResourceRef => ({
  tenantId: bill.tenantId,
  organizationId: bill.organizationId,
  ownerUserId: bill.enteredBy,
});

/**
 * The caller's moves on a bill they can read: the same payables.bill.enter record check lockEnterable makes, so a
 * row never offers a command the API refuses (an `own` grant reaches only the bills its holder entered).
 */
function billCan(
  p: Principal,
  bill: Pick<BillRow, 'tenantId' | 'organizationId' | 'enteredBy'>,
): VendorBillCan {
  const enter = can(p, 'payables.bill.enter', billRef(bill)).allowed;
  return { match: enter, submit: enter, void: enter, discard: enter, exception: enter };
}

/**
 * A new bill belongs to the person entering it, so every `payables.bill.enter` grant that reaches a record at all
 * (own, department, all) may create one. Checked on that record anyway, so a scope that reaches no bill is refused.
 */
function assertMayEnterNew(p: Principal, scope: TxScope): void {
  const decision = can(p, 'payables.bill.enter', { ...scope, ownerUserId: p.userId });
  if (!decision.allowed) throw forbidden(decision.reason);
}
const unprocessable = (code: string, message: string) =>
  new UnprocessableEntityException({ code, message });

/** Thrown inside the transaction so it rolls back (idempotency claim included). */
class NoEligibleApprover extends Error {
  constructor(readonly reason: string) {
    super('no eligible approver');
  }
}

/** The Postgres error behind `error`, also when drizzle wraps it (`cause`). */
function pgErrorOf(error: unknown): { code: string; constraint: string | undefined } | undefined {
  let e: unknown = error;
  for (let depth = 0; depth < 4 && typeof e === 'object' && e !== null; depth += 1) {
    const { code, constraint, cause } = e as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return { code, constraint: typeof constraint === 'string' ? constraint : undefined };
    }
    e = cause;
  }
  return undefined;
}

/** The 409 for a duplicate invoice number (the dedup key), or the error itself. */
function duplicateBillOr(error: unknown): unknown {
  const pg = pgErrorOf(error);
  if (pg?.code === '23505' && pg.constraint === BILL_DEDUP_CONSTRAINT) {
    return conflict(
      'DUPLICATE_BILL',
      'This vendor already has a bill with this invoice number in the fiscal year',
    );
  }
  return error;
}

const sum = (values: readonly string[]) =>
  values.reduce((acc, v) => acc.plus(v), new Decimal(0)).toFixed(2);

@Injectable()
export class VendorBillsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly caller: VendorBillsCaller,
    @Optional()
    @Inject(VENDOR_BILLS_CLOCK)
    private readonly clock: () => Date = () => new Date(),
    // Optional and defaulted so callers that build the service by hand keep working and the module boots
    // before it imports LedgerModule; LedgerService holds no state, so the fallback is the same service.
    @Optional()
    private readonly ledger: LedgerService = new LedgerService(),
    @Optional()
    private readonly numbering: NumberingService = new NumberingService(),
    // Same reason: the lookup holds no state, so a hand-built service checks accounts the way the module's does.
    @Optional()
    private readonly accounts: CompanyAccountsLookup = new CompanyAccountsLookup(),
  ) {}

  // ------------------------------------------------------------------------------------------------- reads

  /**
   * One page of the entity's bills, newest first, optionally of some statuses and a search over the bill number,
   * the vendor's invoice number and the vendor name, with the total of all matches. The id closes the order so
   * bills created in the same instant never swap between pages.
   */
  async list(
    query: ListBillsQuery,
  ): Promise<{ rows: Omit<VendorBillDto, 'lines'>[]; total: number }> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const vendorJoin = and(
          eq(vendors.tenantId, vendorBills.tenantId),
          eq(vendors.id, vendorBills.vendorId),
        );
        const page = await searchPage(tx, {
          q: query.q,
          columns: [vendorBills.number, vendorBills.vendorInvoiceNo, vendors.legalName],
          // The read scope rides in `where`, so the rows and the total both stop at it.
          where: and(
            scopeWhereFor(principal, vendorBills, 'payables.bill.read'),
            query.status === undefined || query.status.length === 0
              ? undefined
              : inArray(vendorBills.status, query.status),
          ),
          orderBy: [desc(vendorBills.createdAt), desc(vendorBills.id)],
          limit: query.limit,
          offset: query.offset,
          rows: (reader, p) =>
            reader
              .select({
                bill: vendorBills,
                vendorName: vendors.legalName,
                purchaseOrderNumber: purchaseOrders.number,
              })
              .from(vendorBills)
              .innerJoin(vendors, vendorJoin)
              .leftJoin(purchaseOrders, poOfBill())
              .where(p.where)
              .orderBy(...p.orderBy)
              .limit(p.limit)
              .offset(p.offset),
          count: async (reader, where) => {
            const [row] = await reader
              .select({ n: sql<number>`count(*)::int` })
              .from(vendorBills)
              .innerJoin(vendors, vendorJoin)
              .where(where);
            return row?.n ?? 0;
          },
        });
        return {
          rows: page.rows.map((row) => {
            const { lines: _lines, ...rest } = toDto(
              row.bill,
              row.vendorName,
              row.purchaseOrderNumber,
              [],
              [],
            );
            return { ...rest, can: billCan(principal, row.bill) };
          }),
          total: page.total,
        };
      },
      READ_ONLY,
    );
  }

  /** 404 outside the acting entity and outside the caller's `payables.bill.read` scope (the list's rule). */
  async get(id: string): Promise<VendorBillDto> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const [visible] = await tx
          .select({
            tenantId: vendorBills.tenantId,
            organizationId: vendorBills.organizationId,
            enteredBy: vendorBills.enteredBy,
          })
          .from(vendorBills)
          .where(
            and(
              scopeWhereFor(principal, vendorBills, 'payables.bill.read'),
              eq(vendorBills.id, id),
            ),
          )
          .limit(1);
        if (visible === undefined) throw notFound('Bill');
        return { ...(await this.dto(tx, scope, id)), can: billCan(principal, visible) };
      },
      READ_ONLY,
    );
  }

  // ------------------------------------------------------------------------------------------------- create

  /**
   * Keys in a bill and, when it names a PO, runs the match. 201 with the bill. 404 for a vendor without an active
   * account here or a PO of another entity; 422 for a line that is not the PO's, a receipt line of another PO line,
   * an unknown tax or withholding code; 409 for a PO that is not issued or receiving, or a duplicate invoice number.
   */
  async create(body: CreateVendorBillBody, idempotencyKey: string): Promise<VendorBillDto> {
    const { scope, actor, principal } = this.caller.current();
    assertMayEnterNew(principal, scope);
    const now = this.clock();
    const tolerance = await this.tolerance(scope);
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency(
          tx,
          {
            command: 'payables.bill.create',
            key: idempotencyKey,
            // The entity is part of the request, so a retry made while acting in another entity is refused, not replayed.
            body: { ...body, organizationId: scope.organizationId },
          },
          async () => {
            const bill =
              body.sourceSubmissionId === undefined
                ? await this.insertBill(tx, scope, principal.userId, body, now)
                : await this.insertFromSubmission(
                    tx,
                    scope,
                    principal.userId,
                    await this.lockSubmission(tx, scope, body.sourceSubmissionId),
                    body,
                    now,
                  );
            if (bill.purchaseOrderId !== null) {
              await this.runMatch(tx, scope, bill.id, principal.userId, tolerance, now);
            }
            return { status: 201, response: await this.dto(tx, scope, bill.id) };
          },
        );
        return done.response;
      });
    } catch (error) {
      throw duplicateBillOr(error);
    }
  }

  // ------------------------------------------------------------------------------------ convert a submission

  /**
   * Turns a `received` portal inbox submission into a vendor bill (Journey 11): the vendor, invoice number, date,
   * PO and file are the submission's, the lines are the accountant's. The bill is created, matched when it names a
   * PO, and the submission marked converted with the bill and the reviewer, all in one transaction. 201 with the
   * bill; a replayed key answers the same bill. 404 for a submission of another entity; 409 when it is not
   * `received` or its file has not scanned clean; 422 when it has no vendor or invoice number or date; the other
   * refusals are those of `create`.
   */
  async convertSubmission(
    submissionId: string,
    body: ConvertBillSubmissionBody,
    idempotencyKey: string,
  ): Promise<VendorBillDto> {
    const { scope, actor, principal } = this.caller.current();
    assertMayEnterNew(principal, scope);
    const now = this.clock();
    const tolerance = await this.tolerance(scope);
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency(
          tx,
          {
            command: 'payables.bill.convert_submission',
            key: idempotencyKey,
            body: { submissionId, body, organizationId: scope.organizationId },
          },
          async () => {
            const sub = await this.lockSubmission(tx, scope, submissionId);
            if (sub.vendorInvoiceNo === null || sub.invoiceDate === null) {
              throw unprocessable(
                'SUBMISSION_INCOMPLETE',
                'The submission has no invoice number or invoice date',
              );
            }
            const bill = await this.insertFromSubmission(
              tx,
              scope,
              principal.userId,
              sub,
              {
                vendorPartyId: sub.vendorPartyId!,
                kind: 'bill',
                vendorInvoiceNo: sub.vendorInvoiceNo,
                invoiceDate: sub.invoiceDate,
                currency: 'NPR',
                ...(sub.purchaseOrderId === null ? {} : { purchaseOrderId: sub.purchaseOrderId }),
                documentId: sub.documentId,
                sourceSubmissionId: sub.id,
                lines: body.lines,
              },
              now,
            );
            if (bill.purchaseOrderId !== null) {
              await this.runMatch(tx, scope, bill.id, principal.userId, tolerance, now);
            }
            return { status: 201, response: await this.dto(tx, scope, bill.id) };
          },
        );
        return done.response;
      });
    } catch (error) {
      throw duplicateBillOr(error);
    }
  }

  /**
   * Locks an inbox row of the acting entity and refuses unless it can become a bill: 404 when it is not in this
   * entity, 409 SUBMISSION_NOT_RECEIVED unless `received`, 422 SUBMISSION_HAS_NO_VENDOR for a row without a vendor
   * (a bill needs one), 409 SUBMISSION_FILE_NOT_CLEAN unless the newest version of its file scanned clean.
   */
  private async lockSubmission(
    tx: DbTransaction,
    scope: TxScope,
    id: string,
  ): Promise<SubmissionRow> {
    const [sub] = await tx
      .select()
      .from(vendorBillSubmissions)
      .where(scoped(scope).where(vendorBillSubmissions, eq(vendorBillSubmissions.id, id)))
      .for('update');
    if (sub === undefined) throw notFound('Submission');
    if (sub.status !== 'received') {
      throw conflict('SUBMISSION_NOT_RECEIVED', `The submission is ${sub.status}`);
    }
    if (sub.vendorPartyId === null) {
      throw unprocessable('SUBMISSION_HAS_NO_VENDOR', 'The submission names no vendor');
    }
    const latest = await tx.execute<{ status: string }>(sql`
      SELECT status FROM app.document_versions
       WHERE tenant_id = ${scope.tenantId} AND organization_id = ${scope.organizationId}
         AND document_id = ${sub.documentId}
       ORDER BY version DESC LIMIT 1`);
    if (latest.rows[0]?.status !== 'clean') {
      throw conflict('SUBMISSION_FILE_NOT_CLEAN', 'The submitted file has not scanned clean');
    }
    return sub;
  }

  /**
   * Inserts the bill of a locked submission and marks the row converted (the bill, the reviewer and the time). A
   * body that is not the submission's (another vendor, invoice number, date, PO or file) is a 422
   * SUBMISSION_MISMATCH: the submission is what the vendor sent, staff only add the lines.
   */
  private async insertFromSubmission(
    tx: DbTransaction,
    scope: TxScope,
    userId: string,
    sub: SubmissionRow,
    body: CreateVendorBillBody,
    now: Date,
  ): Promise<BillRow> {
    if (
      body.vendorPartyId !== sub.vendorPartyId ||
      body.vendorInvoiceNo !== sub.vendorInvoiceNo ||
      body.invoiceDate !== sub.invoiceDate ||
      body.documentId !== sub.documentId ||
      (body.purchaseOrderId ?? null) !== sub.purchaseOrderId
    ) {
      throw unprocessable(
        'SUBMISSION_MISMATCH',
        'The bill does not match the submission it is keyed from',
      );
    }
    const bill = await this.insertBill(tx, scope, userId, body, now);
    await tx
      .update(vendorBillSubmissions)
      .set({
        status: 'converted',
        convertedBillId: bill.id,
        reviewedBy: userId,
        reviewedAt: now,
        version: sql`${vendorBillSubmissions.version} + 1`,
        updatedAt: now,
      })
      .where(scoped(scope).where(vendorBillSubmissions, eq(vendorBillSubmissions.id, sub.id)));
    await this.audit.record(tx, {
      action: 'payables.bill_submission.converted',
      entityType: 'vendor_bill_submission',
      entityId: sub.id,
      after: { vendorBillId: bill.id, vendorInvoiceNo: bill.vendorInvoiceNo },
    });
    return bill;
  }

  private async insertBill(
    tx: DbTransaction,
    scope: TxScope,
    userId: string,
    body: CreateVendorBillBody,
    now: Date,
  ): Promise<BillRow> {
    if (body.kind !== 'bill') {
      throw unprocessable('BILL_KIND_NOT_SUPPORTED', 'Only bills can be keyed in for now');
    }
    if (body.currency !== 'NPR') {
      throw unprocessable('CURRENCY_NOT_SUPPORTED', 'Only NPR bills can be keyed in for now');
    }
    assertInvoiceDateByToday(body.invoiceDate, now);
    const s = scoped(scope);
    const [account] = await tx
      .select({ id: vendorAccounts.id })
      .from(vendorAccounts)
      .where(
        s.where(
          vendorAccounts,
          and(eq(vendorAccounts.vendorId, body.vendorPartyId), eq(vendorAccounts.active, true)),
        ),
      );
    if (account === undefined) throw notFound('Vendor');
    const [doc] = await tx
      .select({ id: documents.id, ownerType: documents.ownerType, ownerId: documents.ownerId })
      .from(documents)
      .where(
        s.where(documents, and(eq(documents.id, body.documentId), isNull(documents.removedAt))),
      );
    if (
      doc === undefined ||
      !['vendor_bill_intake', 'vendor_portal_intake'].includes(doc.ownerType) ||
      doc.ownerId !== body.vendorPartyId
    ) {
      throw unprocessable('DOCUMENT_NOT_FOUND', 'The invoice file was not found');
    }
    await assertNotInfected(tx, scope, [body.documentId]);

    const poLineIds = body.lines.flatMap((l) => (l.poLineId === undefined ? [] : [l.poLineId]));
    if (body.lines.some((l) => l.receiptLineId !== undefined && l.poLineId === undefined)) {
      throw unprocessable('PO_LINE_REQUIRED', 'A receipt line needs its purchase order line');
    }
    const poLines = new Map<string, typeof purchaseOrderLines.$inferSelect>();
    if (body.purchaseOrderId === undefined) {
      if (poLineIds.length > 0) {
        throw unprocessable(
          'PO_REQUIRED',
          'A line linked to a purchase order line needs the purchase order',
        );
      }
    } else {
      const [po] = await tx
        .select()
        .from(purchaseOrders)
        .where(s.where(purchaseOrders, eq(purchaseOrders.id, body.purchaseOrderId)))
        .for('share');
      if (po === undefined) throw notFound('Purchase order');
      if (po.vendorId !== body.vendorPartyId) {
        throw unprocessable('PO_VENDOR_MISMATCH', 'The purchase order is for another vendor');
      }
      if (!(BILLABLE_PO_STATUSES as readonly string[]).includes(po.status)) {
        throw conflict('PO_NOT_BILLABLE', `A ${po.status} purchase order cannot be billed`);
      }
      if (poLineIds.length !== body.lines.length) {
        throw unprocessable(
          'PO_LINE_REQUIRED',
          'Every line of a PO bill names its purchase order line',
        );
      }
      const rows = await tx
        .select()
        .from(purchaseOrderLines)
        .where(
          s.where(
            purchaseOrderLines,
            and(
              eq(purchaseOrderLines.purchaseOrderId, po.id),
              inArray(purchaseOrderLines.id, poLineIds),
            ),
          ),
        );
      for (const row of rows) poLines.set(row.id, row);
      if (poLineIds.some((id) => !poLines.has(id))) {
        throw unprocessable(
          'PO_LINE_NOT_FOUND',
          'A line names a line that is not on the purchase order',
        );
      }
    }
    const receiptLineIds = body.lines.flatMap((l) =>
      l.receiptLineId === undefined ? [] : [l.receiptLineId],
    );
    if (receiptLineIds.length > 0) {
      const rows = await tx
        .select({ id: receiptLines.id, poLineId: receiptLines.poLineId })
        .from(receiptLines)
        .where(s.where(receiptLines, inArray(receiptLines.id, receiptLineIds)));
      const byId = new Map(rows.map((r) => [r.id, r.poLineId]));
      if (
        body.lines.some(
          (l) => l.receiptLineId !== undefined && byId.get(l.receiptLineId) !== l.poLineId,
        )
      ) {
        throw unprocessable(
          'RECEIPT_LINE_NOT_FOUND',
          'A receipt line is not a receipt of its PO line',
        );
      }
    }
    const rates = await this.taxRates(tx, scope, [...new Set(body.lines.map((l) => l.taxCodeId))]);
    const tdsCodeIds = [...new Set(body.lines.flatMap((l) => (l.tdsCodeId ? [l.tdsCodeId] : [])))];
    if (tdsCodeIds.length > 0) {
      const rows = await tx
        .select({ id: withholdingCodes.id })
        .from(withholdingCodes)
        .where(
          and(
            eq(withholdingCodes.tenantId, scope.tenantId),
            inArray(withholdingCodes.id, tdsCodeIds),
            inArray(withholdingCodes.appliesTo, ['payable', 'both']),
          ),
        );
      if (rows.length !== tdsCodeIds.length) {
        throw unprocessable(
          'WITHHOLDING_CODE_NOT_FOUND',
          'A withholding code is not a payable code',
        );
      }
    }

    const amounts = body.lines.map((l) =>
      lineAmounts(l.quantity, l.unitPrice, rates.get(l.taxCodeId) ?? 0),
    );
    const totals = billTotals(amounts);
    // Last check before the first write: 422 EXPENSE_ACCOUNT_INVALID unless every line books to an active expense
    // account of this entity. A refused bill writes no row, line or audit (bill numbers are issued at submit).
    await this.accounts.assertExpenseAccountsUsable(tx, scope, [
      ...new Set(body.lines.map((l) => l.accountId)),
    ]);
    const [bill] = await tx
      .insert(vendorBills)
      .values({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        kind: 'bill',
        vendorId: body.vendorPartyId,
        vendorInvoiceNo: body.vendorInvoiceNo,
        invoiceDate: body.invoiceDate,
        fiscalYear: fiscalYearOf(invoiceInstant(body.invoiceDate)),
        currency: body.currency,
        purchaseOrderId: body.purchaseOrderId ?? null,
        documentId: body.documentId,
        status: 'draft',
        matchStatus: body.purchaseOrderId === undefined ? 'not_required' : 'pending',
        netTotal: totals.net,
        vatTotal: totals.vat,
        tdsTotal: '0.00',
        payableTotal: totals.gross,
        fxRate: '1',
        payableTotalNpr: totals.gross,
        enteredBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (bill === undefined) throw new Error('bill insert returned no row');
    await tx.insert(vendorBillLines).values(
      body.lines.map((l, i) => ({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        vendorBillId: bill.id,
        purchaseOrderId: l.poLineId === undefined ? null : bill.purchaseOrderId,
        poLineId: l.poLineId ?? null,
        receiptLineId: l.receiptLineId ?? null,
        lineNo: i + 1,
        description:
          (l.poLineId === undefined ? undefined : poLines.get(l.poLineId)?.description) ??
          `Bill line ${i + 1}`,
        accountId: l.accountId,
        costCenterId: l.costCenterId ?? null,
        projectId: l.projectId ?? null,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        netAmount: amounts[i]!.net,
        taxCodeId: l.taxCodeId,
        vatAmount: amounts[i]!.vat,
        withholdingCodeId: l.tdsCodeId ?? null,
        tdsAmount: '0.00',
        createdAt: now,
        updatedAt: now,
      })),
    );
    await this.audit.record(tx, {
      action: 'payables.bill.entered',
      entityType: BILL_AUDIT_ENTITY,
      entityId: bill.id,
      after: {
        vendorPartyId: bill.vendorId,
        vendorInvoiceNo: bill.vendorInvoiceNo,
        purchaseOrderId: bill.purchaseOrderId,
        netTotal: bill.netTotal,
        vatTotal: bill.vatTotal,
      },
    });
    return bill;
  }

  // ------------------------------------------------------------------------------------------------- match

  /** Runs the match again (after a receipt or a correction). 409 for a bill without a PO or past matching. */
  async match(id: string, idempotencyKey: string): Promise<VendorBillDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    const tolerance = await this.tolerance(scope);
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'payables.bill.match', key: idempotencyKey, body: { id } },
        async () => {
          const bill = await this.lockEnterable(tx, scope, principal, id);
          assertInvoiceDateByToday(bill.invoiceDate, now);
          await this.runMatch(tx, scope, id, principal.userId, tolerance, now);
          return { status: 200, response: await this.dto(tx, scope, id) };
        },
      );
      return done.response;
    });
  }

  /**
   * One match run: every line through evaluateLine (AD6) with the tolerances from settings, one match_results row
   * per line under the next run number, then the bill moves to matching (all within) or variance.
   */
  private async runMatch(
    tx: DbTransaction,
    scope: TxScope,
    billId: string,
    userId: string,
    tolerance: MatchTolerance,
    now: Date,
  ): Promise<void> {
    const bill = await this.lockBill(tx, scope, billId);
    if (bill.purchaseOrderId === null) {
      throw conflict('MATCH_NOT_REQUIRED', 'A bill without a purchase order is not matched');
    }
    const lines = await this.linesOf(tx, scope, bill.id);
    const poLineIds = [...new Set(lines.flatMap((l) => (l.poLineId ? [l.poLineId] : [])))];
    const s = scoped(scope);
    // Lock the PO lines (ascending id, after the bill) before reading their progress, so a second bill against the
    // same lines waits here and then reads the first bill's quantity in a fresh statement (READ COMMITTED). NO KEY
    // UPDATE, not UPDATE: each bill's line insert holds FOR KEY SHARE on these rows (vendor_bill_lines_po_line_fk),
    // and FOR UPDATE would deadlock two bills that both inserted lines; NO KEY UPDATE still excludes NO KEY UPDATE.
    const poLines = new Map(
      (
        await tx
          .select()
          .from(purchaseOrderLines)
          .where(s.where(purchaseOrderLines, inArray(purchaseOrderLines.id, poLineIds)))
          .orderBy(asc(purchaseOrderLines.id))
          .for('no key update')
      ).map((r) => [r.id, r]),
    );
    const progress = new Map(
      (
        await tx
          .select()
          .from(poLineProgress)
          .where(
            and(
              eq(poLineProgress.tenantId, scope.tenantId),
              eq(poLineProgress.organizationId, scope.organizationId),
              inArray(poLineProgress.poLineId, poLineIds),
            ),
          )
      ).map((r) => [r.poLineId, r]),
    );
    const rates = await this.taxRates(tx, scope, [
      ...new Set([...poLines.values()].map((l) => l.taxCodeId)),
    ]);
    const [last] = await tx
      .select({ runNo: max(matchResults.runNo) })
      .from(matchResults)
      .where(s.where(matchResults, eq(matchResults.vendorBillId, bill.id)));
    const runNo = (last?.runNo ?? 0) + 1;
    const pricePct = parseDecimal(tolerance.pricePct);

    let allWithin = true;
    const rows = lines.map((line) => {
      const poLine = line.poLineId ? poLines.get(line.poLineId) : undefined;
      const prog = line.poLineId ? progress.get(line.poLineId) : undefined;
      if (poLine === undefined || prog === undefined) {
        throw new Error(`bill line ${line.id} has no PO line to match against`);
      }
      const result = matchLine(
        {
          billedQty: line.quantity,
          billPrice: line.unitPrice,
          billNet: line.netAmount,
          billVat: line.vatAmount,
          orderedQty: prog.orderedQuantity,
          receivedQty: prog.receivedQuantity,
          billedOnLine: prog.billedQuantity,
          billedByThisBill: lines
            .filter((l) => l.poLineId === line.poLineId)
            .reduce((acc, l) => acc.plus(l.quantity), new Decimal(0))
            .toFixed(),
          poPrice: poLine.unitPrice,
          poRateBp: rates.get(poLine.taxCodeId) ?? 0,
        },
        tolerance,
      );
      allWithin = allWithin && result.withinTolerance;
      return {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        vendorBillId: bill.id,
        vendorBillLineId: line.id,
        poLineId: line.poLineId,
        runNo,
        status: result.withinTolerance ? ('matched' as const) : ('variance' as const),
        orderedQuantity: prog.orderedQuantity,
        receivedQuantity: prog.receivedQuantity,
        billedQuantity: line.quantity,
        quantityVariance: result.qtyVariance.toFixed(4),
        priceVariance: result.priceVariance.toFixed(2),
        taxVariance: result.taxVariance.toFixed(2),
        withinTolerance: result.withinTolerance,
        priceToleranceBp: pricePct.times(100).round().toNumber(),
        priceToleranceAmount: parseDecimal(tolerance.priceNpr).toFixed(2),
        matchedBy: userId,
        createdAt: now,
      };
    });
    const next = afterMatch(bill.status, allWithin);
    if (next === undefined) {
      throw conflict('invalid_transition', `A ${bill.status} bill cannot be matched`);
    }
    await tx.insert(matchResults).values(rows);
    await tx
      .update(vendorBills)
      .set({
        status: next.status,
        matchStatus: next.matchStatus,
        version: sql`${vendorBills.version} + 1`,
        updatedAt: now,
      })
      .where(
        s.where(vendorBills, and(eq(vendorBills.id, bill.id), eq(vendorBills.status, bill.status))),
      );
    await this.audit.record(tx, {
      action: 'payables.bill.matched',
      entityType: BILL_AUDIT_ENTITY,
      entityId: bill.id,
      before: { status: bill.status, matchStatus: bill.matchStatus },
      after: { ...next, runNo },
    });
  }

  // ------------------------------------------------------------------------------------------------- exceptions

  /**
   * Asks Finance to accept a bill outside tolerance (AD5: route `match_exception`, the requester in
   * sod_user_ids). 201. 409 unless the bill is in variance; 422 when nobody may decide. The evidence, when given,
   * must be a file uploaded as this bill's evidence: 422 `invalid_evidence_document`, 409 `document_infected`.
   */
  async requestException(
    id: string,
    body: RequestMatchExceptionBody,
    idempotencyKey: string,
  ): Promise<MatchExceptionDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency(
          tx,
          { command: 'payables.bill.exception', key: idempotencyKey, body: { id, ...body } },
          async () => {
            const bill = await this.lockEnterable(tx, scope, principal, id);
            if (bill.status !== 'variance') {
              throw conflict(
                'invalid_transition',
                `A match exception needs a bill in variance, not ${bill.status}`,
              );
            }
            if (body.evidenceDocumentId !== undefined) {
              // Round 5 P2: only evidence uploaded to this bill (owner type `evidence`), live, of this entity; never
              // the invoice file, a picture or a file of another record (422 invalid_evidence_document).
              await assertEvidenceDocument(tx, scope, body.evidenceDocumentId, bill.id);
            }
            const exceptionId = randomUUID();
            await tx.insert(matchExceptions).values({
              id: exceptionId,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              vendorBillId: bill.id,
              reason: body.reason,
              evidenceDocumentId: body.evidenceDocumentId ?? null,
              requestedBy: principal.userId,
              createdAt: now,
              updatedAt: now,
            });
            const request = await this.approvals.submit(tx, {
              documentType: MATCH_EXCEPTION_DOCUMENT_TYPE,
              documentId: exceptionId,
              title: `Match exception for invoice ${bill.vendorInvoiceNo}`,
              snapshot: {
                vendorBillId: bill.id,
                vendorInvoiceNo: bill.vendorInvoiceNo,
                reason: body.reason,
                results: await this.latestResults(tx, scope, bill.id),
              },
              facts: { amountNpr: bill.payableTotalNpr },
              requesterUserId: principal.userId,
              sodUserIds: [principal.userId],
            });
            if (request.status === 'blocked') throw new NoEligibleApprover('No eligible approver');
            const [exception] = await tx
              .update(matchExceptions)
              .set({ approvalRequestId: request.requestId })
              .where(scoped(scope).where(matchExceptions, eq(matchExceptions.id, exceptionId)))
              .returning();
            await tx
              .update(vendorBills)
              .set({
                status: 'exception_pending',
                version: sql`${vendorBills.version} + 1`,
                updatedAt: now,
              })
              .where(scoped(scope).where(vendorBills, eq(vendorBills.id, bill.id)));
            await this.audit.record(tx, {
              action: 'payables.match_exception.requested',
              entityType: MATCH_EXCEPTION_AUDIT_ENTITY,
              entityId: exceptionId,
              after: { vendorBillId: bill.id, approvalRequestId: request.requestId },
            });
            return { status: 201, response: toExceptionDto(exception!) };
          },
        );
        return done.response;
      });
    } catch (error) {
      if (!(error instanceof NoEligibleApprover)) throw error;
      throw unprocessable(
        'NO_ELIGIBLE_APPROVER',
        `This exception cannot be requested: ${error.reason}`,
      );
    }
  }

  // ------------------------------------------------------------------------------------------------- submit

  /**
   * Sends the bill to the `vendor_bill` route (AD5). 200 with the bill in pending_approval. 409 (BILL_NOT_MATCHED)
   * unless every line matched or a match exception was approved, and BILL_DOCUMENT_NOT_CLEAN unless the newest
   * invoice version is clean; 422 when the invoice file is missing or removed, or nobody may approve.
   */
  async submit(id: string, idempotencyKey: string): Promise<VendorBillDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    const thresholds = {
      managementNpr: await this.settings.get(scope, 'procurement.band.management_npr'),
      founderNpr: await this.settings.get(scope, 'procurement.band.founder_npr'),
    };
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency(
          tx,
          { command: 'payables.bill.submit', key: idempotencyKey, body: { id } },
          async () => {
            const bill = await this.lockEnterable(tx, scope, principal, id);
            if (!submittable(bill.status, bill.matchStatus)) {
              throw conflict(
                'BILL_NOT_MATCHED',
                `A ${bill.status} bill (match ${bill.matchStatus}) cannot be submitted: every line must match or a match exception must be approved`,
              );
            }
            // A draft saved before the date rule, or edited outside the API, can carry a later date.
            assertInvoiceDateByToday(bill.invoiceDate, now);
            await this.assertInvoiceClean(tx, scope, bill.documentId);
            const facts = billFactsOf({
              poMatched: bill.purchaseOrderId !== null,
              gross: sum([bill.netTotal, bill.vatTotal]),
              fxRate: bill.fxRate,
              thresholds,
            });
            // Take the series lock after the bill/document checks. A replay or returned bill keeps its
            // number; a blocked approval rolls back this increment with the rest of the submission.
            const number = bill.number ?? (await this.numbering.issue(tx, 'BILL', now)).number;
            const request = await this.approvals.submit(tx, {
              documentType: VENDOR_BILL_DOCUMENT_TYPE,
              documentId: bill.id,
              documentNumber: number,
              title: `Vendor bill ${bill.vendorInvoiceNo}`,
              snapshot: {
                number,
                vendorPartyId: bill.vendorId,
                vendorInvoiceNo: bill.vendorInvoiceNo,
                purchaseOrderId: bill.purchaseOrderId,
                matchStatus: bill.matchStatus,
                netTotal: bill.netTotal,
                vatTotal: bill.vatTotal,
              },
              facts,
              requesterUserId: bill.enteredBy,
              submittedByUserId: principal.userId,
              sodUserIds: [bill.enteredBy],
            });
            if (request.status === 'blocked') throw new NoEligibleApprover('No eligible approver');
            await tx
              .update(vendorBills)
              .set({
                status: 'pending_approval',
                number,
                approvalRequestId: request.requestId,
                version: sql`${vendorBills.version} + 1`,
                updatedAt: now,
              })
              .where(
                scoped(scope).where(
                  vendorBills,
                  and(eq(vendorBills.id, bill.id), eq(vendorBills.status, bill.status)),
                ),
              );
            await this.audit.record(tx, {
              action: 'payables.bill.submitted',
              entityType: BILL_AUDIT_ENTITY,
              entityId: bill.id,
              before: { status: bill.status, number: bill.number },
              after: {
                status: 'pending_approval',
                number,
                approvalRequestId: request.requestId,
                ...facts,
              },
            });
            return { status: 200, response: await this.dto(tx, scope, bill.id) };
          },
        );
        return done.response;
      });
    } catch (error) {
      if (!(error instanceof NoEligibleApprover)) throw error;
      throw unprocessable('NO_ELIGIBLE_APPROVER', `This bill cannot be submitted: ${error.reason}`);
    }
  }

  /** Retains a discarded draft and its references, releasing the active invoice-number key. */
  async discard(id: string, idempotencyKey: string): Promise<VendorBillDto> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'payables.bill.discard', key: idempotencyKey, body: { id } },
        async () => {
          const bill = await this.lockEnterable(tx, scope, principal, id);
          if (bill.status === 'discarded') {
            return { status: 200, response: await this.dto(tx, scope, id) };
          }
          if (bill.status !== 'draft') {
            throw conflict(
              'invalid_transition',
              `A ${bill.status} bill cannot be discarded; only a draft can`,
            );
          }
          await tx
            .update(vendorBills)
            .set({
              status: 'discarded',
              version: sql`${vendorBills.version} + 1`,
              updatedAt: this.clock(),
            })
            .where(
              scoped(scope).where(
                vendorBills,
                and(eq(vendorBills.id, id), eq(vendorBills.status, 'draft')),
              ),
            );
          // Conversion locks the submission before creating a bill. Lock its source row too before
          // returning it to the inbox; a discarded bill retry must never reopen a newer conversion.
          const sources = await tx
            .select()
            .from(vendorBillSubmissions)
            .where(
              scoped(scope).where(
                vendorBillSubmissions,
                and(
                  eq(vendorBillSubmissions.convertedBillId, id),
                  eq(vendorBillSubmissions.status, 'converted'),
                ),
              ),
            )
            .for('update');
          for (const source of sources) {
            await tx
              .update(vendorBillSubmissions)
              .set({
                status: 'received',
                convertedBillId: null,
                reviewedBy: null,
                reviewedAt: null,
                version: sql`${vendorBillSubmissions.version} + 1`,
                updatedAt: this.clock(),
              })
              .where(
                scoped(scope).where(vendorBillSubmissions, eq(vendorBillSubmissions.id, source.id)),
              );
            await this.audit.record(tx, {
              action: 'payables.bill_submission.reopened',
              entityType: 'vendor_bill_submissions',
              entityId: source.id,
              before: { status: 'converted', convertedBillId: id },
              after: { status: 'received', convertedBillId: null },
            });
          }
          await this.audit.record(tx, {
            action: 'payables.bill.discarded',
            entityType: BILL_AUDIT_ENTITY,
            entityId: id,
            before: { status: 'draft' },
            after: { status: 'discarded', vendorInvoiceNo: bill.vendorInvoiceNo },
          });
          return { status: 200, response: await this.dto(tx, scope, id) };
        },
      );
      return done.response;
    });
  }

  // ------------------------------------------------------------------------------------------------- void

  /**
   * Voids an approved bill that nothing has been allocated against yet: opens a vendor_debit_note payable debit
   * for the full amount (source = the bill), allocates it against the bill's credit item, records
   * `vendor_debit_note_issued` and marks the bill voided. 200 with the bill. 404 outside the acting entity; 409
   * invalid_transition unless the bill is approved (a second void included), BILL_NOT_POSTED when the bill has no
   * credit item, BILL_HAS_ALLOCATIONS when part of it is already paid or settled, BILL_HAS_PAYMENT_REQUEST when a
   * payment request waiting for approval or approved has a line on it.
   */
  async void(id: string, body: VoidVendorBillBody, idempotencyKey: string): Promise<VendorBillDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'payables.bill.void', key: idempotencyKey, body: { id, ...body } },
        async () => {
          const bill = await this.lockEnterable(tx, scope, principal, id);
          if (bill.status !== 'approved') {
            throw conflict('invalid_transition', `A ${bill.status} bill cannot be voided`);
          }
          const [credit] = await tx
            .select({ id: openItems.id })
            .from(openItems)
            .where(
              scoped(scope).where(
                openItems,
                and(eq(openItems.sourceType, 'vendor_bill'), eq(openItems.sourceId, bill.id)),
              ),
            );
          if (credit === undefined) {
            throw conflict('BILL_NOT_POSTED', 'This bill has no payable item to void yet');
          }
          // Lock the credit item before reading its open amount, so no allocation lands between the check and ours.
          await this.ledger.lockForMoneyCommand(tx, scope, [
            { rank: 'open_item', ids: [credit.id] },
          ]);
          const open = (await this.ledger.openAmounts(tx, scope, [credit.id])).get(credit.id);
          if (open === undefined) {
            throw conflict('BILL_NOT_POSTED', 'This bill has no payable item to void yet');
          }
          if (!new Decimal(open).eq(bill.payableTotal)) {
            throw conflict(
              'BILL_HAS_ALLOCATIONS',
              'Part of this bill is already paid or settled, so it cannot be voided',
            );
          }
          // A request waiting for approval or approved holds a claim on the item; voiding would strand it. No row
          // lock is taken here (so no new lock order against payment-requests submit: request, vendor, open items):
          // submit moves a draft to pending_approval only while holding this item FOR UPDATE, which we hold now, so
          // this READ COMMITTED read sees every request that submitted first, and one that submits later fails its
          // own balance check on the voided item.
          const [claim] = await tx
            .select({ id: paymentRequests.id })
            .from(paymentRequestLines)
            .innerJoin(
              paymentRequests,
              and(
                eq(paymentRequests.tenantId, paymentRequestLines.tenantId),
                eq(paymentRequests.organizationId, paymentRequestLines.organizationId),
                eq(paymentRequests.id, paymentRequestLines.paymentRequestId),
              ),
            )
            .where(
              scoped(scope).where(
                paymentRequestLines,
                and(
                  eq(paymentRequestLines.openItemId, credit.id),
                  inArray(paymentRequests.status, [...CLAIMING_REQUEST_STATUSES]),
                ),
              ),
            )
            .limit(1);
          if (claim !== undefined) {
            throw conflict(
              'BILL_HAS_PAYMENT_REQUEST',
              'A payment request waiting for approval or already approved is on this bill, so it cannot be voided',
            );
          }
          const { item: debit } = await this.ledger.openItem(tx, scope, actor, {
            side: 'payable',
            direction: 'debit',
            partyId: bill.vendorId,
            sourceType: 'vendor_debit_note',
            sourceId: bill.id,
            currency: bill.currency,
            amount: bill.payableTotal,
            amountNpr: bill.payableTotalNpr,
            fxRate: bill.fxRate,
            fxSource: bill.fxSource,
            fxDate: bill.fxDate,
            documentDate: isoDateOf(now),
          });
          const allocation = await this.ledger.allocate(tx, scope, actor, {
            debitItemId: debit.id,
            creditItemId: credit.id,
            amount: bill.payableTotal,
          });
          await this.ledger.recordEvent(tx, scope, actor, {
            sourceType: 'vendor_debit_note',
            sourceId: bill.id,
            event: 'vendor_debit_note_issued',
            payload: {
              vendorBillId: bill.id,
              debitItemId: debit.id,
              creditItemId: credit.id,
              allocationId: allocation.id,
              amount: bill.payableTotal,
              currency: bill.currency,
              reason: body.reason,
            },
          });
          await tx
            .update(vendorBills)
            .set({
              status: 'voided',
              voidedBy: principal.userId,
              voidedAt: now,
              voidReason: body.reason,
              version: sql`${vendorBills.version} + 1`,
              updatedAt: now,
            })
            .where(
              scoped(scope).where(
                vendorBills,
                and(eq(vendorBills.id, bill.id), eq(vendorBills.status, 'approved')),
              ),
            );
          await this.audit.record(tx, {
            action: 'payables.bill.voided',
            entityType: BILL_AUDIT_ENTITY,
            entityId: bill.id,
            before: { status: bill.status },
            after: { status: 'voided', reason: body.reason, debitItemId: debit.id },
          });
          return { status: 200, response: await this.dto(tx, scope, bill.id) };
        },
      );
      return done.response;
    });
  }

  // ------------------------------------------------------------------------------------------------- VAT register

  /**
   * The purchase VAT register of the acting entity for invoice dates from `from` to `to` (inclusive): one row per
   * approved, partially paid or paid bill, oldest first, with the net and VAT of its creditable lines. The total
   * is the creditable VAT claimed for the period (check 17).
   */
  async vatRegister(from: string, to: string): Promise<VatRegisterDto> {
    const { scope, actor } = this.caller.current();
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const bills = await tx
          .select({
            id: vendorBills.id,
            kind: vendorBills.kind,
            number: vendorBills.number,
            vendorId: vendorBills.vendorId,
            vendorInvoiceNo: vendorBills.vendorInvoiceNo,
            invoiceDate: vendorBills.invoiceDate,
            vendorName: vendors.legalName,
            vendorPan: vendors.pan,
          })
          .from(vendorBills)
          .innerJoin(
            vendors,
            and(eq(vendors.tenantId, vendorBills.tenantId), eq(vendors.id, vendorBills.vendorId)),
          )
          .where(
            scoped(scope).where(
              vendorBills,
              and(
                inArray(vendorBills.status, [...VAT_REGISTER_STATUSES]),
                between(vendorBills.invoiceDate, from, to),
              ),
            ),
          )
          .orderBy(
            asc(vendorBills.invoiceDate),
            asc(vendorBills.vendorInvoiceNo),
            asc(vendorBills.id),
          );
        const lines =
          bills.length === 0
            ? []
            : await tx
                .select({
                  billId: vendorBillLines.vendorBillId,
                  net: vendorBillLines.netAmount,
                  vat: vendorBillLines.vatAmount,
                })
                .from(vendorBillLines)
                .innerJoin(
                  taxCodes,
                  and(
                    eq(taxCodes.tenantId, vendorBillLines.tenantId),
                    eq(taxCodes.id, vendorBillLines.taxCodeId),
                  ),
                )
                .where(
                  scoped(scope).where(
                    vendorBillLines,
                    and(
                      inArray(
                        vendorBillLines.vendorBillId,
                        bills.map((b) => b.id),
                      ),
                      eq(taxCodes.creditable, true),
                    ),
                  ),
                );
        const byBill = new Map<string, { net: Decimal; vat: Decimal }>();
        for (const l of lines) {
          const acc = byBill.get(l.billId) ?? { net: new Decimal(0), vat: new Decimal(0) };
          byBill.set(l.billId, { net: acc.net.plus(l.net), vat: acc.vat.plus(l.vat) });
        }
        let totalNet = new Decimal(0);
        let totalVat = new Decimal(0);
        const rows = bills.map((b): VatRegisterRowDto => {
          const sign = b.kind === 'vendor_credit_note' ? -1 : 1;
          const sums = byBill.get(b.id) ?? { net: new Decimal(0), vat: new Decimal(0) };
          const net = sums.net.times(sign);
          const vat = sums.vat.times(sign);
          totalNet = totalNet.plus(net);
          totalVat = totalVat.plus(vat);
          return {
            vendorBillId: b.id,
            billNumber: b.number,
            vendorPartyId: b.vendorId,
            vendorName: b.vendorName,
            vendorPan: b.vendorPan,
            vendorInvoiceNo: b.vendorInvoiceNo,
            invoiceDate: b.invoiceDate,
            invoiceDateBs: formatBs(invoiceInstant(b.invoiceDate), 'YYYY-MM-DD'),
            taxableAmount: net.toFixed(2),
            vatAmount: vat.toFixed(2),
          };
        });
        return {
          from,
          to,
          rows,
          total: { taxableAmount: totalNet.toFixed(2), vatAmount: totalVat.toFixed(2) },
        };
      },
      READ_ONLY,
    );
  }

  // ------------------------------------------------------------------------------------------------- helpers

  private async assertInvoiceClean(
    tx: DbTransaction,
    scope: TxScope,
    documentId: string,
  ): Promise<void> {
    const [document] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        scoped(scope).where(
          documents,
          and(eq(documents.id, documentId), isNull(documents.removedAt)),
        ),
      )
      .for('share');
    if (document === undefined) {
      throw unprocessable('DOCUMENT_NOT_FOUND', 'The invoice file was not found');
    }
    const latest = await newestDocumentVersion(tx, scope, documentId);
    if (latest?.status !== 'clean') {
      throw conflict('BILL_DOCUMENT_NOT_CLEAN', 'The invoice file has not scanned clean');
    }
  }

  private async tolerance(scope: TxScope): Promise<MatchTolerance> {
    return {
      qtyPct: await this.settings.get(scope, 'procurement.match.qty_pct'),
      pricePct: await this.settings.get(scope, 'procurement.match.price_pct'),
      priceNpr: await this.settings.get(scope, 'procurement.match.price_npr'),
    };
  }

  private async taxRates(
    tx: DbTransaction,
    scope: TxScope,
    ids: readonly string[],
  ): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ id: taxCodes.id, rateBp: taxCodes.rateBp })
      .from(taxCodes)
      .where(and(eq(taxCodes.tenantId, scope.tenantId), inArray(taxCodes.id, [...ids])));
    if (rows.length !== ids.length) {
      throw unprocessable('TAX_CODE_NOT_FOUND', 'A tax code was not found');
    }
    return new Map(rows.map((r) => [r.id, r.rateBp]));
  }

  /**
   * The bill a command acts on, locked: 404 unless the caller may read it (the answer GET gives), then 403 unless
   * their `payables.bill.enter` reaches it. Only the public commands call this; the match run and the answer they
   * build read the bill without a scope, so a bill the caller just entered is never hidden from them.
   */
  private async lockEnterable(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    id: string,
  ): Promise<BillRow> {
    const bill = await this.lockBill(tx, scope, id);
    const ref = billRef(bill);
    // Bills have no creator or assignee reach, so this record check and scopeWhereFor() read the same column.
    if (!can(principal, 'payables.bill.read', ref).allowed) throw notFound('Bill');
    const decision = can(principal, 'payables.bill.enter', ref);
    if (!decision.allowed) throw forbidden(decision.reason);
    return bill;
  }

  private async lockBill(tx: DbTransaction, scope: TxScope, id: string): Promise<BillRow> {
    const [bill] = await tx
      .select()
      .from(vendorBills)
      .where(scoped(scope).where(vendorBills, eq(vendorBills.id, id)))
      .for('update');
    if (bill === undefined) throw notFound('Bill');
    return bill;
  }

  private linesOf(tx: DbTransaction, scope: TxScope, billId: string): Promise<BillLineRow[]> {
    return tx
      .select()
      .from(vendorBillLines)
      .where(scoped(scope).where(vendorBillLines, eq(vendorBillLines.vendorBillId, billId)))
      .orderBy(asc(vendorBillLines.lineNo));
  }

  private async latestResults(
    tx: DbTransaction,
    scope: TxScope,
    billId: string,
  ): Promise<MatchResultRow[]> {
    const rows = await tx
      .select()
      .from(matchResults)
      .where(scoped(scope).where(matchResults, eq(matchResults.vendorBillId, billId)))
      .orderBy(desc(matchResults.runNo));
    const latest = rows[0]?.runNo;
    return rows.filter((r) => r.runNo === latest);
  }

  private async dto(tx: DbTransaction, scope: TxScope, id: string): Promise<VendorBillDto> {
    const [bill] = await tx
      .select({
        bill: vendorBills,
        vendorName: vendors.legalName,
        purchaseOrderNumber: purchaseOrders.number,
      })
      .from(vendorBills)
      .innerJoin(
        vendors,
        and(eq(vendors.tenantId, vendorBills.tenantId), eq(vendors.id, vendorBills.vendorId)),
      )
      .leftJoin(purchaseOrders, poOfBill())
      .where(scoped(scope).where(vendorBills, eq(vendorBills.id, id)));
    if (bill === undefined) throw notFound('Bill');
    return {
      ...toDto(
        bill.bill,
        bill.vendorName,
        bill.purchaseOrderNumber,
        await this.linesOf(tx, scope, id),
        await this.latestResults(tx, scope, id),
      ),
      fileStatus: (await newestDocumentVersion(tx, scope, bill.bill.documentId))?.status ?? null,
    };
  }
}

/** The Kathmandu calendar date of an instant, YYYY-MM-DD. */
function isoDateOf(instant: Date): string {
  const { y, m, d } = kathmanduDate(instant);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A bill's PO in the bill's own tenant and entity: another entity's order never joins. */
const poOfBill = () =>
  and(
    eq(purchaseOrders.tenantId, vendorBills.tenantId),
    eq(purchaseOrders.organizationId, vendorBills.organizationId),
    eq(purchaseOrders.id, vendorBills.purchaseOrderId),
  );

function toDto(
  bill: BillRow,
  vendorName: string,
  purchaseOrderNumber: string | null,
  lines: BillLineRow[],
  results: MatchResultRow[],
): VendorBillDto {
  const byLine = new Map(results.map((r) => [r.vendorBillLineId, r]));
  return {
    id: bill.id,
    kind: bill.kind,
    number: bill.number,
    vendorPartyId: bill.vendorId,
    vendorName,
    vendorInvoiceNo: bill.vendorInvoiceNo,
    invoiceDate: bill.invoiceDate,
    fiscalYear: bill.fiscalYear,
    currency: bill.currency,
    purchaseOrderId: bill.purchaseOrderId,
    purchaseOrderNumber,
    documentId: bill.documentId,
    status: bill.status,
    matchStatus: bill.matchStatus,
    netTotal: bill.netTotal,
    vatTotal: bill.vatTotal,
    tdsTotal: bill.tdsTotal,
    payableTotal: bill.payableTotal,
    enteredBy: bill.enteredBy,
    approvalRequestId: bill.approvalRequestId,
    version: bill.version,
    lines: lines.map((l) => {
      const r = byLine.get(l.id);
      return {
        id: l.id,
        lineNo: l.lineNo,
        poLineId: l.poLineId,
        receiptLineId: l.receiptLineId,
        description: l.description,
        accountId: l.accountId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        netAmount: l.netAmount,
        taxCodeId: l.taxCodeId,
        vatAmount: l.vatAmount,
        tdsCodeId: l.withholdingCodeId,
        tdsAmount: l.tdsAmount,
        match:
          r === undefined
            ? null
            : {
                runNo: r.runNo,
                status: r.status,
                receivedQuantity: r.receivedQuantity,
                billedQuantity: r.billedQuantity,
                quantityVariance: r.quantityVariance,
                priceVariance: r.priceVariance,
                taxVariance: r.taxVariance,
              },
      };
    }),
  };
}

function toExceptionDto(row: ExceptionRow): MatchExceptionDto {
  return {
    id: row.id,
    vendorBillId: row.vendorBillId,
    reason: row.reason,
    status: row.status,
    requestedBy: row.requestedBy,
    decidedBy: row.decidedBy,
    approvalRequestId: row.approvalRequestId,
  };
}
