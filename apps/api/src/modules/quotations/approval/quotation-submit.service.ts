// QuotationSubmitService: a draft or returned version goes to approval (Q2). Serves the NFRs:
// - "amounts are exact": the version is re-priced from its stored lines by PricingService (the one calculator) inside
//   the submit transaction, and the approval facts are the unrounded ones (amountNpr, effectiveDiscountPct);
// - "approvals are auditable": the snapshot the approver sees and both hashes (content, snapshot) are written by the
//   same UPDATE that moves the status to submitted, so a frozen version always carries what was approved;
// - "no double effects": the whole submit runs inside withIdempotency, so a retried POST returns the first answer
//   instead of a 409 for a version that is already submitted;
// - "authorization is deny-by-default" and "one legal entity at a time": the version is read in the acting entity
//   only (another entity's id is a 404), and the quotation's owner decides the `own` scope of quotation.submit;
// - "nothing is stuck unseen": when a step has no eligible approver, nothing is submitted (no version update, no
//   request row), admins are told in a transaction of their own, and the caller gets 422 NO_ELIGIBLE_APPROVER.
import {
  CurrencySchema,
  isQuotationEditable,
  type Discount,
  type Permission,
  type QuotationVersionDto,
  type SubmitQuotationBody,
} from '@bos/contracts';
import {
  customers,
  quotationLines,
  quotations,
  quotationStatusHistory,
  quotationTaxSummary,
  quotationVersions,
  scoped,
} from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService } from '../../../platform/authz/authz.service';
import { type ResourceRef } from '../../../platform/authz/can';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../../platform/db/tx';
import { ApprovalsNotify } from '../../approvals/ports';
import { ApprovalsService } from '../../approvals/requests.service';
import { versionVisibleTo } from '../drafting/cost-visibility';
import {
  toQuotationVersionDto,
  type QuotationLineRow,
  type QuotationRow,
  type QuotationTaxSummaryRow,
  type QuotationVersionRow,
} from '../drafting/mapping';
import { approvalFactsOf } from '../preview/preview-result';
import { quotationRef } from '../preview/quotation-preview.service';
import { PricingService } from '../pricing/pricing.service';
import type { PricedVersion, PricingInput } from '../pricing/pricing.types';
import {
  buildApprovalSnapshot,
  contentSha256,
  materialFieldsOf,
  snapshotSha256,
} from './quotation-approval-snapshot';
import { QuotationSubmitCaller } from './quotation-submit.caller';
import { QUOTATION_VERSION_DOCUMENT_TYPE } from './quotation-version.subject';

/** Injection token for a test clock; production falls back to the system time. */
export const QUOTATION_SUBMIT_CLOCK = Symbol('QUOTATION_SUBMIT_CLOCK');

const SUBMIT_ACTION: Permission = 'quotation.submit';
const AUDIT_ENTITY = 'quotations';
/** approval.blocked links may only open the inbox or memos (notify/templates.ts), so the notice opens the inbox. */
const BLOCKED_NOTICE_LINK = '/inbox/';

const notFound = () => new NotFoundException({ code: 'not_found', message: 'Quotation not found' });
const conflict = (message: string) => new ConflictException({ code: 'conflict', message });

/** The version with its quotation, as the submit reads it. */
export interface SubmitHead {
  quotation: Pick<
    QuotationRow,
    'id' | 'number' | 'tenantId' | 'organizationId' | 'ownerUserId' | 'customerPartyId'
  >;
  version: QuotationVersionRow;
}

/** What the admins are told when a step has nobody who may decide it. */
interface BlockedNotice {
  quotationNumber: string;
  revisionNo: number;
  versionId: string;
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
 * The stored discount as the contracts' Discount: the numeric column is padded ("12.5000"), the contract is not
 * ("12.5" for a percentage, "50.00" for an amount). Text only, never through a number. Same rule as mapping.ts.
 */
export function storedDiscountOf(
  v: Pick<QuotationVersionRow, 'discountMode' | 'discountInput'>,
): Discount | null {
  if (v.discountMode === null || v.discountInput === null) return null;
  const minFraction = v.discountMode === 'pct' ? 0 : 2;
  const [whole = '0', fraction = ''] = v.discountInput.split('.');
  let kept = fraction.replace(/0+$/, '');
  if (kept.length < minFraction) kept = kept.padEnd(minFraction, '0');
  const value = kept === '' ? whole : `${whole}.${kept}`;
  return v.discountMode === 'pct' ? { mode: 'pct', value } : { mode: 'amount', value };
}

/** The PricingInput of a stored version: its currency, issue date and discount, and its stored lines in order. */
export function storedPricingInput(
  version: Pick<QuotationVersionRow, 'currency' | 'issueDate' | 'discountMode' | 'discountInput'>,
  lines: readonly QuotationLineRow[],
): PricingInput {
  return {
    currency: CurrencySchema.parse(version.currency),
    issueDate: version.issueDate,
    discount: storedDiscountOf(version),
    lines: [...lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        lineNo: l.lineNo,
        catalogItemId: l.catalogItemId,
        description: l.description,
        uom: l.uom,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxCodeId: l.taxCodeId,
        unitCost: l.unitCost,
      })),
  };
}

