// QuotationOutcomeService: the customer's answer to a Sent quotation version, accepted or rejected (P2 unit Q3b,
// A2 C9). The shared core: the staff outcome route (RecordOutcomeService) and the portal accept/reject (unit PA)
// both call accept/reject inside their own withTx, so the rules live in one place. Serves the NFRs:
// - "every change is audited": the acceptance row, the version update, the status history, the audit event, the
//   opportunity's Won and the owner's notice all ride the caller's transaction, so they commit or roll back together;
// - "deny-by-default": the scope comes from the transaction (withTx sets it), every read goes through scoped(), so a
//   version of another entity is a 404. Who may answer at all is the caller's check (staff permission or the
//   portal party), never this service's.
//
// Rules, checked under the row locks and before any write:
// - only a Sent version is answered (409 `quotation_not_sent`); the database guard would let Approved -> Accepted
//   through, so this check is the only one that refuses it;
// - the decided day is not after today in Kathmandu (422 `decided_on_in_future`), and not after the version's
//   valid_until (409 `quotation_expired`);
// - a staff entry of an acceptance needs the evidence `sales.evidence_policy` asks for (422 `evidence_policy_unmet`,
//   see evidence-policy.ts), so it is confirmed as it is recorded. A portal acceptance is recorded whatever the
//   policy (F1-Q28, F1 bug 32: the portal no longer dead-ends) and waits for staff to confirm the evidence
//   (`confirmEvidence`, evidence-state.ts); rejecting needs a comment (the table's CHECK refuses one without).
// An acceptance also drafts the sales order for the Accountant to confirm (F1-Q25, sales-orders/draft-order.ts), in
// the same transaction. When the version cannot become an order (a schedule that cannot be split), the acceptance
// still stands: the refusal is audited and the quotation's owner is told, and the manual confirm stays available.
import {
  type AcceptanceDto,
  type ActorKindSchema,
  type EvidenceKind,
  type QuotationEvidenceDto,
  type QuotationStatus,
} from '@bos/contracts';
import {
  customers,
  documents,
  quotationAcceptances,
  quotationEvidenceConfirmations,
  quotations,
  quotationStatusHistory,
  quotationVersions,
  scoped,
} from '@bos/db';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';

import { AuditService } from '../../../platform/audit/audit.service';
import { type DbTransaction } from '../../../platform/db/db.module';
import { type TxScope } from '../../../platform/db/tx';
import { assertNotInfected } from '../../../platform/documents/documents.service';
import { readTxContext } from '../../../platform/documents/tx-context';
import { NotifyService } from '../../../platform/notify/notify.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { OpportunitiesService } from '../../opportunities/opportunities.service';
import { draftOrderOnAcceptance } from '../../sales-orders/draft-order';
import { kathmanduDay } from '../reference/reference.types';
import { missingEvidence } from './evidence-policy';
import { type EvidenceState, evidenceStateOf, readEvidenceState } from './evidence-state';

/** Injection token for a test clock; production falls back to the system time. */
export const QUOTATION_OUTCOME_CLOCK = Symbol('QUOTATION_OUTCOME_CLOCK');

const AUDIT_ENTITY = 'quotations';
/** The roles that can confirm a draft sales order (sales_order.confirm), so the roles told that one is waiting. */
const DRAFT_ORDER_NOTICE_ROLES = ['accountant', 'finance'] as const;

/** `staff` records the answer the customer gave; `customer_user` is the portal (the server sets it). */
export type OutcomeActorKind = z.infer<typeof ActorKindSchema>;

interface OutcomeInputBase {
  versionId: string;
  /** When given, a version of another quotation is a 404 (the staff route names both in its path). */
  quotationId?: string;
  actorKind: OutcomeActorKind;
  /** An app.users id of the acting entity's tenant: the staff user, or the portal user. */
  actorUserId: string;
  /** The day the customer decided (YYYY-MM-DD); the portal passes today in Kathmandu. */
  decidedOn: string;
  /** The version row's `version` the caller saw; a stale one is a 409. Left out by the portal. */
  expectedVersion?: number;
}

export interface AcceptQuotationInput extends OutcomeInputBase {
  /** The name the customer signed with; stored on the acceptance row (and in the audit event). */
  acceptedByName?: string;
  evidenceKinds: readonly EvidenceKind[];
  /** Evidence files uploaded through DocumentsService; stored on the acceptance row (and in the audit event). */
  evidenceDocumentIds?: readonly string[];
  comment?: string | null;
}

