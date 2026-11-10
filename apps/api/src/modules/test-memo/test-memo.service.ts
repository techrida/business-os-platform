// TestMemoService: the first document type that flows through the whole kernel. Serves the NFRs:
// - "no gaps in a numbered series": the number is taken inside the memo's own transaction, so a failed
//   create hands the number back;
// - "amounts are exact and traceable": the NPR value is frozen on the row with its rate, source and date,
//   and re-frozen when the amount or currency is edited, because approval routing compares amountNpr;
// - "separation of duties": everyone who touched the memo (owner, editors, uploaders of its attachments and
//   the submitter) goes to the approval request, which refuses their approval;
// - "what was approved is what was seen": the attachments are frozen into the hashed snapshot at submit, and
//   the owner policy refuses new uploads until the memo is editable again;
// - "no double decisions": submit and update lock the memo row (FOR UPDATE), so a second click waits and then
//   sees the new status.
// P2 replaces this with quotations and deletes the module; the audit rows stay.
import {
  type CreateMemoBody,
  type MemoDirectory,
  type MemoTemplateSnapshot,
  type DocumentVersionDto,
  type MemoDto,
  type Money,
  type Permission,
} from '@bos/contracts';
import {
  approvalRequests,
  departments,
  idpOrgs,
  organizations,
  userEntities,
  users,
  parties,
  scoped,
  testMemos,
} from '@bos/db';
import { Dec } from '@bos/locale';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';

import { APPROVALS_CLOCK, type Clock } from '../approvals/ports';
import { ApprovalsService, type SubmitInput } from '../approvals/requests.service';
import { type Principal, type ResourceRef } from '../../platform/authz/can';
import { AuthzService } from '../../platform/authz/authz.service';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { withTx, type TxScope } from '../../platform/db/tx';
import { type DocumentOwnerPolicy } from '../../platform/documents/documents.ports';
import { DocumentsService } from '../../platform/documents/documents.service';
import { readTxContext } from '../../platform/documents/tx-context';
import { NotifyService } from '../../platform/notify/notify.service';
import { MoneyService } from '../../platform/settings/money.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import { TestMemoCaller } from './test-memo.caller';
import {
  MEMO_OWNER_TYPE,
  type MemoApprovalSummary,
  type MemoDetailDto,
  type SubmitMemoResult,
  type UpdateMemoBody,
} from './test-memo.types';

type MemoRow = typeof testMemos.$inferSelect;
type Q = Db | DbTransaction;

/** The numbering series key; `numbering.memo_prefix` in settings is the display prefix of the same series. */
const MEMO_SERIES = 'MEMO';
/** Only these two states may be edited or submitted: a submitted memo is frozen for the approvers. */
const EDITABLE: readonly MemoRow['status'][] = ['draft', 'returned'];

const iso = (d: Date): string => d.toISOString();

const memoNotFound = () => new NotFoundException({ code: 'not_found', message: 'Memo not found' });
const notAllClean = () =>
  new ConflictException({ code: 'conflict', message: 'attachments are not all clean' });

/** One attachment as the approvers saw it: the exact version and its content hash. */
interface FrozenAttachment {
  documentId: string;
  versionId: string;
  filename: string;
  sha256: string | null;
  detectedMime: string | null;
}

/**
 * The attachment of each document that a submit freezes: its newest version that was not rejected, the same
 * rule as DocumentsService.allClean. Undefined when one of them is not clean (an upload raced the submit).
 */
function frozenAttachments(versions: DocumentVersionDto[]): FrozenAttachment[] | undefined {
  const latest = new Map<string, DocumentVersionDto>();
  for (const v of versions) {
    if (v.status === 'rejected') continue;
    const seen = latest.get(v.documentId);
    if (seen === undefined || v.version > seen.version) latest.set(v.documentId, v);
  }
  const chosen = [...latest.values()];
  if (!chosen.every((v) => v.status === 'clean')) return undefined;
  return chosen
    .sort((a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0))
    .map((v) => ({
      documentId: v.documentId,
      versionId: v.id,
      filename: v.filename,
      sha256: v.sha256,
      detectedMime: v.detectedMime,
    }));
}