/** The database reads and writes of a submit, apart from the service so its unit test needs no Postgres. */
@Injectable()
export class QuotationSubmitStore {
  /** The version with its quotation, in the acting entity only; 404 when it is not there or not that quotation's. */
  async load(
    tx: DbTransaction,
    scope: TxScope,
    quotationId: string,
    versionId: string,
  ): Promise<SubmitHead> {
    const [row] = await tx
      .select({
        version: quotationVersions,
        quotation: {
          id: quotations.id,
          number: quotations.number,
          tenantId: quotations.tenantId,
          organizationId: quotations.organizationId,
          ownerUserId: quotations.ownerUserId,
          departmentId: quotations.departmentId,
          customerPartyId: quotations.customerPartyId,
        },
      })
      .from(quotationVersions)
      .innerJoin(
        quotations,
        and(
          eq(quotations.tenantId, quotationVersions.tenantId),
          eq(quotations.organizationId, quotationVersions.organizationId),
          eq(quotations.id, quotationVersions.quotationId),
        ),
      )
      .where(
        scoped(scope).where(
          quotationVersions,
          and(eq(quotationVersions.id, versionId), eq(quotationVersions.quotationId, quotationId)),
        ),
      )
      .limit(1);
    if (row === undefined) throw notFound();
    return row;
  }

  /** The customer's legal name for the snapshot; undefined when the tenant has no such customer. */
  async customerName(
    tx: DbTransaction,
    tenantId: string,
    customerPartyId: string,
  ): Promise<string | undefined> {
    const [row] = await tx
      .select({ legalName: customers.legalName })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerPartyId)))
      .limit(1);
    return row?.legalName;
  }

  async lines(tx: DbTransaction, tenantId: string, versionId: string): Promise<QuotationLineRow[]> {
    return tx
      .select()
      .from(quotationLines)
      .where(and(eq(quotationLines.tenantId, tenantId), eq(quotationLines.versionId, versionId)))
      .orderBy(asc(quotationLines.lineNo));
  }

  /**
   * Replaces the version's lines and tax summary with the re-priced rows, while the version is still editable, so
   * the stored rows are exactly the ones content_sha256 covers (a tax period or rate entered since the draft was
   * saved could otherwise leave them apart). Returns the rows as Postgres stored them (RETURNING: full column
   * scale), which is what the content hash is taken from.
   */
  async replacePriced(
    tx: DbTransaction,
    head: SubmitHead,
    priced: PricedVersion,
  ): Promise<{ lines: QuotationLineRow[]; taxSummary: QuotationTaxSummaryRow[] }> {
    const { tenantId, organizationId, id: versionId } = head.version;
    await tx
      .delete(quotationLines)
      .where(and(eq(quotationLines.tenantId, tenantId), eq(quotationLines.versionId, versionId)));
    await tx
      .delete(quotationTaxSummary)
      .where(
        and(
          eq(quotationTaxSummary.tenantId, tenantId),
          eq(quotationTaxSummary.versionId, versionId),
        ),
      );
    const owned = { tenantId, organizationId, versionId };
    const lines = await tx
      .insert(quotationLines)
      .values(priced.lines.map((line) => ({ ...owned, ...line })))
      .returning();
    const taxSummary =
      priced.taxSummary.length === 0
        ? []
        : await tx
            .insert(quotationTaxSummary)
            .values(priced.taxSummary.map((row) => ({ ...owned, ...row })))
            .returning();
    return { lines, taxSummary };
  }

  async appendHistory(
    tx: DbTransaction,
    row: typeof quotationStatusHistory.$inferInsert,
  ): Promise<void> {
    await tx.insert(quotationStatusHistory).values(row);
  }
}

