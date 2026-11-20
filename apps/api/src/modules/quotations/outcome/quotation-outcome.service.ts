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
// - accepting needs the evidence `sales.evidence_policy` asks for (422 `evidence_policy_unmet`, see
//   evidence-policy.ts); rejecting needs a comment (the table's CHECK refuses a rejection without one).
import {
  type AcceptanceDto,
  type ActorKindSchema,
  type EvidenceKind,
  type QuotationStatus,
} from '@bos/contracts';
import {
  customers,
  quotationAcceptances,
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
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';

import { AuditService } from '../../../platform/audit/audit.service';
import { type DbTransaction } from '../../../platform/db/db.module';
import { type TxScope } from '../../../platform/db/tx';
import { assertNotInfected } from '../../../platform/documents/documents.service';
import { readTxContext } from '../../../platform/documents/tx-context';
import { NotifyService } from '../../../platform/notify/notify.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { OpportunitiesService } from '../../opportunities/opportunities.service';
import { kathmanduDay } from '../reference/reference.types';
import { missingEvidence } from './evidence-policy';

/** Injection token for a test clock; production falls back to the system time. */
export const QUOTATION_OUTCOME_CLOCK = Symbol('QUOTATION_OUTCOME_CLOCK');

const AUDIT_ENTITY = 'quotations';

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
   * the opportunity to Won (with this version) and a notice to the quotation's owner. The caller must call
   * `NotifyService.nudge()` after its transaction commits.
   */
  async accept(tx: DbTransaction, input: AcceptQuotationInput): Promise<AcceptanceDto> {
    const { scope } = await readTxContext(tx);
    const { quotation, version } = await this.lockSent(tx, scope, input);
    const policy = await this.settings.get(scope, 'sales.evidence_policy');
    const missing = missingEvidence(policy, input.evidenceKinds);
    if (missing.length > 0) {
      throw new UnprocessableEntityException({
        code: 'evidence_policy_unmet',
        message: `This entity's evidence policy (${policy}) also needs: ${missing.join(', ')}`,
        policy,
        missing,
      });
    }
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
      },
    });
    await this.opportunities.markWon(tx, quotation.opportunityId, version.id);
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

  // ----------------------------------------------------------------------------------------------- helpers

  /**
   * Locks the quotation, then the version (the order ReviseService uses, so the two never deadlock), and checks
   * every rule that needs no setting: same quotation, expected row version, Sent, decided day, validity.
   */
  private async lockSent(tx: DbTransaction, scope: TxScope, input: OutcomeInputBase) {
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
    // TR-Q12e: an evidence file the scan found infected is not recorded with the decision.
    await assertNotInfected(tx, scope, input.evidenceDocumentIds ?? []);
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
