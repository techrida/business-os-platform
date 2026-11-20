// Invoice approval (P3 unit U6, plan A5): a draft or returned tax invoice, credit note or debit note goes to its
// document type's route (Accountant -> Finance; a tax invoice from an approved billing schedule, Finance only: F1-Q30),
// and the decision moves it to approved or returned. Serves the NFRs:
// - "nothing is auto-issued": a route with no eligible approver refuses the submit (422 NO_ELIGIBLE_APPROVER; nothing
//   is written but the admins' notice), and an empty route counts as blocked (router.ts refuses zero steps);
// - "separation of duties": the drafter and the submitter are SoD users, so neither can approve their own invoice;
// - "what was approved is what was seen": submit stores a hash of the material fields in content_hash; onDecided
//   recomputes it and approves only when it is unchanged (else the invoice is returned). Issue overwrites content_hash
//   with the issued-document hash;
// - "no double effects": the submit runs inside withIdempotency.
// The request carries no number (the invoice is numbered only at issue), so the engine shows `Draft <type> <id8>`.
import {
  isInvoiceEditable,
  type ApprovalContext,
  type InvoiceDetail,
  type ReopenInvoiceBody,
  type SubmitInvoiceBody,
} from '@bos/contracts';
import { customers, invoiceLines, invoices, invoiceTaxSummary, scoped } from '@bos/db';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, scopeWhereFor } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { readTxContext } from '../../platform/documents/tx-context';
import { canonicalSha256 } from '../../platform/hashing/canonical-json';
import { MoneyService } from '../../platform/settings/money.service';
import { fact, hrefIfVisible } from '../approvals/context';
import { ApprovalsNotify } from '../approvals/ports';
import { ApprovalsService, type ApprovalSubject } from '../approvals/requests.service';
import { InvoiceDraftingService } from './invoice-drafting.service';
import {
  assertStaff,
  conflict,
  INVOICE_CLOCK,
  InvoiceCaller,
  invoiceNotFound,
} from './invoice-support';

type InvoiceRow = typeof invoices.$inferSelect;
type ApprovableKind = 'tax_invoice' | 'credit_note' | 'debit_note';

/** approval_requests.document_type of each approvable kind (the seed publishes one workflow per type). */
export const INVOICE_APPROVAL_DOCUMENT_TYPES: readonly ApprovableKind[] = [
  'tax_invoice',
  'credit_note',
  'debit_note',
];

/** approval.blocked links may only open the inbox or memos (notify/templates.ts). */
const BLOCKED_NOTICE_LINK = '/inbox/';

const draftReference = (kind: string, id: string) => `Draft ${kind} ${id.slice(0, 8)}`;
const KIND_LABEL: Record<ApprovableKind, string> = {
  tax_invoice: 'Tax invoice',
  credit_note: 'Credit note',
  debit_note: 'Debit note',
};

interface BlockedNotice {
  kind: ApprovableKind;
  invoiceId: string;
  rowVersion: number;
  reason: string;
}

/** Thrown inside the submit transaction so it rolls back (idempotency claim included); never leaves the service. */
class NoEligibleApprover extends Error {
  constructor(readonly notice: BlockedNotice) {
    super('no eligible approver');
  }
}

/**
 * SHA-256 over what an approver decides on: kind, customer, source, reasons, due date, currency, totals, lines and tax
 * summary. No number, issue date or seller/buyer snapshot: those exist only at issue.
 */