/** Staff confirm the evidence behind a portal acceptance (F1-Q28). */
export interface ConfirmEvidenceInput {
  quotationId: string;
  versionId: string;
  /** The staff user (an app.users id of the tenant). */
  actorUserId: string;
  evidenceKinds: readonly EvidenceKind[];
  evidenceDocumentIds: readonly string[];
  comment?: string | undefined;
}

export interface RejectQuotationInput extends OutcomeInputBase {
  comment: string;
  /** Always the customer here; an internal rejection is the approval engine's. */
  rejectionSource: 'customer';
  evidenceKinds?: readonly EvidenceKind[];
  evidenceDocumentIds?: readonly string[];
}

const notFound = () => new NotFoundException({ code: 'not_found', message: 'Quotation not found' });
const conflict = (code: string, message: string) => new ConflictException({ code, message });

@Injectable()
export class QuotationOutcomeService {
  constructor(
    private readonly settings: SettingsService,
    private readonly opportunities: OpportunitiesService,
    private readonly notify: NotifyService,
    private readonly audit: AuditService,
    @Optional()
    @Inject(QUOTATION_OUTCOME_CLOCK)
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Accepts a Sent version inside the caller's `tx`: the acceptance row, the version to Accepted, history, audit,
   * the opportunity to Won (with this version), the draft sales order (F1-Q25), a notice to the quotation's
   * owner and notices to the Accountants and Finance (a new draft order; a portal acceptance's pending evidence). The caller
   * must call `NotifyService.nudge()` after its transaction commits.
   */
  async accept(tx: DbTransaction, input: AcceptQuotationInput): Promise<AcceptanceDto> {
    const { scope } = await readTxContext(tx);
    const { quotation, version } = await this.lockSent(tx, scope, input);
    const policy = await this.settings.get(scope, 'sales.evidence_policy');
    // Staff confirm what they record; a customer's acceptance stands and its evidence waits for staff (F1-Q28).
    if (input.actorKind === 'staff') this.assertPolicyMet(policy, input.evidenceKinds);
    const now = this.clock();
    const acceptance = await this.insertAcceptance(tx, scope, version.id, 'accepted', input);
    await this.moveVersion(tx, scope, version.id, {
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
    });
    await this.writeHistory(tx, scope, version.id, 'accepted', input, now);
    await this.audit.record(tx, {
      action: 'quotation.accepted',
      entityType: AUDIT_ENTITY,
      entityId: quotation.id,
      before: { versionId: version.id, status: 'sent' },
      after: {
        versionId: version.id,
        status: 'accepted',
        actorKind: input.actorKind,
        decidedOn: input.decidedOn,
        evidenceKinds: [...input.evidenceKinds],
        evidenceDocumentIds: [...(input.evidenceDocumentIds ?? [])],
        acceptedByName: input.acceptedByName ?? null,
        evidencePolicy: policy,
        evidenceStatus: input.actorKind === 'staff' ? 'confirmed' : 'pending',
      },
    });
    await this.opportunities.markWon(tx, quotation.opportunityId, version.id);
    // Nobody is the draft's creator: the Accountant who confirms it becomes one. Its quotation's owner reaches it.
    const draft = await draftOrderOnAcceptance(
      tx,
      scope,
      { settings: this.settings, audit: this.audit },
      quotation,
      version,
      null,
    );
    // Accountants and Finance both hold sales_order.confirm, so both hear of the draft (in-app only). Someone who
    // holds both roles still gets one notice: the bell row is unique per (tenant, user, dedupe key). An order that
    // already existed or could not be drafted is not a new draft: no notice.
    if (draft.drafted) {
      for (const role of DRAFT_ORDER_NOTICE_ROLES) {
        await this.notify.notifyRole(tx, role, {
          title: `Draft sales order for ${quotation.number} waits for you`,
          body: `${quotation.number} was accepted and its sales order was drafted; confirm it to start billing.`,
          link: `/sales-orders/${draft.orderId}`,
          dedupeKey: `sales_order.drafted:${draft.orderId}`,
        });
      }
    }
    // A portal acceptance stands with its evidence pending (F1-Q28); a staff entry is confirmed as it is recorded.
    if (input.actorKind !== 'staff') {
      await this.notify.notifyRole(tx, 'accountant', {
        title: `Evidence for ${quotation.number} waits for confirmation`,
        body: `The customer accepted ${quotation.number} in the portal; its evidence waits for staff to confirm.`,
        link: `/quotations/${quotation.id}`,
        dedupeKey: `quotation.evidence_pending:${version.id}`,
      });
    }
    if (!draft.drafted && draft.reason === 'refused' && quotation.ownerUserId !== null) {
      await this.notify.notifyUser(tx, {
        userId: quotation.ownerUserId,
        title: `No draft sales order for ${quotation.number}`,
        body: `${quotation.number} was accepted, but its sales order could not be drafted: ${draft.refusal.message}`,
        link: `/quotations/${quotation.id}`,
        dedupeKey: `sales_order.draft_refused:${version.id}`,
      });
    }
    if (quotation.ownerUserId !== null) {
      const customerName = await this.customerName(tx, scope, quotation.customerPartyId);
      const linkPath = `/quotations/${quotation.id}`;
      await this.notify.notifyUser(tx, {
        userId: quotation.ownerUserId,
        title: `Quotation ${quotation.number} accepted`,
        body: `${customerName} accepted quotation ${quotation.number}.`,
        link: linkPath,
        email: {
          template: 'quotation.accepted',
          vars: { quotationNumber: quotation.number, customerName, linkPath },
        },
        dedupeKey: `quotation.accepted:${version.id}`,
      });
    }
    return acceptance;
  }

  /**
   * Rejects a Sent version inside the caller's `tx`, as the customer's answer: the acceptance row (outcome
   * rejected, with the comment), the version to Rejected with rejection_source `customer`, history and audit.
   */
  async reject(tx: DbTransaction, input: RejectQuotationInput): Promise<AcceptanceDto> {
    const { scope } = await readTxContext(tx);
    const { quotation, version } = await this.lockSent(tx, scope, input);
    const now = this.clock();
    const acceptance = await this.insertAcceptance(tx, scope, version.id, 'rejected', {
      ...input,
      evidenceKinds: input.evidenceKinds ?? [],
    });
    // One statement: quotation_versions_rejected_check ties the status to the rejection source.
    await this.moveVersion(tx, scope, version.id, {
      status: 'rejected',
      rejectionSource: input.rejectionSource,
      rejectedAt: now,
      updatedAt: now,
    });
    await this.writeHistory(tx, scope, version.id, 'rejected', input, now);
    await this.audit.record(tx, {
      action: 'quotation.rejected',
      entityType: AUDIT_ENTITY,
      entityId: quotation.id,
      before: { versionId: version.id, status: 'sent' },
      after: {
        versionId: version.id,
        status: 'rejected',
        rejectionSource: input.rejectionSource,
        actorKind: input.actorKind,
        decidedOn: input.decidedOn,
        comment: input.comment,
        evidenceKinds: [...(input.evidenceKinds ?? [])],
        evidenceDocumentIds: [...(input.evidenceDocumentIds ?? [])],
      },
    });
    return acceptance;
  }

  /**
   * Staff confirm the evidence of a portal acceptance inside the caller's `tx` (F1-Q28): the kinds they hold must
   * meet the policy in force now and the files must be live documents of the entity. One confirmation per version:
   * a second one, or one for a staff entry (confirmed as it was recorded), is a 409 `evidence_already_confirmed`;
   * a version that is not Accepted is a 409 `quotation_not_accepted`. Who may confirm is the caller's check.
   */
  async confirmEvidence(tx: DbTransaction, input: ConfirmEvidenceInput): Promise<EvidenceState> {
    const { scope } = await readTxContext(tx);
    const { quotation, version } = await this.lockVersion(tx, scope, input);
    const state =
      version.status === 'accepted' ? await readEvidenceState(tx, scope, version.id) : undefined;
    if (state === undefined) {
      throw conflict(
        'quotation_not_accepted',
        `A ${version.status} quotation has no acceptance to confirm`,
      );
    }
    if (state.status === 'confirmed') {
      throw conflict(
        'evidence_already_confirmed',
        'The evidence of this acceptance is already confirmed',
      );
    }
    const policy = await this.settings.get(scope, 'sales.evidence_policy');
    this.assertPolicyMet(policy, input.evidenceKinds);
    const documentIds = [...new Set(input.evidenceDocumentIds)];
    await this.assertDocumentsLive(tx, scope, documentIds);
    await assertNotInfected(tx, scope, documentIds);
    const [row] = await tx
      .insert(quotationEvidenceConfirmations)
      .values({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        versionId: version.id,
        evidenceKinds: [...input.evidenceKinds],
        evidenceDocumentIds: documentIds,
        comment: input.comment ?? null,
        confirmedBy: input.actorUserId,
      })
      .returning();
    await this.audit.record(tx, {
      action: 'quotation.evidence_confirmed',
      entityType: AUDIT_ENTITY,
      entityId: quotation.id,
      before: { versionId: version.id, evidenceStatus: 'pending' },
      after: {
        versionId: version.id,
        evidenceStatus: 'confirmed',
        evidenceKinds: [...input.evidenceKinds],
        evidenceDocumentIds: documentIds,
        comment: input.comment ?? null,
        evidencePolicy: policy,
      },
    });
    return evidenceStateOf(state.acceptance, row!);
  }

  /** The evidence DTO of `state` under the entity's policy now; `canConfirm` is the caller's record check. */
  async evidenceView(
    tx: DbTransaction,
    quotationId: string,
    state: EvidenceState,
    canConfirm: boolean,
  ): Promise<QuotationEvidenceDto> {
    const { scope } = await readTxContext(tx);
    const policy = await this.settings.get(scope, 'sales.evidence_policy');
    const { acceptance, confirmation } = state;
    return {
      quotationId,
      versionId: acceptance.versionId,
      status: state.status,
      policy,
      missing: missingEvidence(policy, state.kinds),
      acceptance: {
        actorKind: acceptance.actorKind,
        decidedOn: acceptance.decidedOn,
        acceptedByName: acceptance.acceptedByName,
        evidenceKinds: acceptance.evidenceKinds,
        evidenceDocumentIds: acceptance.evidenceDocumentIds,
      },
      confirmation:
        confirmation === null
          ? null
          : {
              evidenceKinds: confirmation.evidenceKinds,
              evidenceDocumentIds: confirmation.evidenceDocumentIds,
              comment: confirmation.comment,
              confirmedBy: confirmation.confirmedBy,
              confirmedAt: confirmation.createdAt.toISOString(),
            },
      can: { confirm: canConfirm && state.status === 'pending' },
    };
  }

  // ----------------------------------------------------------------------------------------------- helpers

  private assertPolicyMet(
    policy: Parameters<typeof missingEvidence>[0],
    kinds: readonly EvidenceKind[],
  ): void {
    const missing = missingEvidence(policy, kinds);
    if (missing.length > 0) {
      throw new UnprocessableEntityException({
        code: 'evidence_policy_unmet',
        message: `This entity's evidence policy (${policy}) also needs: ${missing.join(', ')}`,
        policy,
        missing,
      });
    }
  }

  /** A foreign or removed document would otherwise be filed as evidence nobody can open. */
  private async assertDocumentsLive(
    tx: DbTransaction,
    scope: TxScope,
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const rows = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        scoped(scope).where(
          documents,
          and(inArray(documents.id, [...ids]), isNull(documents.removedAt)),
        ),
      );
    const live = new Set(rows.map((r) => r.id));
    const bad = ids.filter((id) => !live.has(id));
    if (bad.length > 0) {
      throw new UnprocessableEntityException({
        code: 'invalid_evidence_document',
        message: 'An evidence document does not exist in this entity or was removed',
        documentIds: bad,
      });
    }
  }

  /**
   * Locks the quotation, then the version (the order ReviseService uses, so the two never deadlock), and checks
   * every rule that needs no setting: same quotation, expected row version, Sent, decided day, validity.
   */
  private async lockSent(tx: DbTransaction, scope: TxScope, input: OutcomeInputBase) {
    const { quotation, version } = await this.lockVersion(tx, scope, input);

    if (input.expectedVersion !== undefined && version.version !== input.expectedVersion) {
      throw conflict(
        'conflict',
        'This quotation was changed by someone else; reload it and try again',
      );
    }
    if (version.status !== 'sent') {
      throw conflict(
        'quotation_not_sent',
        `A ${version.status} quotation cannot be answered; only a sent one can`,
      );
    }
    const today = kathmanduDay(this.clock());
    if (input.decidedOn > today) {
      throw new UnprocessableEntityException({
        code: 'decided_on_in_future',
        message: `The decision date ${input.decidedOn} is after today (${today})`,
      });
    }
    if (version.validUntil < input.decidedOn) {
      throw conflict(
        'quotation_expired',
        `This quotation was valid until ${version.validUntil}; revise it to answer again`,
      );
    }
    return { quotation, version };
  }

  /** Locks the quotation, then the version; a version of another quotation (when one is named) is a 404. */
  private async lockVersion(
    tx: DbTransaction,
    scope: TxScope,
    input: { versionId: string; quotationId?: string | undefined },
  ) {
    const [peek] = await tx
      .select({ quotationId: quotationVersions.quotationId })
      .from(quotationVersions)
      .where(scoped(scope).where(quotationVersions, eq(quotationVersions.id, input.versionId)));
    if (peek === undefined) throw notFound();
    if (input.quotationId !== undefined && peek.quotationId !== input.quotationId) throw notFound();
    const [quotation] = await tx
      .select()
      .from(quotations)
      .where(scoped(scope).where(quotations, eq(quotations.id, peek.quotationId)))
      .for('update');
    if (quotation === undefined) throw notFound();
    const [version] = await tx
      .select()
      .from(quotationVersions)
      .where(scoped(scope).where(quotationVersions, eq(quotationVersions.id, input.versionId)))
      .for('update');
    if (version === undefined) throw notFound();
    return { quotation, version };
  }

  private async insertAcceptance(
    tx: DbTransaction,
    scope: TxScope,
    versionId: string,
    outcome: 'accepted' | 'rejected',
    input: OutcomeInputBase & {
      evidenceKinds: readonly EvidenceKind[];
      comment?: string | null;
      evidenceDocumentIds?: readonly string[];
      acceptedByName?: string;
    },
  ): Promise<AcceptanceDto> {
    // The same checks as at evidence confirmation: a live document of this entity, then not infected (TR-Q12e).
    const evidenceIds = [...new Set(input.evidenceDocumentIds ?? [])];
    await this.assertDocumentsLive(tx, scope, evidenceIds);
    await assertNotInfected(tx, scope, evidenceIds);
    const [row] = await tx
      .insert(quotationAcceptances)
      .values({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        versionId,
        outcome,
        actorKind: input.actorKind,
        actorId: input.actorUserId,
        decidedOn: input.decidedOn,
        comment: input.comment ?? null,
        evidenceKinds: [...input.evidenceKinds],
        acceptedByName: input.acceptedByName ?? null,
        evidenceDocumentIds: [...(input.evidenceDocumentIds ?? [])],
      })
      .returning();
    return {
      id: row!.id,
      versionId: row!.versionId,
      outcome: row!.outcome,
      actorKind: row!.actorKind,
      actorId: row!.actorId,
      decidedOn: row!.decidedOn,
      comment: row!.comment,
      evidenceKinds: row!.evidenceKinds,
      evidenceDocumentIds: row!.evidenceDocumentIds,
      acceptedByName: row!.acceptedByName,
    };
  }

  /** Moves the locked Sent version on; the status in the WHERE makes a lost race change nothing. */
  private async moveVersion(
    tx: DbTransaction,
    scope: TxScope,
    versionId: string,
    set: Partial<typeof quotationVersions.$inferInsert>,
  ): Promise<void> {
    const rows = await tx
      .update(quotationVersions)
      .set({ ...set, version: sql`${quotationVersions.version} + 1` })
      .where(
        and(
          eq(quotationVersions.tenantId, scope.tenantId),
          eq(quotationVersions.id, versionId),
          eq(quotationVersions.status, 'sent'),
        ),
      )
      .returning({ id: quotationVersions.id });
    if (rows.length === 0) {
      throw conflict('quotation_not_sent', 'This quotation was answered by someone else');
    }
  }

  private async writeHistory(
    tx: DbTransaction,
    scope: TxScope,
    versionId: string,
    toStatus: QuotationStatus,
    input: OutcomeInputBase & { comment?: string | null },
    at: Date,
  ): Promise<void> {
    await tx.insert(quotationStatusHistory).values({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      versionId,
      fromStatus: 'sent',
      toStatus,
      actorId: input.actorUserId,
      reason: input.comment ?? null,
      at,
    });
  }

  private async customerName(
    tx: DbTransaction,
    scope: TxScope,
    customerPartyId: string | null,
  ): Promise<string> {
    if (customerPartyId === null) return 'The customer';
    const [row] = await tx
      .select({ legalName: customers.legalName })
      .from(customers)
      .where(and(eq(customers.tenantId, scope.tenantId), eq(customers.id, customerPartyId)));
    return row?.legalName ?? 'The customer';
  }
}