@Injectable()
export class QuotationSubmitService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly pricing: PricingService,
    private readonly approvals: ApprovalsService,
    private readonly notify: ApprovalsNotify,
    private readonly audit: AuditService,
    private readonly store: QuotationSubmitStore,
    private readonly caller: QuotationSubmitCaller,
    @Optional()
    @Inject(QUOTATION_SUBMIT_CLOCK)
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Submits the version for approval and returns it as a QuotationVersionDto (status submitted). 404 outside the
   * caller's entity or scope, 409 unless it is a draft or returned or when expectedVersion is stale, 422
   * NO_ELIGIBLE_APPROVER when a step has nobody who may decide it (nothing written but the admins' notice).
   */
  async submit(
    quotationId: string,
    versionId: string,
    body: SubmitQuotationBody,
    idempotencyKey: string,
  ): Promise<QuotationVersionDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    try {
      // The stored answer (replayed on a retry) is the full DTO; the cost figures are dropped for this caller per reply.
      const dto = await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency(
          tx,
          {
            command: 'quotation.submit',
            key: idempotencyKey,
            // The ids are part of the hashed body: one key cannot replay onto another version.
            body: {
              quotationId,
              versionId,
              expectedVersion: body.expectedVersion,
              ...(body.approverUserId === undefined ? {} : { approverUserId: body.approverUserId }),
            },
          },
          async () => ({
            status: 200,
            response: await this.submitInTx(tx, scope, actor, principal.userId, {
              quotationId,
              versionId,
              expectedVersion: body.expectedVersion,
              approverUserId: body.approverUserId,
              now,
            }),
          }),
        );
        return done.response;
      });
      return versionVisibleTo(principal, dto);
    } catch (error) {
      if (!(error instanceof NoEligibleApprover)) throw error;
      // The submit transaction rolled back; the notice gets a transaction of its own so it is kept.
      await withTx(this.db, scope, actor, (tx) =>
        this.notifyBlocked(tx, scope.tenantId, error.notice),
      );
      throw new UnprocessableEntityException({
        code: 'NO_ELIGIBLE_APPROVER',
        message: `This quotation cannot be submitted: ${error.notice.reason}. An administrator has been told.`,
      });
    }
  }

  private async submitInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    callerUserId: string,
    i: {
      quotationId: string;
      versionId: string;
      expectedVersion: number;
      approverUserId?: string | undefined;
      now: Date;
    },
  ): Promise<QuotationVersionDto> {
    const head = await this.store.load(tx, scope, i.quotationId, i.versionId);
    const { quotation, version } = head;
    this.assertVisible(quotationRef(quotation));
    if (!isQuotationEditable(version.status)) {
      throw conflict(
        `A ${version.status} version cannot be submitted; only a draft or returned version can`,
      );
    }
    if (version.version !== i.expectedVersion) {
      throw conflict('This record was changed by someone else; reload it and try again');
    }
    if (quotation.customerPartyId === null) {
      throw conflict('A quotation without a customer cannot be submitted');
    }
    const customerName = await this.store.customerName(
      tx,
      quotation.tenantId,
      quotation.customerPartyId,
    );
    if (customerName === undefined) {
      throw conflict("The quotation's customer no longer exists");
    }
    const storedLines = await this.store.lines(tx, quotation.tenantId, version.id);
    if (storedLines.length === 0) throw conflict('A quotation without lines cannot be submitted');

    const priced = await this.pricing.priceVersion(
      tx,
      scope,
      storedPricingInput(version, storedLines),
    );
    const facts = approvalFactsOf(priced.facts);
    const ownerUserId = quotation.ownerUserId ?? callerUserId;
    const sodUserIds = [...new Set([ownerUserId, callerUserId])];

    // First, before any write: a route with a blocked step is refused instead of opening a stuck request.
    const plan = await this.approvals.preview(
      scope,
      QUOTATION_VERSION_DOCUMENT_TYPE,
      facts,
      sodUserIds,
    );
    if (plan.blocked) {
      throw new NoEligibleApprover({
        quotationNumber: quotation.number,
        revisionNo: version.revisionNo,
        versionId: version.id,
        rowVersion: version.version,
        reason: plan.blockReason ?? 'No eligible approver',
      });
    }
    // A named approver is checked before any write too (the engine checks again in its own transaction): the
    // author, someone of another entity or tenant, or someone without a qualifying role is refused with 422.
    if (i.approverUserId !== undefined) {
      const choice = await this.approvals.assignableApprovers(
        scope,
        QUOTATION_VERSION_DOCUMENT_TYPE,
        facts,
        sodUserIds,
        tx,
      );
      if (!choice?.candidates.some((c) => c.userId === i.approverUserId)) {
        throw new UnprocessableEntityException({
          code: 'APPROVER_NOT_ELIGIBLE',
          message: sodUserIds.includes(i.approverUserId)
            ? 'You prepared this quotation, so you cannot approve it. Choose someone else.'
            : 'The chosen approver cannot approve this quotation. Choose someone from the list.',
        });
      }
    }

    // While the version is still a draft: store the re-priced columns, lines and tax summary, and read them back.
    // The content hash is taken from the rows as Postgres returns them, at full column scale (fx_rate '1.000000',
    // quantity and rates '8.0000'), because the subject's onDecided recomputes it from those rows; the in-memory
    // priced strings may be written at a shorter scale and would hash differently.
    const repriced = await updateVersioned(tx, quotationVersions, version.id, i.expectedVersion, {
      ...priced.columns,
      updatedAt: i.now,
    });
    const stored = await this.store.replacePriced(tx, head, priced);
    const contentHash = contentSha256(materialFieldsOf(repriced, stored.lines, stored.taxSummary));
    const snapshot = buildApprovalSnapshot({
      priced,
      currency: CurrencySchema.parse(version.currency),
      customerName,
      quotationNumber: quotation.number,
      revisionNo: version.revisionNo,
    });
    const snapshotHash = snapshotSha256(snapshot);

    // One statement moves the status and writes both hashes with the FX snapshot and NPR amounts (S2's
    // quotation_versions_snapshot_check); the priced values are the read-back ones, so nothing material changes.
    const submitted = await updateVersioned(tx, quotationVersions, version.id, repriced.version, {
      status: 'submitted',
      fxRate: repriced.fxRate,
      fxSource: repriced.fxSource,
      fxDate: repriced.fxDate,
      amountNpr: repriced.amountNpr,
      nprTaxableAmount: repriced.nprTaxableAmount,
      contentSha256: contentHash,
      snapshotSha256: snapshotHash,
      submittedAt: i.now,
      updatedAt: i.now,
    });

    // The engine hashes this same snapshot object into approval_requests.snapshot_sha256.
    const request = await this.approvals.submit(tx, {
      documentType: QUOTATION_VERSION_DOCUMENT_TYPE,
      documentId: version.id,
      documentNumber: quotation.number,
      title: `Quotation ${quotation.number} revision ${version.revisionNo}`,
      snapshot,
      facts,
      requesterUserId: ownerUserId,
      submittedByUserId: callerUserId,
      sodUserIds,
      ...(i.approverUserId === undefined ? {} : { assigneeUserId: i.approverUserId }),
    });
    if (request.status === 'blocked') {
      // The engine re-plans inside the transaction: an approver lost since the preview. Same answer as a blocked
      // preview, and the rollback removes the version update and the request row (and the engine's own notice).
      throw new NoEligibleApprover({
        quotationNumber: quotation.number,
        revisionNo: version.revisionNo,
        versionId: version.id,
        rowVersion: version.version,
        reason: 'No eligible approver',
      });
    }

    const linked = await updateVersioned(tx, quotationVersions, version.id, submitted.version, {
      approvalRequestId: request.requestId,
      updatedAt: i.now,
    });

    await this.store.appendHistory(tx, {
      tenantId: version.tenantId,
      organizationId: version.organizationId,
      versionId: version.id,
      fromStatus: version.status,
      toStatus: 'submitted',
      actorId: actor.kind === 'user' ? actor.id : null,
      at: i.now,
    });
    await this.audit.record(tx, {
      action: 'quotation.submitted',
      entityType: AUDIT_ENTITY,
      entityId: quotation.id,
      before: { versionId: version.id, status: version.status },
      after: {
        versionId: version.id,
        status: 'submitted',
        approvalRequestId: request.requestId,
        approvalStatus: request.status,
        amountNpr: priced.columns.amountNpr,
        total: priced.columns.total,
        contentSha256: contentHash.toString('hex'),
        snapshotSha256: snapshotHash.toString('hex'),
      },
    });

    return toQuotationVersionDto({
      quotation,
      version: linked,
      lines: stored.lines,
      taxSummary: stored.taxSummary,
      renderedScanStatus: null,
    });
  }

  /** P1-PLAN 6.2 "Blocked", without a request row: whoever may fix role assignments (admin.roles.write) is told. */
  private async notifyBlocked(
    tx: DbTransaction,
    tenantId: string,
    n: BlockedNotice,
  ): Promise<void> {
    for (const role of await this.approvals.blockedNoticeRoles(tenantId)) {
      await this.notify.notifyRole(tx, role, {
        title: `Approval blocked: ${n.quotationNumber}`,
        body: `Quotation ${n.quotationNumber} revision ${n.revisionNo} cannot be submitted: ${n.reason}`,
        link: BLOCKED_NOTICE_LINK,
        email: {
          template: 'approval.blocked',
          vars: {
            documentNumber: n.quotationNumber,
            documentType: QUOTATION_VERSION_DOCUMENT_TYPE,
            reason: n.reason,
            linkPath: BLOCKED_NOTICE_LINK,
          },
        },
        // One notice per attempt on this row version; a retry of the same blocked submit is deduped.
        dedupeKey: `quotation:${n.versionId}:blocked:${n.rowVersion}`,
      });
    }
  }

  /**
   * Record-level authz that answers 404, not 403, for a quotation outside the caller's scope: a 403 would confirm
   * that a guessed id exists. Other denials (no grant at all, inactive user) stay 403.
   */
  private assertVisible(ref: ResourceRef): void {
    try {
      this.authz.assert(SUBMIT_ACTION, ref);
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw notFound();
      throw error;
    }
  }
}