export async function approvalContentHashOf(
  tx: DbTransaction,
  scope: TxScope,
  invoice: InvoiceRow,
): Promise<Buffer> {
  const child = (t: typeof invoiceLines | typeof invoiceTaxSummary) =>
    and(
      eq(t.tenantId, scope.tenantId),
      eq(t.organizationId, scope.organizationId),
      eq(t.invoiceId, invoice.id),
    );
  const lines = await tx
    .select()
    .from(invoiceLines)
    .where(child(invoiceLines))
    .orderBy(asc(invoiceLines.lineNo));
  const tax = await tx.select().from(invoiceTaxSummary).where(child(invoiceTaxSummary));
  return canonicalSha256({
    kind: invoice.kind,
    customerPartyId: invoice.customerPartyId,
    salesOrderId: invoice.salesOrderId,
    scheduleLineId: invoice.scheduleLineId,
    originalInvoiceId: invoice.originalInvoiceId,
    manualReason: invoice.manualReason,
    noteReason: invoice.noteReason,
    dueDate: invoice.dueDate,
    currency: invoice.currency,
    lines: lines.map((l) => [
      l.lineNo,
      l.description,
      l.uom,
      l.quantity,
      l.unitPrice,
      l.taxCodeId,
      l.gross,
      l.discountAlloc,
      l.taxable,
    ]),
    taxSummary: tax
      .map((t) => [t.taxCodeId, t.label, t.rate, t.base, t.tax])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    totals: [
      invoice.subtotal,
      invoice.discountAmount,
      invoice.taxableVatAmount,
      invoice.exemptAmount,
      invoice.zeroRatedAmount,
      invoice.taxAmount,
      invoice.total,
    ],
    calcVersion: invoice.calcVersion,
  });
}

/**
 * What a decided request does to its invoice, in the deciding transaction (ApprovalsService.act). One instance per
 * document type. `approved` stands only while the content hash still matches the one stored at submit; otherwise,
 * and for `returned` or `rejected` (an invoice has no rejected status), the invoice is returned for editing.
 */
export class InvoiceApprovalSubject implements ApprovalSubject {
  private readonly log = new Logger(InvoiceApprovalSubject.name);

