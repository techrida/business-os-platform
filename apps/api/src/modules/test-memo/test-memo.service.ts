// TestMemoService: the first document type that flows through the whole kernel. Serves the NFRs:
// - "no gaps in a numbered series": the number is taken inside the memo's own transaction, so a failed
//   create hands the number back;
// - "amounts are exact and traceable": the NPR value is frozen on the row with its rate, source and date,
//   and re-frozen when the amount or currency is edited, because approval routing compares amountNpr;
// - "separation of duties": everyone who touched the memo (owner and editors) goes to the approval request,
//   which refuses their approval;
// - "no double decisions": submit and update lock the memo row (FOR UPDATE), so a second click waits and then
//   sees the new status.
// P2 replaces this with quotations and deletes the module; the audit rows stay.
import {
  type CreateMemoBody,
  type DocumentVersionDto,
  type MemoDto,
  type Money,
} from '@bos/contracts';
import { approvalRequests, scoped, testMemos } from '@bos/db';
import { Dec } from '@bos/locale';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';

import { APPROVALS_CLOCK, type Clock } from '../approvals/ports';
import { ApprovalsService } from '../approvals/requests.service';
import { type ResourceRef } from '../../platform/authz/can';
import { AuthzService } from '../../platform/authz/authz.service';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { withTx, type TxScope } from '../../platform/db/tx';
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

export function toMemoDto(row: MemoRow): MemoDto {
  return {
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
    customerOrganizationId: row.customerOrganizationId,
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
    customerOrganizationId: row.customerOrganizationId,
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
    this.documents.registerOwner({
      ownerType: MEMO_OWNER_TYPE,
      resource: async (scope, ownerId) => {
        const row = await this.find(this.db, scope, ownerId);
        return row === undefined ? null : memoRef(row);
      },
    });
    this.approvals.registerSubject({
      documentType: MEMO_OWNER_TYPE,
      onDecided: (tx, documentId, outcome) => this.onDecided(tx, documentId, outcome),
    });
  }

  // ----------------------------------------------------------------------------------------------- create

  async create(body: CreateMemoBody): Promise<MemoDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
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
            departmentId: principal.departmentId,
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
    const { scope } = this.caller.current();
    // 404 before authz: a memo of another org is invisible, not forbidden.
    const row = await this.require(this.db, scope, id);
    this.authz.assert('memo.read', memoRef(row));
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
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const row = await this.lock(tx, scope, id);
      // Permission first (403), then state (409): someone who may not edit learns nothing about the status.
      this.authz.assert('memo.update', memoRef(row));
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
    const { scope, actor } = this.caller.current();
    const now = this.clock();
    const result = await withTx(this.db, scope, actor, async (tx) => {
      const row = await this.lock(tx, scope, id);
      this.authz.assert('memo.update', memoRef(row));
      this.assertEditable(row);
      // allClean reads committed document rows: a scan that finishes after this point only makes a file
      // clean sooner, and an upload that starts after it belongs to the next submit.
      if (!(await this.documents.allClean(scope, MEMO_OWNER_TYPE, id))) {
        throw new ConflictException({ code: 'conflict', message: 'attachments are not all clean' });
      }

      const submitted = await this.approvals.submit(tx, {
        documentType: MEMO_OWNER_TYPE,
        documentId: row.id,
        documentNumber: row.number,
        title: row.title,
        // Plain strings only: the engine hashes this snapshot, so it must not hold Dates or row internals.
        snapshot: {
          number: row.number,
          title: row.title,
          body: row.body,
          amount: row.amount,
          currency: row.currency,
          amountNpr: row.amountNpr,
          fxRate: new Dec(row.fxRate).toFixed(),
          fxSource: row.fxSource,
          fxDate: row.fxDate,
          ownerUserId: row.ownerUserId,
          customerOrganizationId: row.customerOrganizationId,
          memoVersion: row.version,
        },
        // The router compares this decimal string with decimal.js (never a float).
        facts: { amountNpr: row.amountNpr },
        requesterUserId: row.ownerUserId,
        sodUserIds: [...new Set([row.ownerUserId, ...row.editorUserIds])],
      });
      await tx
        .update(testMemos)
        .set({ status: 'submitted', version: row.version + 1, updatedAt: now })
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

  private async require(q: Q, scope: TxScope, id: string): Promise<MemoRow> {
    const row = await this.find(q, scope, id);
    if (row === undefined)
      throw new NotFoundException({ code: 'not_found', message: 'Memo not found' });
    return row;
  }

  /** The memo row, locked until the transaction ends. */
  private async lock(tx: DbTransaction, scope: TxScope, id: string): Promise<MemoRow> {
    const [row] = await tx
      .select()
      .from(testMemos)
      .where(scoped(scope).where(testMemos, eq(testMemos.id, id)))
      .for('update');
    if (row === undefined)
      throw new NotFoundException({ code: 'not_found', message: 'Memo not found' });
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
