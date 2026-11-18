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
  type AttachVerificationDocumentBody,
  type ChecklistItem,
  type Permission,
  type RemoveVerificationDocumentBody,
  type VerificationCaseDto,
} from '@bos/contracts';
import { customers, verificationCases } from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
  type OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';

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
  acceptProvided,
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
    return toVerificationCaseDto(l.row);
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

      const reopened = await updateVersioned(tx, verificationCases, l.row.id, l.row.version, {
        status: 'draft',
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
    return withTx(this.db, scope, actor, async (tx) => {
      const l = await this.lock(tx, scope.tenantId, id);
      this.assertVisible('customer.write', scope, l);
      if (!isEditable(l.row.status)) {
        throw conflict(`A case in status ${l.row.status} cannot be changed`);
      }
      if (l.row.version !== body.expectedVersion) throw this.stale();
      const versions = await this.documents.listForOwner(scope, VERIFICATION_OWNER_TYPE, id);
      if (!versions.some((v) => v.documentId === body.documentId)) {
        throw new UnprocessableEntityException({
          code: 'unprocessable',
          message: 'documentId is not a document of this verification case',
        });
      }
      const before = checklistOf(l.row);
      const after = attachDocument(before, body.key, body.documentId, body.expiresOn ?? null);
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
      const after = { ...before, status: 'missing' as const, documentId: null, expiresOn: null };
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
  async submit(id: string): Promise<VerificationCaseDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.now();
    return withTx(this.db, scope, actor, async (tx) => {
      const l = await this.lock(tx, scope.tenantId, id);
      this.assertVisible('customer.write', scope, l);
      if (l.row.status !== 'draft') {
        throw conflict(`A case in status ${l.row.status} cannot be submitted`);
      }
      const missing = missingRequired(checklistOf(l.row));
      if (missing.length > 0) {
        throw conflict(`Required documents are missing: ${missing.join(', ')}`);
      }
      const updated = await updateVersioned(tx, verificationCases, id, l.row.version, {
        status: 'submitted',
        submittedByUserId: principal.userId,
        submittedAt: now,
        reviewerUserId: null,
        decidedAt: null,
        reason: null,
        updatedAt: now,
      });
      await this.audit.record(tx, {
        action: 'verification.submitted',
        entityType: 'verification_case',
        entityId: id,
        before: { status: 'draft', version: l.row.version },
        after: { status: 'submitted', version: updated.version, submittedBy: principal.userId },
      });
      return toVerificationCaseDto(updated);
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
      const approve = body.decision === 'approve';
      if (approve) {
        const missing = missingRequired(items);
        if (missing.length > 0) {
          throw conflict(`Required documents are missing: ${missing.join(', ')}`);
        }
        const versions = await this.documents.listForOwner(scope, VERIFICATION_OWNER_TYPE, id);
        const unusable = documentProblems(items, versions);
        if (unusable.length > 0) {
          throw conflict(`Documents are not all clean: ${unusable.join(', ')}`);
        }
      }

      const updated = await updateVersioned(tx, verificationCases, id, body.expectedVersion, {
        status: approve ? 'approved' : 'rejected',
        reviewerUserId: principal.userId,
        decidedAt: now,
        reason: body.comment ?? null,
        checklist: approve ? acceptProvided(items) : items,
        updatedAt: now,
      });
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