  constructor(
    readonly documentType: ApprovableKind,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * The invoice as it stands now. Its PDF is drawn only at issue, so there is no file to list. The invoice page is
   * linked only when the reader's `invoice.read` scope reaches it, as the invoice routes decide.
   */
  async context(
    q: Db,
    scope: TxScope,
    request: { documentId: string },
    viewer: Principal,
  ): Promise<ApprovalContext | null> {
    const [row] = await q
      .select({
        id: invoices.id,
        number: invoices.number,
        customerName: customers.legalName,
        currency: invoices.currency,
        total: invoices.total,
        status: invoices.status,
      })
      .from(invoices)
      .leftJoin(
        customers,
        and(eq(customers.tenantId, invoices.tenantId), eq(customers.id, invoices.customerPartyId)),
      )
      .where(scoped(scope).where(invoices, eq(invoices.id, request.documentId)));
    if (row === undefined) return null;
    return {
      title: `${KIND_LABEL[this.documentType]} ${row.number ?? ''}`.trim(),
      fields: [
        ...fact.text('customer', 'Customer', row.customerName),
        ...fact.money('total', 'Total', row.total, row.currency),
        ...fact.status(row.status),
      ],
      documents: [],
      href: await hrefIfVisible(q, viewer, invoices, 'invoice.read', row.id, `/invoices/${row.id}`),
    };
  }

  async onDecided(
    tx: DbTransaction,
    invoiceId: string,
    outcome: 'approved' | 'returned' | 'rejected',
  ): Promise<void> {
    const { scope } = await readTxContext(tx);
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(scoped(scope).where(invoices, eq(invoices.id, invoiceId)))
      .for('update');
    // Throwing rolls the decision back: a decided request whose invoice is not submitted means the two disagree.
    if (invoice?.status !== 'submitted' || invoice.kind !== this.documentType) {
      this.log.error(
        `invoice ${invoiceId} is not a submitted ${this.documentType}; refusing ${outcome}`,
      );
      throw new ConflictException({
        code: 'conflict',
        message: 'The invoice is not waiting for a decision',
      });
    }
    let status: 'approved' | 'returned' = outcome === 'approved' ? 'approved' : 'returned';
    if (status === 'approved') {
      const actual = await approvalContentHashOf(tx, scope, invoice);
      const stored = invoice.contentHash;
      if (stored === null || !Buffer.from(stored).equals(actual)) {
        this.log.warn(
          `invoice ${invoiceId} changed after submit; returning it instead of approving`,
        );
        status = 'returned';
      }
    }
    const updated = await tx
      .update(invoices)
      .set({
        status,
        version: sql`${invoices.version} + 1`,
        updatedAt: this.clock(),
      })
      .where(
        scoped(scope).where(
          invoices,
          and(eq(invoices.id, invoiceId), eq(invoices.status, 'submitted')),
        ),
      )
      .returning({ id: invoices.id });
    if (updated.length === 0) {
      throw new ConflictException({
        code: 'conflict',
        message: 'The invoice is not waiting for a decision',
      });
    }
  }

  /** A cancel is the invoice module's own act (reopenForEdit), which sets the invoice's status itself. */
  onCancelled(_tx: DbTransaction, _invoiceId: string, _reason: string): Promise<void> {
    return Promise.resolve();
  }
}

@Injectable()
export class InvoiceApprovalService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly caller: InvoiceCaller,
    private readonly approvals: ApprovalsService,
    private readonly notify: ApprovalsNotify,
    private readonly money: MoneyService,
    private readonly drafting: InvoiceDraftingService,
    @Optional() @Inject(INVOICE_CLOCK) private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Submits a draft or returned invoice and returns its InvoiceDetail (status submitted). 404 outside the entity, 403
   * without `invoice.submit`, 409 for a proforma, another status or a stale `expectedVersion`, 409 fx_rate_stale for
   * an old rate, 422 NO_ELIGIBLE_APPROVER when a step has nobody who may decide it (nothing is submitted).
   */
  async submit(
    id: string,
    body: SubmitInvoiceBody,
    idempotencyKey: string,
  ): Promise<InvoiceDetail> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);
    this.authz.assert('invoice.submit', scope);
    const now = this.clock();
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        // The route check carries no owner, so a grant narrowed to own or department is judged here against the
        // drafter; an invoice outside the caller's read is a 404.
        const [owned] = await tx
          .select({ createdBy: invoices.createdBy })
          .from(invoices)
          .where(and(scopeWhereFor(principal, invoices, 'invoice.read'), eq(invoices.id, id)))
          .limit(1);
        if (owned === undefined) throw invoiceNotFound();
        this.authz.assert('invoice.submit', { ...scope, ownerUserId: owned.createdBy });
        const done = await withIdempotency(
          tx,
          { command: 'invoice.submit', key: idempotencyKey, body: { id, ...body } },
          async () => ({
            status: 200,
            response: await this.submitInTx(tx, scope, actor, principal.userId, id, body, now),
          }),
        );
        return done.response;
      });
    } catch (error) {
      if (!(error instanceof NoEligibleApprover)) throw error;
      // The submit rolled back; the notice gets a transaction of its own so it is kept.
      await withTx(this.db, scope, actor, (tx) =>
        this.notifyBlocked(tx, scope.tenantId, error.notice),
      );
      throw new UnprocessableEntityException({
        code: 'NO_ELIGIBLE_APPROVER',
        message: `This invoice cannot be submitted: ${error.notice.reason}. An administrator has been told.`,
      });
    }
  }

  /**
   * Takes an approved invoice back to draft (its due date passed before issue, say: issue answers 422
   * DUE_DATE_BEFORE_ISSUE and nothing else moves it). Returns the InvoiceDetail (status draft). 404 outside the entity,
   * 403 without `invoice.issue` on the drafter (the people who issue it are the ones it is stuck for), 409 for any
   * other status or a stale `expectedVersion`. The approval no longer counts: it must be submitted and approved again.
   */
  async reopen(
    id: string,
    body: ReopenInvoiceBody,
    idempotencyKey: string,
  ): Promise<InvoiceDetail> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);
    this.authz.assert('invoice.issue', scope);
    return withTx(this.db, scope, actor, async (tx) => {
      const [owned] = await tx
        .select({ createdBy: invoices.createdBy })
        .from(invoices)
        .where(and(scopeWhereFor(principal, invoices, 'invoice.read'), eq(invoices.id, id)))
        .limit(1);
      if (owned === undefined) throw invoiceNotFound();
      this.authz.assert('invoice.issue', { ...scope, ownerUserId: owned.createdBy });
      const done = await withIdempotency(
        tx,
        { command: 'invoice.reopen', key: idempotencyKey, body: { id, ...body } },
        async () => {
          const [invoice] = await tx
            .select()
            .from(invoices)
            .where(scoped(scope).where(invoices, eq(invoices.id, id)))
            .for('update');
          if (invoice === undefined) throw invoiceNotFound();
          // reopenForEdit also returns a submitted invoice and leaves a draft as it is; this route moves approved only.
          if (invoice.status !== 'approved') {
            throw conflict(
              `A ${invoice.status} invoice cannot be taken back to draft; only an approved one`,
            );
          }
          if (invoice.version !== body.expectedVersion) {
            throw conflict('This invoice was changed by someone else; reload it and try again');
          }
          await this.reopenForEdit(tx, scope, actor, id, body.reason);
          return { status: 200, response: await this.drafting.loadDetail(tx, scope, id) };
        },
      );
      return done.response;
    });
  }

  /**
   * Called by any path that changes a submitted or approved invoice (there is no edit route yet): the approval no
   * longer covers the content. A submitted invoice's open request is cancelled and the invoice is returned; an
   * approved invoice goes back to draft (its request is already decided, and the engine cancels open requests only),
   * so it must be submitted and approved again before issue. Draft and returned invoices are left as they are.
   */
  async reopenForEdit(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    invoiceId: string,
    reason: string,
  ): Promise<InvoiceRow> {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(scoped(scope).where(invoices, eq(invoices.id, invoiceId)))
      .for('update');
    if (invoice === undefined) throw invoiceNotFound();
    if (invoice.status !== 'submitted' && invoice.status !== 'approved') return invoice;
    if (invoice.status === 'submitted' && invoice.approvalRequestId !== null) {
      await this.approvals.cancel(tx, invoice.approvalRequestId, reason, actor);
    }
    const to = invoice.status === 'submitted' ? 'returned' : 'draft';
    const reopened = await updateVersioned(tx, invoices, invoice.id, invoice.version, {
      status: to,
      contentHash: null,
      updatedAt: this.clock(),
    });
    await this.audit.record(tx, {
      action: 'invoice.reopened',
      entityType: 'invoices',
      entityId: invoice.id,
      before: { status: invoice.status, version: invoice.version },
      after: { status: to, approvalRequestId: invoice.approvalRequestId, reason },
    });
    return reopened;
  }

  private async submitInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    callerUserId: string,
    id: string,
    body: SubmitInvoiceBody,
    now: Date,
  ): Promise<InvoiceDetail> {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(scoped(scope).where(invoices, eq(invoices.id, id)))
      .for('update');
    if (invoice === undefined) throw invoiceNotFound();
    if (invoice.kind === 'proforma') {
      throw conflict('A proforma is issued without approval; issue it directly');
    }
    const kind: ApprovableKind = invoice.kind;
    if (!isInvoiceEditable(invoice.status)) {
      throw conflict(
        `A ${invoice.status} invoice cannot be submitted; only a draft or returned one`,
      );
    }
    if (invoice.version !== body.expectedVersion) {
      throw conflict('This invoice was changed by someone else; reload it and try again');
    }
    if (invoice.customerPartyId === null)
      throw conflict('An invoice without a customer cannot be submitted');
    // D02 / A3: the threshold fact is the grand total incl. VAT in NPR (409 fx_rate_stale when the rate is old).
    const fx = await this.money.toNprSnapshot(
      tx,
      scope,
      { amount: invoice.total, currency: invoice.currency },
      now,
    );
    // `fromSchedule` (F1-Q30): the tax_invoice route asks for an Accountant only when the invoice is not drafted from
    // an approved billing schedule line. The line is part of the content hash, so it cannot change after submit.
    const facts = {
      amountNpr: fx.amountNpr,
      currency: invoice.currency,
      kind,
      fromSchedule: invoice.scheduleLineId !== null,
    };
    const requesterUserId = invoice.createdBy ?? callerUserId;
    const sodUserIds = [...new Set([requesterUserId, callerUserId])];

    // Before any write: a route with a blocked step (or no step) is refused instead of opening a stuck request.
    const plan = await this.approvals.preview(scope, kind, facts, sodUserIds);
    if (plan.blocked) {
      throw new NoEligibleApprover({
        kind,
        invoiceId: invoice.id,
        rowVersion: invoice.version,
        reason: plan.blockReason ?? 'No eligible approver',
      });
    }

    const contentHash = await approvalContentHashOf(tx, scope, invoice);
    const submitted = await updateVersioned(tx, invoices, invoice.id, body.expectedVersion, {
      status: 'submitted',
      contentHash,
      updatedAt: now,
    });
    const [customer] = await tx
      .select({ legalName: customers.legalName })
      .from(customers)
      .where(and(eq(customers.tenantId, scope.tenantId), eq(customers.id, invoice.customerPartyId)))
      .limit(1);
    const reference = draftReference(kind, invoice.id);
    const snapshot = {
      kind,
      reference,
      customerName: customer?.legalName ?? null,
      currency: invoice.currency,
      subtotal: invoice.subtotal,
      discountAmount: invoice.discountAmount,
      taxAmount: invoice.taxAmount,
      total: invoice.total,
      amountNpr: fx.amountNpr,
      dueDate: invoice.dueDate,
      manualReason: invoice.manualReason,
      noteReason: invoice.noteReason,
      contentSha256: contentHash.toString('hex'),
    };
    // No documentNumber: the engine stores the draft reference until the invoice is numbered at issue.
    const request = await this.approvals.submit(tx, {
      documentType: kind,
      documentId: invoice.id,
      title: `${KIND_LABEL[kind]} for ${customer?.legalName ?? 'customer'} (${invoice.currency} ${invoice.total})`,
      snapshot,
      facts,
      requesterUserId,
      submittedByUserId: callerUserId,
      sodUserIds,
    });
    if (request.status === 'blocked') {
      // An approver lost since the preview: same answer, and the rollback removes the update and the request.
      throw new NoEligibleApprover({
        kind,
        invoiceId: invoice.id,
        rowVersion: invoice.version,
        reason: 'No eligible approver',
      });
    }
    await updateVersioned(tx, invoices, invoice.id, submitted.version, {
      approvalRequestId: request.requestId,
      updatedAt: now,
    });
    await this.audit.record(tx, {
      action: 'invoice.submitted',
      entityType: 'invoices',
      entityId: invoice.id,
      before: { status: invoice.status, version: invoice.version },
      after: {
        status: 'submitted',
        approvalRequestId: request.requestId,
        amountNpr: fx.amountNpr,
        contentSha256: contentHash.toString('hex'),
      },
    });
    return this.drafting.loadDetail(tx, scope, invoice.id);
  }

  /** P1-PLAN 6.2 "Blocked", without a request row: whoever may fix role assignments is told. */
  private async notifyBlocked(
    tx: DbTransaction,
    tenantId: string,
    n: BlockedNotice,
  ): Promise<void> {
    const reference = draftReference(n.kind, n.invoiceId);
    for (const role of await this.approvals.blockedNoticeRoles(tenantId)) {
      await this.notify.notifyRole(tx, role, {
        title: `Approval blocked: ${reference}`,
        body: `${KIND_LABEL[n.kind]} ${reference} cannot be submitted: ${n.reason}`,
        link: BLOCKED_NOTICE_LINK,
        email: {
          template: 'approval.blocked',
          vars: {
            documentNumber: reference,
            documentType: n.kind,
            reason: n.reason,
            linkPath: BLOCKED_NOTICE_LINK,
          },
        },
        // One notice per attempt on this row version; a retry of the same blocked submit is deduped.
        dedupeKey: `invoice:${n.invoiceId}:blocked:${n.rowVersion}`,
      });
    }
  }
}
