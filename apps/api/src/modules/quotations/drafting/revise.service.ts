// ReviseService: a new Draft revision of a quotation whose current version is frozen (P2 unit Q1b-C, A2 C15).
// Serves the NFRs:
// - "amounts are exact": the new draft's figures come from PricingService.priceVersion on the copied content,
//   re-priced at the new issue date (tax code periods and FX of that day), never copied as numbers;
// - "no double effects": revise runs inside withIdempotency, so a retried POST returns the first answer;
// - "every change is audited": one withTx() holds the approval cancel, both version updates, the insert, the
//   parent pointer, both status-history rows and the audit event, so they commit or roll back together;
// - "authorization is deny-by-default": staff only, `quotation.revise` on the quotation itself (own scope means
//   the quotation's owner), and the quotation is read through scoped(), so another entity's quotation is a 404.
//
// Write order (0016_quotations.sql, one_live_version cannot be deferred): (1) cancel an open approval request of
// the current version, (2) the old version to superseded, (3) insert the new draft (supersedes = old), (4) the old
// version's superseded_by = new, (5) quotations.current_version_id = new, (6) history and audit.
// Only Approved and Sent become Superseded (QUOTATION_REVISION_RULES.supersededOnRevise); a Rejected or Expired
// version keeps its status, and only its superseded_by link is set.
//
// Lock order: the quotation row, then the current version's approval request, then the version. CancelService and
// ApprovalsService.act take the request before the version too, so an approver deciding while the owner revises
// waits instead of deadlocking.
import {
  canReviseQuotation,
  QUOTATION_REVISION_RULES,
  type Permission,
  type QuotationStatus,
  type QuotationVersionDto,
  type ReviseQuotationBody,
} from '@bos/contracts';
import {
  approvalRequests,
  opportunities,
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
} from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService } from '../../../platform/authz/authz.service';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../../platform/db/tx';
import { SettingsService } from '../../../platform/settings/settings.service';
import { ApprovalsService } from '../../approvals/requests.service';
import { PricingService } from '../pricing/pricing.service';
import type { PricingInput } from '../pricing/pricing.types';
import { quotationRef } from '../preview/quotation-preview.service';
import { kathmanduDay } from '../reference/reference.types';
import { versionVisibleTo } from './cost-visibility';
import { DraftingCaller } from './drafting.caller';
import { toQuotationVersionDto, type QuotationLineRow, type QuotationVersionRow } from './mapping';

/** Injection token for a test clock; production falls back to the system time. */
export const REVISE_CLOCK = Symbol('REVISE_CLOCK');

const REVISE_ACTION: Permission = 'quotation.revise';
const AUDIT_ENTITY = 'quotations';
/** Approval request statuses that are still open, so a revise must cancel them (ApprovalsService.cancel). */
const OPEN_REQUEST = ['pending', 'blocked'];

const notFound = () => new NotFoundException({ code: 'not_found', message: 'Quotation not found' });
const conflict = (message: string) => new ConflictException({ code: 'conflict', message });

/** Drops trailing zeros of a decimal string but keeps `minFraction` decimals (as mapping.ts does for the DTO). */
function trimFraction(value: string, minFraction: number): string {
  const [whole = '0', fraction = ''] = value.split('.');
  let kept = fraction.replace(/0+$/, '');
  if (kept.length < minFraction) kept = kept.padEnd(minFraction, '0');
  return kept === '' ? whole : `${whole}.${kept}`;
}

/** `day` (YYYY-MM-DD) plus `days` calendar days, by UTC date arithmetic so no time zone can shift it. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The valid-until date of a new revision (Kuu, TR-Q12g): the customer was promised the previous date, so a revision
 * keeps it unless it has already passed on the new issue date; then the configured default (`issueDate` plus
 * `validityDays`). A date equal to the issue date has not passed: the offer still holds that day.
 */
export function revisedValidUntil(
  previousValidUntil: string,
  issueDate: string,
  validityDays: number,
): string {
  return previousValidUntil >= issueDate ? previousValidUntil : addDays(issueDate, validityDays);
}

