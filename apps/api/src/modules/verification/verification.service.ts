// VerificationService: the KYB (know your business) case of a customer. Serves the NFRs:
// - "no approval without evidence": an approval needs every required checklist item backed by a document
//   that each file on the submitted checklist passed its virus scan;
// - "separation of duties": whoever submitted the case cannot decide it;
// - "no double decisions" and "no lost updates": every state change locks the case row and goes through
//   updateVersioned with the version the caller saw; a decision also honours the Idempotency-Key;
// - "every change is audited": each write runs in withTx (the audit trigger records the row change) and adds a
//   domain event through AuditService.
// Cases are tenant-level (ADR 0027): one per customer party, visible from every legal entity of the tenant, so
// the lookups filter on the tenant alone. Another tenant's case is not found, never forbidden.
// The submit writes submitted_by_user_id and submitted_at; only a decision writes reviewer_user_id and decided_at.
import {
  ChecklistItemSchema,
  VerificationEvidenceSchema,
  VerificationReviewHistorySchema,
  type ReviewVerificationItemBody,
  type VerificationReviewHistory,
  type AttachVerificationDocumentBody,
  type ChecklistItem,
  type Permission,
  type RemoveVerificationDocumentBody,
  type VerificationCaseDto,
} from '@bos/contracts';
import { customers, users, verificationCases, verificationReviewEvents } from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
  type OnModuleInit,
} from '@nestjs/common';
import { sql, getTableColumns, and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { type ResourceRef } from '../../platform/authz/can';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { withTx, type TxScope } from '../../platform/db/tx';
import { type DocumentOwnerPolicy } from '../../platform/documents/documents.ports';
import { DocumentsService } from '../../platform/documents/documents.service';
import { VerificationCaller } from './verification.caller';
import {
  DEFAULT_CHECKLIST,
  attachDocument,
  documentProblems,
  isEditable,
  missingRequired,
  reopenChecklist,
} from './verification.rules';
import {
  VERIFICATION_OWNER_TYPE,
  type CreateVerificationCaseBody,
  type DecisionBody,
  type ListVerificationCasesQuery,
} from './verification.types';

type CaseRow = typeof verificationCases.$inferSelect;
type Q = Db | DbTransaction;

/** A case with the owner of its customer, which is what the `own` scope of verification.read means. */
interface Loaded {
  row: CaseRow;
  customerOwnerUserId: string | null;
}

/** A bound so a list can never grow without limit. */
const LIST_LIMIT = 500;

const notFound = (what: string) =>
  new NotFoundException({ code: 'not_found', message: `${what} not found` });
const conflict = (message: string) => new ConflictException({ code: 'conflict', message });
const separationOfDuties = () =>
  new ForbiddenException({
    code: 'forbidden',
    message: 'Forbidden',
    reason: 'separation_of_duties',
  });

const checklistOf = (row: CaseRow): ChecklistItem[] =>
  ChecklistItemSchema.array().parse(row.checklist);

export function toVerificationCaseDto(row: CaseRow): VerificationCaseDto {
  return {
    reviewPolicy: row.reviewPolicy,
    reviewRound: row.reviewRound,
    submittedBy: row.submittedByUserId,
    id: row.id,
    partyId: row.partyId,
    status: row.status,
    checklist: checklistOf(row),
    reviewedBy: row.reviewerUserId,
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
    decisionNote: row.reason,
    version: row.version,
  };
}

/** What authz decides on: the acting entity stands in for the organization of a tenant-level record. */
function caseRef(scope: TxScope, l: Loaded): ResourceRef {
  return {
    tenantId: l.row.tenantId,
    organizationId: scope.organizationId,
    ownerUserId: l.customerOwnerUserId,
    customerPartyId: l.row.partyId,
    sodUserIds: [],
  };
}

/** 403 stays 403 (no grant, inactive user); a record outside the caller's scope becomes 404. */
function hideOutOfScope(error: unknown, what: string): never {
  const reason =
    error instanceof ForbiddenException
      ? (error.getResponse() as { reason?: unknown }).reason
      : undefined;
  if (reason === 'out_of_scope') throw notFound(what);
  throw error;
}

@Injectable()
export class VerificationService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly caller: VerificationCaller,
  ) {}

  /** Overridable in tests. */
  protected now(): Date {
    return new Date();
  }

  /** Registers how the documents of a case are authorized. Runs once, when the module starts. */
  onModuleInit(): void {
    const policy: DocumentOwnerPolicy = {
      ownerType: VERIFICATION_OWNER_TYPE,
      resource: async (scope, ownerId) => {
        const l = await this.load(this.db, scope.tenantId, ownerId);
        return l === undefined ? null : caseRef(scope, l);
      },
      // A submitted or decided case is frozen: the reviewer decides on exactly the files that were there.
      // FOR SHARE on the case row when a transaction is given, so an upload and a submit cannot interleave.
      canAttach: async (scope, ownerId, tx) => {
        const l = await this.load(tx ?? this.db, scope.tenantId, ownerId, tx ? 'share' : undefined);
        return l !== undefined && isEditable(l.row.status);
      },
    };
    this.documents.registerOwner(policy);
  }

  // -------------------------------------------------------------------------------------------------- read

  async list(query: ListVerificationCasesQuery): Promise<VerificationCaseDto[]> {
    const { scope } = this.caller.current();
    const rows = await this.db
      .select({ row: verificationCases, customerOwnerUserId: customers.ownerUserId })
      .from(verificationCases)
      .innerJoin(
        customers,
        and(
          eq(customers.tenantId, verificationCases.tenantId),
          eq(customers.id, verificationCases.partyId),
        ),
      )
      .where(
        and(
          eq(verificationCases.tenantId, scope.tenantId),
          query.status === undefined ? undefined : eq(verificationCases.status, query.status),
          query.partyId === undefined ? undefined : eq(verificationCases.partyId, query.partyId),
        ),
      )
      .orderBy(desc(verificationCases.createdAt), desc(verificationCases.id))
      .limit(LIST_LIMIT);
    // The same decision as GET /:id for each row, so a list never shows what an open would refuse.
    return rows.filter((l) => this.mayRead(scope, l)).map((l) => toVerificationCaseDto(l.row));
  }

  async get(id: string): Promise<VerificationCaseDto> {
    const { scope } = this.caller.current();
    const l = await this.load(this.db, scope.tenantId, id);
    if (l === undefined) throw notFound('Verification case');
    this.assertVisible('verification.read', scope, l);
    const versions = await this.documents.listForOwner(scope, VERIFICATION_OWNER_TYPE, id);
    const used = new Set(checklistOf(l.row).map((i) => i.documentId));
    const latest = new Map<string, (typeof versions)[number]>();
    for (const v of versions)
      if (
        !used.has(v.documentId) &&
        (!latest.has(v.documentId) || latest.get(v.documentId)!.version < v.version)
      )
        latest.set(v.documentId, v);
    const items = checklistOf(l.row);
    const eligible = versions.filter((v) => v.status !== 'rejected');
    const evidenceReady = items
      .filter((i) => i.documentId)
      .every((i) => {
        const v = versions
          .filter((v) => v.documentId === i.documentId)
          .sort((a, b) => b.version - a.version)[0];
        return (
          v?.id === i.evidence?.documentVersionId &&
          v?.status === 'clean' &&
          v.sha256 &&
          v.scannedAt &&
          (!i.expiresOn || i.expiresOn > this.now().toISOString().slice(0, 10))
        );
      });
    const clean = eligible.every(
      (v) =>
        eligible.some((newer) => newer.documentId === v.documentId && newer.version > v.version) ||
        v.status === 'clean',
    );
    const approvalBlockedReason =
      l.row.reviewPolicy !== 'document_review_v1'
        ? 'Customer case requires document review activation'
        : l.row.status !== 'submitted'
          ? 'Only a submitted case can be approved'
          : !items.some((i) => i.required) ||
              items.some((i) => i.required && !i.documentId) ||
              items.some(
                (i) =>
                  i.documentId &&
                  (i.status !== 'accepted' || i.review?.round !== l.row.reviewRound),
              )
            ? 'Every supplied document needs explicit approval'
            : !evidenceReady || !clean
              ? 'All active evidence must be readable, clean, unchanged and unexpired'
              : null;
    return {
      ...toVerificationCaseDto(l.row),
      approvalBlockedReason,
      reviewerNames:
        l.row.status === 'submitted'
          ? await this.reviewerNames(scope, l.row.submittedByUserId)
          : [],
      looseEvidence: [...latest.values()],
      reviewBlockedReason:
        l.row.submittedByUserId === this.caller.current().principal.userId
          ? 'The submitter cannot review this case.'
          : null,
    };
  }

  /** Name active staff who can open the files and review any case in this entity. */
  private async reviewerNames(scope: TxScope, submittedBy: string | null): Promise<string[]> {
    const result = await this.db.execute<{ name: string }>(sql`
      SELECT DISTINCT u.display_name AS name
      FROM app.users u
      JOIN app.idp_orgs o ON o.tenant_id = u.tenant_id AND o.id = u.idp_org_id AND o.kind = 'staff'
      JOIN app.user_entities e ON e.tenant_id = u.tenant_id AND e.user_id = u.id
      JOIN app.user_roles r ON r.tenant_id = u.tenant_id AND r.user_id = u.id
        AND (e.role_keys IS NULL OR r.role_key = ANY(e.role_keys))
      JOIN app.role_permissions p ON p.tenant_id = r.tenant_id AND p.role_key = r.role_key
      WHERE u.tenant_id = ${scope.tenantId} AND e.organization_id = ${scope.organizationId}
        AND u.status = 'active' AND NULLIF(btrim(u.display_name), '') IS NOT NULL
        AND u.id IS DISTINCT FROM ${submittedBy}::uuid AND p.scope = 'all'
        AND p.permission IN ('verification.review', 'verification.read', 'documents.read')
      GROUP BY u.id, u.display_name HAVING COUNT(DISTINCT p.permission) = 3
      ORDER BY name
    `);
    return result.rows.map((row) => row.name);
  }

  // ------------------------------------------------------------------------------------------------ create

  /**
   * One case per customer. A new case is created (created: true). An existing case is returned as it is,
   * except an expired one, which is reopened in place: back to draft, items whose document lapsed emptied.
   */
  async create(
    body: CreateVerificationCaseBody,
  ): Promise<{ case: VerificationCaseDto; created: boolean }> {
    const { scope, actor } = this.caller.current();
    const now = this.now();
    return withTx(this.db, scope, actor, async (tx) => {
      const [customer] = await tx
        .select({ id: customers.id, ownerUserId: customers.ownerUserId })
        .from(customers)
        .where(
          and(
            eq(customers.tenantId, scope.tenantId),
            eq(customers.id, body.partyId),
            isNull(customers.mergedIntoId),
          ),
        );
      // A party of another tenant, a vendor and a merged-away customer are all "not a customer here".
      if (customer === undefined) throw notFound('Customer');
      try {
        this.authz.assert('customer.write', {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          ownerUserId: customer.ownerUserId,
          customerPartyId: customer.id,
          sodUserIds: [],
        });
        this.authz.assert('verification.read', {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          ownerUserId: customer.ownerUserId,
          customerPartyId: customer.id,
          sodUserIds: [],
        });
      } catch (error) {
        hideOutOfScope(error, 'Customer');
      }

      const inserted = await tx
        .insert(verificationCases)
        .values({
          tenantId: scope.tenantId,
          partyId: body.partyId,
          status: 'draft',
          reviewPolicy: 'document_review_v1',
          checklist: [...DEFAULT_CHECKLIST],
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: [verificationCases.tenantId, verificationCases.partyId] })
        .returning({ id: verificationCases.id });
      const created = inserted[0];
      if (created !== undefined) {
        const l = await this.lock(tx, scope.tenantId, created.id);
        await this.audit.record(tx, {
          action: 'verification.created',
          entityType: 'verification_case',
          entityId: l.row.id,
          after: { partyId: l.row.partyId, status: l.row.status },
        });
        return { case: toVerificationCaseDto(l.row), created: true };
      }

      // The case exists (this transaction waited for a concurrent insert, if there was one).
      const [existing] = await tx
        .select({ id: verificationCases.id })
        .from(verificationCases)
        .where(
          and(
            eq(verificationCases.tenantId, scope.tenantId),
            eq(verificationCases.partyId, body.partyId),
          ),
        );
      const l = await this.lock(tx, scope.tenantId, existing!.id);
      if (l.row.status !== 'expired') return { case: toVerificationCaseDto(l.row), created: false };

      await this.preserveLegacyDecision(tx, l.row);
      const reopened = await updateVersioned(tx, verificationCases, l.row.id, l.row.version, {
        status: 'draft',
        reviewPolicy: 'document_review_v1',
        checklist: reopenChecklist(checklistOf(l.row), now.toISOString().slice(0, 10)),
        reviewerUserId: null,
        decidedAt: null,
        reason: null,
        updatedAt: now,
      });
      await this.audit.record(tx, {
        action: 'verification.reopened',
        entityType: 'verification_case',
        entityId: reopened.id,
        before: { status: 'expired', version: l.row.version },
        after: { status: 'draft', version: reopened.version },
      });
      return { case: toVerificationCaseDto(reopened), created: false };
    });
  }

  // ---------------------------------------------------------------------------------------------- checklist

  /**
   * Puts one registered document on one checklist item. The document must belong to this case (it was
   * uploaded with owner type `verification_case` and this id), which also proves the caller could upload to it.
   * Editing a rejected case sends it back to draft so it can be submitted again.
   */
  async setChecklistItem(
    id: string,
    body: AttachVerificationDocumentBody,
  ): Promise<VerificationCaseDto> {
    const { scope, actor } = this.caller.current();
    const now = this.now();
    const cleanup: Awaited<ReturnType<DocumentsService['removeInTransaction']>> = [];
    const result = await withTx(this.db, scope, actor, async (tx) => {
      const l = await this.lock(tx, scope.tenantId, id);
      this.assertVisible('verification.read', scope, l);
      this.assertVisible('customer.write', scope, l);
      if (!isEditable(l.row.status)) {
        throw conflict(`A case in status ${l.row.status} cannot be changed`);
      }
      if (l.row.version !== body.expectedVersion) throw this.stale();
      const versions = await this.documents.listForOwner(scope, VERIFICATION_OWNER_TYPE, id, tx);
      if (!versions.some((v) => v.documentId === body.documentId)) {
        throw new UnprocessableEntityException({
          code: 'unprocessable',
          message: 'documentId is not a document of this verification case',
        });
      }
      const before = checklistOf(l.row);
      await this.preserveLegacyDecision(tx, l.row);
      const after = attachDocument(before, body.key, body.documentId, body.expiresOn ?? null);
      const slot = after.find((i) => i.key === body.key)!;
      slot.evidence = null;
      slot.review = null;
      const old = before.find((i) => i.key === body.key)?.documentId;
      if (
        old &&
        old !== body.documentId &&
        versions.some((v) => v.documentId === old) &&
        !after.some((i) => i.documentId === old)
      ) {
        cleanup.push(...(await this.documents.removeInTransaction(tx, scope, old)));
      }
      const reopen = l.row.status === 'rejected';
      const updated = await updateVersioned(tx, verificationCases, id, body.expectedVersion, {
        checklist: after,
        ...(reopen && {
          status: 'draft' as const,
          reviewerUserId: null,
          decidedAt: null,
          reason: null,
        }),
        updatedAt: now,
      });
      await this.audit.record(tx, {
        action: 'verification.checklist_updated',
        entityType: 'verification_case',
        entityId: id,
        before: before.find((i) => i.key === body.key) ?? null,
        after: after.find((i) => i.key === body.key),
        meta: { key: body.key, documentId: body.documentId, reopened: reopen },
      });
      return toVerificationCaseDto(updated);
    });
    await this.documents.cleanupRemoved(cleanup);
    return result;
  }

  /** Detaches the file from one checklist row, leaving the document and its versions on the case. */
  async removeChecklistDocument(
    id: string,
    body: RemoveVerificationDocumentBody,
  ): Promise<VerificationCaseDto> {
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const l = await this.lock(tx, scope.tenantId, id);
      this.assertVisible('verification.read', scope, l);
      this.assertVisible('customer.write', scope, l);
      if (!isEditable(l.row.status)) {
        throw conflict(`A case in status ${l.row.status} cannot be changed`);
      }
      if (l.row.version !== body.expectedVersion) throw this.stale();

      const checklist = checklistOf(l.row);
      const before = checklist.find((item) => item.key === body.key);
      if (before === undefined || before.documentId === null) {
        throw conflict('This checklist item has no attached document');
      }
      await this.preserveLegacyDecision(tx, l.row);
      const after = {
        ...before,
        evidence: null,
        review: null,
        status: 'missing' as const,
        documentId: null,
        expiresOn: null,
      };
      // Like replacing a file, removing one starts a fresh draft after a rejection.
      const reopen = l.row.status === 'rejected';
      const updated = await updateVersioned(tx, verificationCases, id, body.expectedVersion, {
        checklist: checklist.map((item) => (item === before ? after : item)),
        ...(reopen && {
          status: 'draft' as const,
          reviewerUserId: null,
          decidedAt: null,
          reason: null,
        }),
        updatedAt: this.now(),
      });
      await this.audit.record(tx, {
        action: 'verification.checklist_document_detached',
        entityType: 'verification_case',
        entityId: id,
        before,
        after,
        meta: { key: body.key, documentId: before.documentId, reopened: reopen },
      });
      return toVerificationCaseDto(updated);
    });
  }

  // -------------------------------------------------------------------------------------------------- submit

  /** Draft to submitted. Every required item must have a document; whether the scan passed is the reviewer's gate. */
  async submit(
    id: string,
    body?: { expectedVersion: number },
    idempotencyKey?: string,
  ): Promise<VerificationCaseDto> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const l = await this.lock(tx, scope.tenantId, id);
      this.assertVisible('verification.read', scope, l);
      this.assertVisible('customer.write', scope, l);
      const run = async () => {
        if (l.row.reviewPolicy !== 'document_review_v1')
          throw conflict('Customer case requires document review activation');
        if (!body || l.row.version !== body.expectedVersion) throw this.stale();
        if (l.row.status !== 'draft') throw conflict('Only a draft can be submitted');
        const items = checklistOf(l.row);
        const missing = missingRequired(items);
        if (missing.length) throw conflict(`Required documents are missing: ${missing.join(', ')}`);
        const versions = await this.documents.listForOwner(scope, VERIFICATION_OWNER_TYPE, id, tx);
        const rejected = await tx
          .select()
          .from(verificationReviewEvents)
          .where(
            and(
              eq(verificationReviewEvents.tenantId, scope.tenantId),
              eq(verificationReviewEvents.caseId, id),
              eq(verificationReviewEvents.kind, 'item_decided'),
              eq(verificationReviewEvents.decision, 'reject'),
            ),
          );
        for (const item of items) {
          item.review = null;
          item.evidence = null;
          if (!item.documentId) continue;
          const v = versions
            .filter((v) => v.documentId === item.documentId)
            .sort((a, b) => b.version - a.version)[0];
          if (!v || v.status === 'rejected')
            throw conflict('Evidence is unavailable; replace or remove it');
          if (
            rejected.some(
              (r) => VerificationEvidenceSchema.parse(r.evidence).documentVersionId === v.id,
            )
          )
            throw conflict('Rejected evidence must be replaced with a new file version');
          if (item.expiresOn && item.expiresOn <= this.now().toISOString().slice(0, 10))
            throw conflict('Evidence has expired');
          item.status = 'provided';
          item.evidence = {
            documentId: v.documentId,
            documentVersionId: v.id,
            versionNumber: v.version,
            expiresOn: item.expiresOn,
          };
        }
        const updated = await updateVersioned(tx, verificationCases, id, body.expectedVersion, {
          status: 'submitted',
          checklist: items,
          reviewRound: l.row.reviewRound + 1,
          submittedByUserId: principal.userId,
          submittedAt: this.now(),
          reviewerUserId: null,
          decidedAt: null,
          reason: null,
          updatedAt: this.now(),
        });
        await this.audit.record(tx, {
          action: 'verification.submitted',
          entityType: 'verification_case',
          entityId: id,
          after: { version: updated.version },
        });
        return { status: 200, response: toVerificationCaseDto(updated) };
      };
      return idempotencyKey
        ? (
            await withIdempotency(
              tx,
              { command: 'verification.submit', key: idempotencyKey, body: { id, ...body } },
              run,
            )
          ).response
        : (await run()).response;
    });
  }

  // ------------------------------------------------------------------------------------------------ decision

  /**
   * Approve or reject a submitted case. With an Idempotency-Key, a retry of the same decision returns the first
   * answer instead of deciding twice; the same key with another body is a 422.
   */
  async decide(
    id: string,
    body: DecisionBody,
    idempotencyKey?: string,
  ): Promise<VerificationCaseDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.now();

    const run = async (
      tx: DbTransaction,
    ): Promise<{ status: number; response: VerificationCaseDto }> => {
      const l = await this.lock(tx, scope.tenantId, id);
      // Scope first (404), then the rest: someone who may not review learns nothing about the case.
      this.assertVisible('verification.review', scope, l);
      if (l.row.version !== body.expectedVersion) throw this.stale();
      if (l.row.status !== 'submitted') {
        throw conflict(`A case in status ${l.row.status} cannot be decided`);
      }
      if (l.row.submittedByUserId === principal.userId) throw separationOfDuties();

      const items = checklistOf(l.row);
      if (l.row.reviewPolicy !== 'document_review_v1')
        throw conflict('Customer case requires document review activation');
      const approve = body.decision === 'approve';
      if (approve) {
        if (
          !items.some((i) => i.required) ||
          items.some((i) => i.required && !i.documentId) ||
          items.some(
            (i) =>
              i.documentId && (i.status !== 'accepted' || i.review?.round !== l.row.reviewRound),
          )
        )
          throw conflict('Every supplied document needs explicit approval');
        for (const item of items.filter((i) => i.documentId)) {
          await this.assertEvidence(tx, scope, l.row, item, true);
          const [review] = await tx
            .select()
            .from(verificationReviewEvents)
            .where(
              and(
                eq(verificationReviewEvents.tenantId, scope.tenantId),
                eq(verificationReviewEvents.caseId, id),
                eq(verificationReviewEvents.id, item.review!.id),
                eq(verificationReviewEvents.round, l.row.reviewRound),
                eq(verificationReviewEvents.itemKey, item.key),
                eq(verificationReviewEvents.decision, 'approve'),
              ),
            );
          if (
            !review ||
            review.documentVersionId !== item.evidence?.documentVersionId ||
            VerificationEvidenceSchema.parse(review.evidence).expiresOn !== item.expiresOn
          )
            throw conflict('Every supplied document needs an immutable approval for this evidence');
        }
        const missing = missingRequired(items);
        if (missing.length > 0) {
          throw conflict(`Required documents are missing: ${missing.join(', ')}`);
        }
        const versions = await this.documents.listForOwner(scope, VERIFICATION_OWNER_TYPE, id, tx);
        const unusable = documentProblems(items, versions);
        const allClean = await this.documents.allClean(scope, VERIFICATION_OWNER_TYPE, id, tx);
        if (unusable.length > 0 || !allClean) {
          throw conflict(
            `Documents are not all clean${unusable.length > 0 ? `: ${unusable.join(', ')}` : ''}`,
          );
        }
      }

      const updated = await updateVersioned(tx, verificationCases, id, body.expectedVersion, {
        status: approve ? 'approved' : 'rejected',
        reviewerUserId: principal.userId,
        decidedAt: now,
        reason: body.comment ?? null,
        checklist: items,
        updatedAt: now,
      });
      await this.journal(tx, updated, null, body.decision, body.comment ?? null);
      await this.audit.record(tx, {
        action: approve ? 'verification.approved' : 'verification.rejected',
        entityType: 'verification_case',
        entityId: id,
        before: { status: 'submitted', version: l.row.version },
        after: { status: updated.status, version: updated.version, reviewedBy: principal.userId },
        meta: { comment: body.comment ?? null },
      });
      return { status: 200, response: toVerificationCaseDto(updated) };
    };

    return withTx(this.db, scope, actor, async (tx) => {
      const visible = await this.lock(tx, scope.tenantId, id);
      this.assertVisible('verification.review', scope, visible);
      if (visible.row.submittedByUserId === principal.userId) throw separationOfDuties();
      if (idempotencyKey === undefined) return (await run(tx)).response;
      const result = await withIdempotency(
        tx,
        // The id is part of the hashed request: the same key on another case is a different request.
        { command: 'verification.decision', key: idempotencyKey, body: { id, ...body } },
        run,
      );
      return result.response;
    });
  }

  async reviewItem(
    id: string,
    key: ChecklistItem['key'],
    body: ReviewVerificationItemBody,
    retryKey: string,
  ): Promise<VerificationCaseDto> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const l = await this.lock(tx, scope.tenantId, id);
      this.assertVisible('verification.review', scope, l);
      if (l.row.submittedByUserId === principal.userId) throw separationOfDuties();
      return (
        await withIdempotency(
          tx,
          { command: 'verification.item_decision', key: retryKey, body: { id, key, ...body } },
          async () => {
            if (l.row.version !== body.expectedVersion) throw this.stale();
            if (l.row.reviewPolicy !== 'document_review_v1' || l.row.status !== 'submitted')
              throw conflict('Only submitted document-review cases can be reviewed');
            const items = checklistOf(l.row),
              item = items.find((i) => i.key === key);
            if (!item || item.status !== 'provided')
              throw conflict('This document is missing or already decided');
            await this.assertEvidence(tx, scope, l.row, item, body.decision === 'approve');
            item.status = body.decision === 'approve' ? 'accepted' : 'rejected';
            const event = await this.journal(
              tx,
              { ...l.row, version: l.row.version + 1 },
              item,
              body.decision,
              body.decision === 'reject' ? body.comment : null,
            );
            item.review = event;
            const updated = await updateVersioned(tx, verificationCases, id, body.expectedVersion, {
              checklist: items,
              updatedAt: this.now(),
            });
            await this.audit.record(tx, {
              action:
                body.decision === 'approve'
                  ? 'verification.item_approved'
                  : 'verification.item_rejected',
              entityType: 'verification_case',
              entityId: id,
              meta: { key, reviewId: event.id },
            });
            return { status: 200, response: toVerificationCaseDto(updated) };
          },
        )
      ).response;
    });
  }

  async removeLooseDocument(id: string, documentId: string): Promise<void> {
    const { scope, actor } = this.caller.current();
    const cleanup = await withTx(this.db, scope, actor, async (tx) => {
      const loaded = await this.lock(tx, scope.tenantId, id);
      this.assertVisible('verification.read', scope, loaded);
      this.assertVisible('customer.write', scope, loaded);
      if (
        !isEditable(loaded.row.status) ||
        checklistOf(loaded.row).some((i) => i.documentId === documentId)
      )
        throw conflict('Only unattached files in an editable case can be removed');
      const versions = await this.documents.listForOwner(scope, VERIFICATION_OWNER_TYPE, id, tx);
      if (!versions.some((v) => v.documentId === documentId)) throw notFound('Document');
      return this.documents.removeInTransaction(tx, scope, documentId);
    });
    await this.documents.cleanupRemoved(cleanup);
  }

  async detachItem(
    id: string,
    key: ChecklistItem['key'],
    body: { expectedVersion: number },
    retryKey: string,
  ): Promise<VerificationCaseDto> {
    const { scope, actor } = this.caller.current();
    const cleanup: Awaited<ReturnType<DocumentsService['removeInTransaction']>> = [];
    const result = await withTx(this.db, scope, actor, async (tx) => {
      const l = await this.lock(tx, scope.tenantId, id);
      this.assertVisible('verification.read', scope, l);
      this.assertVisible('customer.write', scope, l);
      return (
        await withIdempotency(
          tx,
          { command: 'verification.detach', key: retryKey, body: { id, key, ...body } },
          async () => {
            if (l.row.version !== body.expectedVersion) throw this.stale();
            if (!isEditable(l.row.status))
              throw conflict('Reject the case before correcting evidence');
            const items = checklistOf(l.row),
              item = items.find((i) => i.key === key);
            if (!item?.documentId) throw conflict('No document attached');
            await this.preserveLegacyDecision(tx, l.row);
            const old = item.documentId;
            item.documentId = null;
            item.status = 'missing';
            item.expiresOn = null;
            item.evidence = null;
            item.review = null;
            if (!items.some((i) => i.documentId === old)) {
              const versions = await this.documents.listForOwner(
                scope,
                VERIFICATION_OWNER_TYPE,
                id,
                tx,
              );
              if (versions.some((v) => v.documentId === old))
                cleanup.push(...(await this.documents.removeInTransaction(tx, scope, old)));
            }
            const updated = await updateVersioned(tx, verificationCases, id, body.expectedVersion, {
              status: 'draft',
              checklist: items,
              reviewerUserId: null,
              decidedAt: null,
              reason: null,
              updatedAt: this.now(),
            });
            await this.audit.record(tx, {
              action: 'verification.checklist_detached',
              entityType: 'verification_case',
              entityId: id,
              meta: { key },
            });
            return { status: 200, response: toVerificationCaseDto(updated) };
          },
        )
      ).response;
    });
    await this.documents.cleanupRemoved(cleanup);
    return result;
  }

  async reviewHistory(
    id: string,
    query: { before?: { at: string; id: string } | undefined; limit: number },
  ): Promise<VerificationReviewHistory> {
    const { scope } = this.caller.current();
    const l = await this.load(this.db, scope.tenantId, id);
    if (!l) throw notFound('Verification case');
    this.assertVisible('verification.read', scope, l);
    const rows = await this.db
      .select({ ...getTableColumns(verificationReviewEvents), reviewerName: users.displayName })
      .from(verificationReviewEvents)
      .innerJoin(
        users,
        and(
          eq(users.tenantId, verificationReviewEvents.tenantId),
          eq(users.id, verificationReviewEvents.actorUserId),
        ),
      )
      .where(
        and(
          eq(verificationReviewEvents.tenantId, scope.tenantId),
          eq(verificationReviewEvents.caseId, id),
          query.before
            ? or(
                lt(verificationReviewEvents.occurredAt, new Date(query.before.at)),
                and(
                  eq(verificationReviewEvents.occurredAt, new Date(query.before.at)),
                  lt(verificationReviewEvents.id, query.before.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(verificationReviewEvents.occurredAt), desc(verificationReviewEvents.id))
      .limit(query.limit + 1);
    return VerificationReviewHistorySchema.parse({
      items: rows.slice(0, query.limit).map((r) => ({
        ...r,
        itemKey: r.itemKey,
        reviewedBy: r.actorUserId,
        reviewedAt: r.occurredAt.toISOString(),
      })),
      nextCursor:
        rows.length > query.limit
          ? Buffer.from(
              JSON.stringify({
                at: rows[query.limit - 1]!.occurredAt.toISOString(),
                id: rows[query.limit - 1]!.id,
              }),
            ).toString('base64url')
          : null,
    });
  }

  private async assertEvidence(
    tx: DbTransaction,
    scope: TxScope,
    row: CaseRow,
    item: ChecklistItem,
    approve: boolean,
  ): Promise<void> {
    const binding = item.evidence;
    if (!binding || binding.documentId !== item.documentId || binding.expiresOn !== item.expiresOn)
      throw conflict('Evidence is unavailable; correct and resubmit');
    const versions = await this.documents.listForOwner(scope, VERIFICATION_OWNER_TYPE, row.id, tx);
    const latest = versions
      .filter((v) => v.documentId === item.documentId)
      .sort((a, b) => b.version - a.version)[0];
    if (!latest || latest.id !== binding.documentVersionId)
      throw conflict('Bound evidence is unavailable or has changed');
    if (
      approve &&
      (latest.status !== 'clean' ||
        !latest.sha256 ||
        !latest.scannedAt ||
        (item.expiresOn !== null && item.expiresOn <= this.now().toISOString().slice(0, 10)))
    )
      throw conflict('Evidence must be clean and unexpired');
  }

  private async journal(
    tx: DbTransaction,
    row: CaseRow,
    item: ChecklistItem | null,
    decision: 'approve' | 'reject',
    comment: string | null,
    legacy = false,
  ) {
    const { principal, scope } = this.caller.current();
    const [entry] = await tx
      .insert(verificationReviewEvents)
      .values({
        tenantId: row.tenantId,
        caseId: row.id,
        caseVersion: row.version,
        round: row.reviewRound,
        kind: legacy ? 'legacy_case_decided' : item ? 'item_decided' : 'case_decided',
        itemKey: item?.key ?? null,
        decision,
        comment,
        actorUserId: legacy ? row.reviewerUserId! : principal.userId,
        occurredAt: legacy ? row.decidedAt! : this.now(),
        evidence: item?.evidence ?? null,
        evidenceOrganizationId: item ? scope.organizationId : null,
        documentId: item?.evidence?.documentId ?? null,
        documentVersionId: item?.evidence?.documentVersionId ?? null,
      })
      .returning();
    return {
      id: entry!.id,
      decision,
      comment,
      reviewedBy: entry!.actorUserId,
      reviewedAt: entry!.occurredAt.toISOString(),
      round: row.reviewRound,
      evidence: item?.evidence ?? null,
    };
  }

  private async preserveLegacyDecision(tx: DbTransaction, row: CaseRow): Promise<void> {
    if (row.reviewPolicy !== 'case_review_v0' || !row.reviewerUserId || !row.decidedAt) return;
    const [existing] = await tx
      .select()
      .from(verificationReviewEvents)
      .where(
        and(
          eq(verificationReviewEvents.tenantId, row.tenantId),
          eq(verificationReviewEvents.caseId, row.id),
          eq(verificationReviewEvents.caseVersion, row.version),
        ),
      );
    if (!existing)
      await this.journal(
        tx,
        row,
        null,
        row.status === 'rejected' ? 'reject' : 'approve',
        row.reason,
        true,
      );
  }

  // ----------------------------------------------------------------------------------------------- helpers

  private stale(): ConflictException {
    return conflict('This record was changed by someone else; reload it and try again');
  }

  private assertVisible(action: Permission, scope: TxScope, l: Loaded): void {
    try {
      this.authz.assert(action, caseRef(scope, l));
    } catch (error) {
      hideOutOfScope(error, 'Verification case');
    }
  }

  private mayRead(scope: TxScope, l: Loaded): boolean {
    try {
      this.authz.assert('verification.read', caseRef(scope, l));
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  }

  /** The case of this tenant, with its customer's owner. `lock` keeps the row until the transaction ends. */
  private async load(
    q: Q,
    tenantId: string,
    id: string,
    lock?: 'update' | 'share',
  ): Promise<Loaded | undefined> {
    const key = and(eq(verificationCases.tenantId, tenantId), eq(verificationCases.id, id));
    // Lock the case row on its own: drizzle writes `FOR UPDATE OF "app"."verification_cases"` when asked to lock
    // one table of a join, and Postgres rejects the schema-qualified name. The joined read below then sees the
    // row as the lock left it.
    if (lock !== undefined) {
      const [locked] = await q
        .select({ id: verificationCases.id })
        .from(verificationCases)
        .where(key)
        .for(lock);
      if (locked === undefined) return undefined;
    }
    return this.read(q, key);
  }

  private async read(q: Q, key: SQL | undefined): Promise<Loaded | undefined> {
    const [found] = await q
      .select({ row: verificationCases, customerOwnerUserId: customers.ownerUserId })
      .from(verificationCases)
      .innerJoin(
        customers,
        and(
          eq(customers.tenantId, verificationCases.tenantId),
          eq(customers.id, verificationCases.partyId),
        ),
      )
      .where(key);
    return found;
  }

  private async lock(tx: DbTransaction, tenantId: string, id: string): Promise<Loaded> {
    const l = await this.load(tx, tenantId, id, 'update');
    if (l === undefined) throw notFound('Verification case');
    return l;
  }
}