export function toMemoDto(row: MemoRow): MemoDto {
  return {
    template: row.template,
    id: row.id,
    number: row.number,
    title: row.title,
    body: row.body,
    amount: row.amount,
    currency: row.currency as MemoDto['currency'],
    amountNpr: row.amountNpr,
    // numeric(18,6) comes back as '1.600000'; drop the trailing zeros like MoneyService does.
    fxRate: new Dec(row.fxRate).toFixed(),
    fxSource: row.fxSource,
    fxDate: row.fxDate,
    status: row.status,
    ownerUserId: row.ownerUserId,
    departmentId: row.departmentId,
    customerPartyId: row.customerPartyId,
    editorUserIds: row.editorUserIds,
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** What authz and the documents module need to decide about one memo (record scope columns of section 5). */
export function memoRef(row: MemoRow): ResourceRef {
  return {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    ownerUserId: row.ownerUserId,
    departmentId: row.departmentId,
    customerPartyId: row.customerPartyId,
  };
}

@Injectable()
export class TestMemoService implements OnModuleInit {
  private readonly log = new Logger(TestMemoService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly numbering: NumberingService,
    private readonly money: MoneyService,
    private readonly documents: DocumentsService,
    private readonly approvals: ApprovalsService,
    private readonly authz: AuthzService,
    private readonly caller: TestMemoCaller,
    @Inject(APPROVALS_CLOCK) private readonly clock: Clock,
    // Optional: a missing notify module only slows delivery (the 5 s drain still sends), it never fails a submit.
    @Optional() private readonly notify?: NotifyService,
  ) {}

  /**
   * Both registries throw on a duplicate, so this runs once, when the module starts. onDecided is only called from
   * ApprovalsService.act, which is an API route, so the worker never needs the registration.
   */
  onModuleInit(): void {
    // Typed with canAttach spelled out, so this compiles whether or not the port declares the optional hook yet.
    const policy: DocumentOwnerPolicy & {
      canAttach(scope: TxScope, ownerId: string): Promise<boolean>;
    } = {
      ownerType: MEMO_OWNER_TYPE,
      resource: async (scope, ownerId) => {
        const row = await this.find(this.db, scope, ownerId);
        return row === undefined ? null : memoRef(row);
      },
      // A submitted memo is frozen for the approvers, files included: the snapshot names the exact versions,
      // so an upload after submit would sit on the memo unseen by anyone who approved it.
      canAttach: async (scope, ownerId) => {
        const row = await this.find(this.db, scope, ownerId);
        return row !== undefined && EDITABLE.includes(row.status);
      },
    };
    this.documents.registerOwner(policy);
    this.approvals.registerSubject({
      documentType: MEMO_OWNER_TYPE,
      onDecided: (tx, documentId, outcome) => this.onDecided(tx, documentId, outcome),
      // The requester opens the memo itself when its approval is decided.
      link: (_tx, documentId) => `/memos/${documentId}`,
    });
  }

  async directory(): Promise<MemoDirectory> {
    const { scope, principal } = this.caller.current();
    this.authz.assert('memo.create');
    if (principal.orgKind !== 'staff' || principal.status !== 'active')
      throw new ForbiddenException();
    const [entity] = await this.db
      .select()
      .from(organizations)
      .where(scoped(scope).where(organizations));
    if (!entity) throw new ForbiddenException();
    const depts = await this.db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .where(scoped(scope).where(departments));
    const people = await this.db
      .select({
        userId: users.id,
        name: users.displayName,
        jobTitle: userEntities.jobTitle,
        departmentId: userEntities.departmentId,
      })
      .from(userEntities)
      .innerJoin(
        users,
        and(eq(users.tenantId, userEntities.tenantId), eq(users.id, userEntities.userId)),
      )
      .innerJoin(idpOrgs, and(eq(idpOrgs.tenantId, users.tenantId), eq(idpOrgs.id, users.idpOrgId)))
      .where(
        and(
          scoped(scope).where(userEntities),
          eq(users.status, 'active'),
          // The authoritative mirror takes email only from ZITADEL human.email; machine users have null.
          isNotNull(users.email),
          ne(users.email, ''),
          eq(idpOrgs.kind, 'staff'),
        ),
      );
    return {
      organizationId: entity.id,
      organizationName: entity.legalName,
      currentUserId: principal.userId,
      departmentId: principal.departmentId,
      departments: depts,
      people: people.flatMap((p) =>
        p.name?.trim()
          ? [
              {
                userId: p.userId,
                name: p.name,
                jobTitle: p.jobTitle,
                department: depts.find((d) => d.id === p.departmentId)?.name ?? null,
              },
            ]
          : [],
      ),
    };
  }

  private async templateSnapshot(
    input: NonNullable<CreateMemoBody['template']>,
  ): Promise<MemoTemplateSnapshot> {
    const directory = await this.directory();
    // Prepared attribution is the actual actor. Delegated authorship needs its own permission.
    if (input.preparedByUserId !== directory.currentUserId)
      throw new ForbiddenException('Prepared by must be the signed-in staff member');
    const department = directory.departments.find((d) => d.id === input.departmentId);
    if (!department) throw new BadRequestException('Choose a department in the active company');
    const person = (id: string) => {
      const p = directory.people.find((p) => p.userId === id);
      if (!p)
        throw new BadRequestException('Selected staff member is unavailable in the active company');
      return p;
    };
    return {
      organizationId: directory.organizationId,
      organizationName: directory.organizationName,
      departmentId: department.id,
      departmentName: department.name,
      date: input.date,
      closing: input.closing,
      preparedBy: person(input.preparedByUserId),
      recommenders: input.recommenderUserIds.map(person),
      approvedBy: person(input.approvedByUserId),
    };
  }

  // ----------------------------------------------------------------------------------------------- create

  async create(body: CreateMemoBody): Promise<MemoDto> {
    const { scope, actor, principal } = this.caller.current();
    const template = body.template ? await this.templateSnapshot(body.template) : undefined;
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      // The FK also refuses a vendor or foreign party, but as a 500; name the problem as a 400 instead.
      if (body.customerPartyId) {
        const [party] = await tx
          .select({ id: parties.id })
          .from(parties)
          .where(
            and(
              eq(parties.tenantId, scope.tenantId),
              eq(parties.id, body.customerPartyId),
              eq(parties.kind, 'customer'),
            ),
          )
          .limit(1);
        if (!party) {
          throw new BadRequestException({
            code: 'bad_request',
            message: 'customerPartyId is not a customer of this tenant',
          });
        }
      }
      const number = await this.numbering.next(tx, MEMO_SERIES, now);
      const snap = await this.money.toNprSnapshot(
        tx,
        scope,
        { amount: body.amount, currency: body.currency },
        now,
      );
      const [row] = await tx
        .insert(testMemos)
        .values(
          scoped(scope).values({
            template,
            number,
            title: body.title,
            body: body.body,
            amount: body.amount,
            currency: body.currency,
            amountNpr: snap.amountNpr,
            fxRate: snap.rate,
            fxSource: snap.rateSource,
            fxDate: snap.rateDate,
            status: 'draft' as const,
            ownerUserId: principal.userId,
            departmentId: template?.departmentId ?? principal.departmentId,
            customerPartyId: body.customerPartyId ?? null,
            version: 1,
            createdAt: now,
            updatedAt: now,
          }),
        )
        .returning();
      return toMemoDto(row!);
    });
  }

  // -------------------------------------------------------------------------------------------------- read

  async get(id: string): Promise<MemoDetailDto> {
    const { scope, principal } = this.caller.current();
    // A memo of another entity, of another party, or outside the caller's scope is invisible, not forbidden.
    const row = await this.findFor(principal, scope, id);
    if (row === undefined) throw memoNotFound();
    this.assertVisible('memo.read', row);
    const attachments: DocumentVersionDto[] = await this.documents.listForOwner(
      scope,
      MEMO_OWNER_TYPE,
      id,
    );
    return { ...toMemoDto(row), attachments, approval: await this.latestApproval(scope, id) };
  }

  // ------------------------------------------------------------------------------------------------ update

  async update(id: string, body: UpdateMemoBody): Promise<MemoDto> {
    const { scope, actor, principal } = this.caller.current();
    const template = body.template ? await this.templateSnapshot(body.template) : undefined;
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const row = await this.lock(tx, scope, id);
      // Scope first (404), then state (409): someone who may not edit learns nothing about the status.
      this.assertVisible('memo.update', row);
      this.assertEditable(row);

      const money: Money = {
        amount: body.amount ?? row.amount,
        currency: (body.currency ?? row.currency) as Money['currency'],
      };
      // Re-freeze the NPR value only when the money changed: a title edit must not move the rate date.
      const moneyChanged = body.amount !== undefined || body.currency !== undefined;
      const snap = moneyChanged ? await this.money.toNprSnapshot(tx, scope, money, now) : undefined;

      const [updated] = await tx
        .update(testMemos)
        .set({
          ...(template !== undefined && { template, departmentId: template.departmentId }),
          ...(body.title !== undefined && { title: body.title }),
          ...(body.body !== undefined && { body: body.body }),
          ...(snap !== undefined && {
            amount: money.amount,
            currency: money.currency,
            amountNpr: snap.amountNpr,
            fxRate: snap.rate,
            fxSource: snap.rateSource,
            fxDate: snap.rateDate,
          }),
          editorUserIds: [...new Set([...row.editorUserIds, principal.userId])],
          version: row.version + 1,
          updatedAt: now,
        })
        .where(scoped(scope).where(testMemos, eq(testMemos.id, id)))
        .returning();
      return toMemoDto(updated!);
    });
  }

  // ------------------------------------------------------------------------------------------------ submit

  async submit(id: string): Promise<SubmitMemoResult> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    const result = await withTx(this.db, scope, actor, async (tx) => {
      const row = await this.lock(tx, scope, id);
      this.assertVisible('memo.update', row);
      this.assertEditable(row);
      // allClean reads committed document rows: a scan that finishes after this point only makes a file
      // clean sooner, and an upload that starts after it belongs to the next submit.
      if (!(await this.documents.allClean(scope, MEMO_OWNER_TYPE, id))) throw notAllClean();
      // A second read for the snapshot: an upload that committed between the two reads must not be frozen
      // unscanned, so the same rule is applied again to exactly the versions that get frozen.
      const versions = await this.documents.listForOwner(scope, MEMO_OWNER_TYPE, id);
      const attachments = frozenAttachments(versions);
      if (attachments === undefined) throw notAllClean();

      // Route on the rate of the submit day, not the draft day: a draft kept for a week must not dodge the
      // management step because the rate moved. Inside the lock, so the stored value is the one routed on.
      const snap = await this.money.toNprSnapshot(
        tx,
        scope,
        { amount: row.amount, currency: row.currency as Money['currency'] },
        now,
      );

      const input: SubmitInput & { submittedByUserId: string } = {
        documentType: MEMO_OWNER_TYPE,
        documentId: row.id,
        documentNumber: row.number,
        title: row.title,
        // Plain strings only: the engine hashes this snapshot, so it must not hold Dates or row internals.
        snapshot: {
          template: row.template ?? null,
          number: row.number,
          title: row.title,
          body: row.body,
          amount: row.amount,
          currency: row.currency,
          amountNpr: snap.amountNpr,
          fxRate: snap.rate,
          fxSource: snap.rateSource,
          fxDate: snap.rateDate,
          ownerUserId: row.ownerUserId,
          customerPartyId: row.customerPartyId,
          memoVersion: row.version,
          attachments,
        },
        // The router compares this decimal string with decimal.js (never a float).
        facts: { amountNpr: snap.amountNpr },
        requesterUserId: row.ownerUserId,
        // Whoever shaped what the approvers see: the owner, every editor, everyone who uploaded a version
        // (even a rejected one), and the person pressing submit (a founder may submit a colleague's memo).
        sodUserIds: [
          ...new Set([
            row.ownerUserId,
            ...row.editorUserIds,
            principal.userId,
            ...versions.flatMap((v) => (v.uploadedBy === null ? [] : [v.uploadedBy])),
          ]),
        ],
        // The actor of the submit action. Declared as an extra field so this compiles before the approvals
        // engine reads it; until then the engine records the requester as the submitter.
        submittedByUserId: principal.userId,
      };
      if (row.template) {
        const directory = await this.directory();
        const selected = [...row.template.recommenders, row.template.approvedBy];
        if (selected.some((p) => !directory.people.some((active) => active.userId === p.userId))) {
          throw new ConflictException('A selected approver is no longer active in this company');
        }
        input.proposedApproverIds = selected.map((p) => p.userId);
      }
      const submitted = await this.approvals.submit(tx, input);
      await tx
        .update(testMemos)
        .set({
          status: 'submitted',
          amountNpr: snap.amountNpr,
          fxRate: snap.rate,
          fxSource: snap.rateSource,
          fxDate: snap.rateDate,
          version: row.version + 1,
          updatedAt: now,
        })
        .where(scoped(scope).where(testMemos, eq(testMemos.id, id)));
      return submitted;
    });
    // After COMMIT, never inside: the drainer runs on its own connection and would find no outbox row yet.
    await this.notify?.nudge();
    return result;
  }

  // -------------------------------------------------------------------------------------------- onDecided

  /**
   * Called by ApprovalsService.act in the deciding transaction, so the memo's new status commits or rolls
   * back together with the approval. Scope comes from the transaction's bos.* settings: `act` is an API call,
   * but the subject must not depend on a request.
   */
  private async onDecided(
    tx: DbTransaction,
    documentId: string,
    outcome: 'approved' | 'returned' | 'rejected',
  ): Promise<void> {
    const { scope } = await readTxContext(tx);
    const updated = await tx
      .update(testMemos)
      .set({ status: outcome, version: sql`${testMemos.version} + 1`, updatedAt: this.clock() })
      .where(
        scoped(scope).where(
          testMemos,
          and(eq(testMemos.id, documentId), eq(testMemos.status, 'submitted')),
        ),
      )
      .returning({ id: testMemos.id });
    if (updated.length === 0) {
      // Throwing rolls the decision back. A decided request whose memo is not "submitted" means the two
      // tables disagree, and a silent skip would leave the memo's status wrong forever.
      this.log.error(`memo ${documentId} is not submitted; refusing to record outcome ${outcome}`);
      throw new ConflictException({
        code: 'conflict',
        message: 'The memo is not waiting for a decision',
      });
    }
  }

  // ----------------------------------------------------------------------------------------------- helpers

  /**
   * Record-level authz that answers 404, not 403, for a memo outside the caller's scope: a 403 would confirm
   * that a guessed id exists. Other denials (no grant at all, inactive user) say nothing about the record, so
   * they stay 403.
   */
  private assertVisible(action: Permission, row: MemoRow): void {
    try {
      this.authz.assert(action, memoRef(row));
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw memoNotFound();
      throw error;
    }
  }

  private assertEditable(row: MemoRow): void {
    if (!EDITABLE.includes(row.status)) {
      throw new ConflictException({
        code: 'conflict',
        message: `A memo in status ${row.status} cannot be changed or submitted`,
      });
    }
  }

  private async find(q: Q, scope: TxScope, id: string): Promise<MemoRow | undefined> {
    const [row] = await q
      .select()
      .from(testMemos)
      .where(scoped(scope).where(testMemos, eq(testMemos.id, id)));
    return row;
  }

  /**
   * The memo as `principal` may look it up. Staff read by entity, and authz then narrows by scope. A customer
   * portal user reads only the memos of the acting entity that name their own party (ADR 0027 §5), so another
   * party's memo is not found at all. Memos have no vendor column, so a vendor finds none.
   */
  private async findFor(
    principal: Principal,
    scope: TxScope,
    id: string,
  ): Promise<MemoRow | undefined> {
    if (principal.orgKind === 'staff') return this.find(this.db, scope, id);
    if (principal.orgKind !== 'customer' || principal.partyId === null) return undefined;
    const [row] = await this.db
      .select()
      .from(testMemos)
      .where(
        scoped(scope).forCounterparty(
          testMemos,
          'customer',
          principal.partyId,
          eq(testMemos.id, id),
        ),
      );
    return row;
  }

  /** The memo row, locked until the transaction ends. */
  private async lock(tx: DbTransaction, scope: TxScope, id: string): Promise<MemoRow> {
    const [row] = await tx
      .select()
      .from(testMemos)
      .where(scoped(scope).where(testMemos, eq(testMemos.id, id)))
      .for('update');
    if (row === undefined) throw memoNotFound();
    return row;
  }

  private async latestApproval(scope: TxScope, id: string): Promise<MemoApprovalSummary | null> {
    const [row] = await this.db
      .select({ requestId: approvalRequests.id, status: approvalRequests.status })
      .from(approvalRequests)
      .where(
        scoped(scope).where(
          approvalRequests,
          and(
            eq(approvalRequests.documentType, MEMO_OWNER_TYPE),
            eq(approvalRequests.documentId, id),
          ),
        ),
      )
      // The open request first (at most one per memo: partial unique index), then the newest. Ordering by
      // submitted_at alone could return an old returned request when two submits share a timestamp.
      .orderBy(sql`${approvalRequests.decidedAt} IS NULL DESC`, desc(approvalRequests.submittedAt))
      .limit(1);
    return row ?? null;
  }
}