/** The pricing input of a copied version: its lines and discount, at the new issue date. */
export function revisedPricingInput(
  old: Pick<QuotationVersionRow, 'currency' | 'discountMode' | 'discountInput'>,
  lines: readonly QuotationLineRow[],
  issueDate: string,
): PricingInput {
  return {
    currency: old.currency as PricingInput['currency'],
    issueDate,
    lines: [...lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        lineNo: l.lineNo,
        catalogItemId: l.catalogItemId,
        description: l.description,
        uom: l.uom,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        // A period id of the code; pricing re-resolves the period in force on the new issue date.
        taxCodeId: l.taxCodeId,
        unitCost: l.unitCost,
      })),
    discount:
      old.discountMode === null || old.discountInput === null
        ? null
        : old.discountMode === 'pct'
          ? { mode: 'pct', value: trimFraction(old.discountInput, 0) }
          : { mode: 'amount', value: trimFraction(old.discountInput, 2) },
  };
}

@Injectable()
export class ReviseService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly pricing: PricingService,
    private readonly settings: SettingsService,
    private readonly approvals: ApprovalsService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly caller: DraftingCaller,
    @Optional() @Inject(REVISE_CLOCK) private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * `POST /v1/quotations/:id/revise`. 404 for a quotation outside the acting entity or the caller's scope; 409
   * for a stale expectedVersion (the current version row's `version`) or a current version that is not
   * Approved, Sent, Rejected or Expired. Returns the new Draft version.
   */
  async revise(
    quotationId: string,
    body: ReviseQuotationBody,
    idempotencyKey: string,
  ): Promise<QuotationVersionDto> {
    const { scope, actor, principal } = this.caller.current();
    // Decided before any read: a portal caller holding the key by mistake learns nothing.
    if (principal.orgKind !== 'staff') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
    }
    const now = this.clock();
    // Read outside the transaction: a committed setting, the same for every retry of this request.
    const validityDays = await this.settings.get(scope, 'quotation.validity_days');
    // The stored answer (replayed on a retry) is the full DTO; the cost figures are dropped for this caller per reply.
    const dto = await withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'quotation.revise', key: idempotencyKey, body: { id: quotationId, ...body } },
        async () => ({
          status: 201,
          response: await this.reviseInTx(tx, scope, actor, quotationId, body, now, validityDays),
        }),
      );
      return done.response;
    });
    return versionVisibleTo(principal, dto);
  }

  private async reviseInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    quotationId: string,
    body: ReviseQuotationBody,
    now: Date,
    validityDays: number,
  ): Promise<QuotationVersionDto> {
    await this.assertDealNotLost(tx, scope, quotationId);
    const quotation = await this.lockQuotation(tx, scope, quotationId);
    this.assertMayRevise(quotation);
    const requestId = await this.lockApprovalRequest(tx, scope, quotation);
    const old = await this.lockCurrentVersion(tx, scope, quotation);
    // Checked under the lock and before any write, so a stale caller changes nothing.
    if (old.version !== body.expectedVersion || old.approvalRequestId !== requestId) {
      throw conflict('This quotation was changed by someone else; reload it and try again');
    }
    if (!canReviseQuotation(old.status)) {
      throw conflict(
        `A ${old.status} version cannot be revised; only an approved, sent, rejected or expired one can`,
      );
    }
    const owned = { tenantId: scope.tenantId, organizationId: scope.organizationId };
    const actorId = actor.kind === 'user' ? actor.id : null;
    const reason = body.reason;

    // (1) An approval request still open on the current version is cancelled with the revise reason.
    let cancelledRequestId: string | null = null;
    if (old.approvalRequestId !== null) {
      const [request] = await tx
        .select({ status: approvalRequests.status })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.tenantId, scope.tenantId),
            eq(approvalRequests.id, old.approvalRequestId),
          ),
        )
        .limit(1);
      if (request !== undefined && OPEN_REQUEST.includes(request.status)) {
        await this.approvals.cancel(tx, old.approvalRequestId, reason, actor);
        cancelledRequestId = old.approvalRequestId;
      }
    }

    // (2) Approved and Sent leave the live set first, so the new draft does not hit one_live_version.
    const supersedes = (
      QUOTATION_REVISION_RULES.supersededOnRevise as readonly QuotationStatus[]
    ).includes(old.status);
    if (supersedes) {
      await this.updateOld(tx, scope, old, { status: 'superseded', updatedAt: now });
    }

    // (3) The new draft: the old content, issued today in Kathmandu, re-priced; it keeps the old valid-until date
    // unless that has passed (then the configured days from today).
    const lines = await tx
      .select()
      .from(quotationLines)
      .where(and(eq(quotationLines.tenantId, scope.tenantId), eq(quotationLines.versionId, old.id)))
      .orderBy(asc(quotationLines.lineNo));
    const issueDate = kathmanduDay(now);
    const validUntil = revisedValidUntil(old.validUntil, issueDate, validityDays);
    const priced = await this.pricing.priceVersion(
      tx,
      scope,
      revisedPricingInput(old, lines, issueDate),
    );
    const [inserted] = await tx
      .insert(quotationVersions)
      .values({
        ...owned,
        quotationId: quotation.id,
        revisionNo: old.revisionNo + 1,
        status: 'draft',
        contactId: old.contactId,
        templateId: old.templateId,
        currency: old.currency,
        issueDate,
        validUntil,
        scope: old.scope,
        assumptions: old.assumptions,
        exclusions: old.exclusions,
        termsAndConditions: old.termsAndConditions,
        deliveryTimeline: old.deliveryTimeline,
        paymentTermId: old.paymentTermId,
        paymentSchedule: old.paymentSchedule,
        discountMode: old.discountMode,
        discountInput: old.discountInput,
        ...priced.columns,
        supersedesVersionId: old.id,
        revisionReason: reason,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: quotationVersions.id });
    const newId = inserted!.id;
    const newLines = await tx
      .insert(quotationLines)
      .values(priced.lines.map((line) => ({ ...owned, versionId: newId, ...line })))
      .returning();
    const newTaxSummary =
      priced.taxSummary.length === 0
        ? []
        : await tx
            .insert(quotationTaxSummary)
            .values(priced.taxSummary.map((row) => ({ ...owned, versionId: newId, ...row })))
            .returning();

    // (4) The old version points forward. Not a frozen column, so a Rejected or Expired version takes it too.
    await this.updateOld(
      tx,
      scope,
      { ...old, status: supersedes ? 'superseded' : old.status },
      {
        supersededByVersionId: newId,
        updatedAt: now,
      },
    );

    // (5) The parent's current version moves (the parent row was locked above).
    await tx
      .update(quotations)
      .set({ currentVersionId: newId, updatedAt: now, version: sql`${quotations.version} + 1` })
      .where(and(eq(quotations.tenantId, scope.tenantId), eq(quotations.id, quotation.id)));

    // (6) History of every status that changed, and one audit event for the revise.
    await tx.insert(quotationStatusHistory).values(
      [
        ...(supersedes
          ? [
              {
                ...owned,
                versionId: old.id,
                fromStatus: old.status,
                toStatus: 'superseded' as const,
              },
            ]
          : []),
        { ...owned, versionId: newId, fromStatus: null, toStatus: 'draft' as const },
      ].map((row) => ({ ...row, actorId, reason, at: now })),
    );
    await this.audit.record(tx, {
      action: 'quotation.revised',
      entityType: AUDIT_ENTITY,
      entityId: quotation.id,
      before: { versionId: old.id, revisionNo: old.revisionNo, status: old.status },
      after: {
        versionId: newId,
        revisionNo: old.revisionNo + 1,
        status: 'draft',
        oldStatus: supersedes ? 'superseded' : old.status,
        reason,
        total: priced.columns.total,
        cancelledApprovalRequestId: cancelledRequestId,
      },
    });

    const [version] = await tx
      .select()
      .from(quotationVersions)
      .where(and(eq(quotationVersions.tenantId, scope.tenantId), eq(quotationVersions.id, newId)));
    return toQuotationVersionDto({
      quotation: { number: quotation.number, customerPartyId: quotation.customerPartyId },
      version: version!,
      lines: newLines,
      taxSummary: newTaxSummary,
      renderedScanStatus: null,
    });
  }

  // ----------------------------------------------------------------------------------------------- helpers

  /**
   * A Lost deal takes no new version. The deal row is locked first, in the order Mark Lost takes it (deal, then
   * quotations), so a revise queued behind Mark Lost sees the committed stage and no lock cycle can form. A missing
   * quotation is left to `lockQuotation`'s 404.
   */
  private async assertDealNotLost(
    tx: DbTransaction,
    scope: TxScope,
    quotationId: string,
  ): Promise<void> {
    const [peek] = await tx
      .select({ opportunityId: quotations.opportunityId })
      .from(quotations)
      .where(scoped(scope).where(quotations, eq(quotations.id, quotationId)));
    if (peek === undefined) return;
    const [deal] = await tx
      .select({ stage: opportunities.stage })
      .from(opportunities)
      .where(scoped(scope).where(opportunities, eq(opportunities.id, peek.opportunityId)))
      .for('update');
    if (deal?.stage === 'lost') {
      throw conflict('This deal is Lost; a quotation on it cannot be revised');
    }
  }

  /** The quotation of the acting entity, locked so a second revise waits for this one; 404 otherwise. */
  private async lockQuotation(tx: DbTransaction, scope: TxScope, id: string) {
    const [row] = await tx
      .select()
      .from(quotations)
      .where(scoped(scope).where(quotations, eq(quotations.id, id)))
      .for('update');
    if (row === undefined) throw notFound();
    return row;
  }

  /**
   * The approval request of the current version, locked before the version (NO KEY UPDATE, as ApprovalsService takes
   * it); null when the version has none. The version is read without a lock here: the caller locks it next and
   * checks that it still points at this request.
   */
  private async lockApprovalRequest(
    tx: DbTransaction,
    scope: TxScope,
    quotation: typeof quotations.$inferSelect,
  ): Promise<string | null> {
    if (quotation.currentVersionId === null) return null;
    const [peek] = await tx
      .select({ approvalRequestId: quotationVersions.approvalRequestId })
      .from(quotationVersions)
      .where(
        scoped(scope).where(
          quotationVersions,
          eq(quotationVersions.id, quotation.currentVersionId),
        ),
      );
    const requestId = peek?.approvalRequestId ?? null;
    if (requestId === null) return null;
    await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, scope.tenantId), eq(approvalRequests.id, requestId)))
      .for('no key update');
    return requestId;
  }

  /** The current version, locked. A quotation always has one once created. */
  private async lockCurrentVersion(
    tx: DbTransaction,
    scope: TxScope,
    quotation: typeof quotations.$inferSelect,
  ): Promise<QuotationVersionRow> {
    if (quotation.currentVersionId === null) {
      throw new Error(`quotation ${quotation.number} has no current version`);
    }
    const [row] = await tx
      .select()
      .from(quotationVersions)
      .where(
        scoped(scope).where(
          quotationVersions,
          and(
            eq(quotationVersions.id, quotation.currentVersionId),
            eq(quotationVersions.quotationId, quotation.id),
          ),
        ),
      )
      .for('update');
    if (row === undefined) {
      throw new Error(`quotation ${quotation.number}: current version is missing`);
    }
    return row;
  }

  /**
   * Record-level authz that answers 404, not 403, for a quotation outside the caller's scope: a 403 would confirm
   * that a guessed id exists. Other denials (no grant at all, inactive user) stay 403.
   */
  private assertMayRevise(row: typeof quotations.$inferSelect): void {
    try {
      this.authz.assert(REVISE_ACTION, quotationRef(row));
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw notFound();
      throw error;
    }
  }

  /**
   * Updates the locked old version on its id and the status it has now. The row version is bumped by hand: an
   * approval subject's onCancelled may already have bumped it inside this transaction, so the expectedVersion
   * check above is the only optimistic-lock check.
   */
  private async updateOld(
    tx: DbTransaction,
    scope: TxScope,
    old: Pick<QuotationVersionRow, 'id' | 'status'>,
    set: Partial<typeof quotationVersions.$inferInsert>,
  ): Promise<void> {
    const rows = await tx
      .update(quotationVersions)
      .set({ ...set, version: sql`${quotationVersions.version} + 1` })
      .where(
        and(
          eq(quotationVersions.tenantId, scope.tenantId),
          eq(quotationVersions.id, old.id),
          eq(quotationVersions.status, old.status),
        ),
      )
      .returning({ id: quotationVersions.id });
    if (rows.length === 0) {
      throw conflict('This quotation was changed by someone else; reload it and try again');
    }
  }
}
