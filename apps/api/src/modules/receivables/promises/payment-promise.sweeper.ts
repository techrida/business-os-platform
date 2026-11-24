// The payment-promise job (worker only, F1-Q33, decision D56): every hour it finds open promises to pay whose promised
// day is before today in Asia/Kathmandu and settles each one:
// - the invoice still has an open amount: the promise becomes `missed` and ONE collection call is planned for
//   Finance. The call is a follow-up of its own kind (an app.activities row of kind `collection_call` with a due time,
//   D39, R4c1 Q1) on the invoice's customer: it lists on the Follow-ups page and the assignee completes it like any
//   other, but it is read and changed by the receivables permissions, never the customer's activity reach. The receivables
//   aging flags the customer and currency from then on (ReceivablesService.missedPromises);
// - the invoice was settled meanwhile: the promise becomes `kept`, and nothing else happens.
//
// Who gets the call (collectionAssignee): the person who recorded the promise when they hold the Finance role, else
// the first active Finance member of the entity by name, else the recorder (an Accountant) while still active, else
// nobody (the call then lists for everyone who may read receivables). The open question in the unit report asks
// Kuu to confirm this.
//
// Safe to repeat and to run on two workers at once, and ONE call per promise: each promise is its own transaction;
// the row is locked (SELECT ... FOR UPDATE) and re-read as still open and past its day before anything is written,
// and the call's id is stored on the promise in the same transaction that marks it missed. A second run, or a second
// worker that waited for the lock, finds it no longer open and skips it.
//
// The tests drive the sweeper through a PromiseStore fake; the drizzle store below is checked by the integration
// test against a real database.
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { activities, invoices, openItemBalances, paymentPromises } from '@bos/db';
import { kathmanduDateString } from '@bos/locale';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Job, Queue } from 'bullmq';
import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';

import type { AuditService } from '../../../platform/audit/audit.service';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import { type Actor, systemActor, type TxScope } from '../../../platform/db/tx';
import type { NotifyService } from '../../../platform/notify/notify.service';
import { type AssignmentCandidate, loadAssignmentParties } from '../../leads/lead-assignee';

export const PAYMENT_PROMISE_QUEUE = 'payment-promise';
export const PAYMENT_PROMISE_SWEEP_JOB = 'payment-promise.sweep';
/** The job name after the `system:` prefix of the actor id; the audit log shows `system:payment-promise`. */
export const PAYMENT_PROMISE_JOB_PREFIX = 'payment-promise';
export const PROMISE_EVERY_MS = 60 * 60_000;
/** Promises handled per run. A larger backlog drains over the following hours. */
export const PROMISE_BATCH = 500;

/** The Follow-ups page, where the call lists (a collection call has no page of its own). */
export const COLLECTION_CALL_LINK = '/activities/';

export const PROMISE_STORE = Symbol('PAYMENT_PROMISE_STORE');
export const PROMISE_TX = Symbol('PAYMENT_PROMISE_TX');
export const PROMISE_AUDIT = Symbol('PAYMENT_PROMISE_AUDIT');
export const PROMISE_CLOCK = Symbol('PAYMENT_PROMISE_CLOCK');
export const PROMISE_NOTIFY = Symbol('PAYMENT_PROMISE_NOTIFY');

export interface PromiseCandidate {
  tenantId: string;
  organizationId: string;
  promiseId: string;
}

/** The promise and its invoice, read under the promise's lock. */
export interface DuePromise {
  invoiceId: string;
  invoiceNumber: string;
  customerPartyId: string;
  promisedDate: string;
  note: string | null;
  recordedByUserId: string;
  /** True when the invoice still has an open amount above zero. */
  invoiceOpen: boolean;
}

/** The job's database access, as a port. `tx` is the transaction `PROMISE_TX` opened for the promise's scope. */
export interface PromiseStore {
  /** Open promises with a promised day before `today` (YYYY-MM-DD), oldest first, across tenants. */
  candidates(today: string, limit: number): Promise<PromiseCandidate[]>;
  /** Locks the promise; undefined when it is no longer open or no longer past its day (nothing to do). */
  lockDue(tx: DbTransaction, c: PromiseCandidate, today: string): Promise<DuePromise | undefined>;
  /** The active staff of the promise's entity, with their roles there. */
  staff(tx: DbTransaction, c: PromiseCandidate): Promise<AssignmentCandidate[]>;
  /** Plans the collection call and returns its id. */
  planCall(tx: DbTransaction, c: PromiseCandidate, call: CollectionCall): Promise<string>;
  /** Marks the promise missed with its call. */
  markMissed(tx: DbTransaction, c: PromiseCandidate, activityId: string, now: Date): Promise<void>;
  /** Marks the promise kept (the invoice was settled before the job came by). */
  markKept(tx: DbTransaction, c: PromiseCandidate, now: Date): Promise<void>;
}

export interface CollectionCall {
  customerPartyId: string;
  subject: string;
  body: string;
  dueAt: Date;
  assigneeUserId: string | null;
}

export type RunInTx = <T>(
  scope: TxScope,
  actor: Actor,
  fn: (tx: DbTransaction) => Promise<T>,
) => Promise<T>;
export type PromiseAudit = Pick<AuditService, 'record'>;
export type PromiseNotify = Pick<NotifyService, 'notifyUser'>;
export type Clock = () => Date;

export type PromiseOutcome = 'missed' | 'kept' | 'skipped';
export interface PromiseSweepResult {
  missed: number;
  kept: number;
  /** Promises another worker or a later record settled first. */
  skipped: number;
  failed: number;
}

/**
 * Who does the collection call: the recorder when they hold Finance, else the first active Finance member by name
 * (then id), else the recorder while still active staff (an Accountant), else nobody.
 */
export function collectionAssignee(
  staff: readonly Pick<AssignmentCandidate, 'userId' | 'roleKeys' | 'displayName'>[],
  recordedByUserId: string,
): string | null {
  const recorder = staff.find((s) => s.userId === recordedByUserId);
  if (recorder?.roleKeys.includes('finance')) return recorder.userId;
  const finance = staff
    .filter((s) => s.roleKeys.includes('finance'))
    .sort(
      (a, b) =>
        (a.displayName ?? '').localeCompare(b.displayName ?? '') ||
        (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
    );
  return finance[0]?.userId ?? recorder?.userId ?? null;
}

/** The call's subject and body, as the Follow-ups page shows them. */
export function collectionCallText(
  p: Pick<DuePromise, 'invoiceNumber' | 'promisedDate' | 'note'>,
): {
  subject: string;
  body: string;
} {
  const subject = `Collect payment for ${p.invoiceNumber}`;
  const promised = `The customer promised to pay ${p.invoiceNumber} by ${p.promisedDate}, and it is still open.`;
  // The recorder's free-text note stays on the promise: the call text is kept to what the invoice itself says.
  return { subject, body: promised };
}

@Injectable()
export class PaymentPromiseSweeper {
  private readonly logger = new Logger(PaymentPromiseSweeper.name);

  constructor(
    @Inject(PROMISE_STORE) private readonly store: PromiseStore,
    @Inject(PROMISE_TX) private readonly runTx: RunInTx,
    @Inject(PROMISE_AUDIT) private readonly audit: PromiseAudit,
    @Inject(PROMISE_CLOCK) private readonly clock: Clock,
    @Inject(PROMISE_NOTIFY) private readonly notify: PromiseNotify,
  ) {}

  /** One run over every tenant. A promise that fails is logged and left for the next run; the rest go on. */
  async sweep(): Promise<PromiseSweepResult> {
    const result: PromiseSweepResult = { missed: 0, kept: 0, skipped: 0, failed: 0 };
    const today = kathmanduDateString(this.clock());
    const candidates = await this.store.candidates(today, PROMISE_BATCH);
    for (const c of candidates) {
      try {
        result[await this.settleOne(c, today)] += 1;
      } catch (error) {
        result.failed += 1;
        // The promise id and a fixed word only: an error message can carry customer data.
        this.logger.error(
          `payment promise failed: promise=${c.promiseId} kind=${error instanceof Error ? error.name : 'error'}`,
        );
      }
    }
    return result;
  }

  async settleOne(c: PromiseCandidate, today: string): Promise<PromiseOutcome> {
    const scope: TxScope = { tenantId: c.tenantId, organizationId: c.organizationId };
    const actor = systemActor(PAYMENT_PROMISE_JOB_PREFIX);
    return this.runTx(scope, actor, async (tx) => {
      const due = await this.store.lockDue(tx, c, today);
      if (due === undefined) return 'skipped';
      const now = this.clock();
      if (!due.invoiceOpen) {
        await this.store.markKept(tx, c, now);
        await this.audit.record(tx, {
          action: 'payment_promise.kept',
          entityType: 'payment_promises',
          entityId: c.promiseId,
          meta: { invoiceId: due.invoiceId, promisedDate: due.promisedDate },
        });
        return 'kept';
      }

      const assigneeUserId = collectionAssignee(
        await this.store.staff(tx, c),
        due.recordedByUserId,
      );
      const text = collectionCallText(due);
      const activityId = await this.store.planCall(tx, c, {
        customerPartyId: due.customerPartyId,
        ...text,
        dueAt: now,
        assigneeUserId,
      });
      // The same event ActivitiesService.create writes for a planned activity, so the call reads like any follow-up.
      await this.audit.record(tx, {
        action: 'activity.scheduled',
        entityType: 'activities',
        entityId: activityId,
        after: {
          kind: 'collection_call',
          customerId: due.customerPartyId,
          dueAt: now.toISOString(),
          assigneeUserId,
        },
      });
      if (assigneeUserId !== null) {
        // Bell only (OQ-30, R6Q22): the call's assignee is told in the same transaction that plans it, so a rolled-back
        // run notifies nobody. Once-only delivery comes from the promise's row lock (lockDue) and this same-transaction write; the dedupe key is a backstop. A call with
        // no assignee lists for everyone who may read receivables and has nobody to ring. No email: the job has no
        // acting user to name, and the `crm.assigned` template names the person who assigned.
        await this.notify.notifyUser(tx, {
          userId: assigneeUserId,
          title: text.subject,
          body: text.body,
          link: COLLECTION_CALL_LINK,
          dedupeKey: `collection_call.planned:${activityId}`,
        });
      }
      await this.store.markMissed(tx, c, activityId, now);
      await this.audit.record(tx, {
        action: 'payment_promise.missed',
        entityType: 'payment_promises',
        entityId: c.promiseId,
        meta: { invoiceId: due.invoiceId, promisedDate: due.promisedDate, activityId },
      });
      return 'missed';
    });
  }
}

/** The store on the real tables. Every query names the tenant and the acting entity. */
export function drizzlePromiseStore(db: Db): PromiseStore {
  const own = (c: PromiseCandidate) =>
    and(
      eq(paymentPromises.tenantId, c.tenantId),
      eq(paymentPromises.organizationId, c.organizationId),
      eq(paymentPromises.id, c.promiseId),
    );
  const due = (today: string) =>
    and(eq(paymentPromises.status, 'open'), lt(paymentPromises.promisedDate, today));
  const bump = { version: sql`${paymentPromises.version} + 1` };

  return {
    async candidates(today, limit) {
      return db
        .select({
          tenantId: paymentPromises.tenantId,
          organizationId: paymentPromises.organizationId,
          promiseId: paymentPromises.id,
        })
        .from(paymentPromises)
        .where(due(today))
        .orderBy(asc(paymentPromises.promisedDate), asc(paymentPromises.id))
        .limit(limit);
    },

    async lockDue(tx, c, today) {
      // The lock is the race guard: a second worker waits here, then re-checks `due` and finds the promise settled.
      const [locked] = await tx
        .select({
          invoiceId: paymentPromises.invoiceId,
          promisedDate: paymentPromises.promisedDate,
          note: paymentPromises.note,
          recordedByUserId: paymentPromises.recordedByUserId,
        })
        .from(paymentPromises)
        .where(and(own(c), due(today)))
        .limit(1)
        .for('update');
      if (locked === undefined) return undefined;

      const [invoice] = await tx
        .select({
          number: invoices.number,
          kind: invoices.kind,
          customerPartyId: invoices.customerPartyId,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, c.tenantId),
            eq(invoices.organizationId, c.organizationId),
            eq(invoices.id, locked.invoiceId),
          ),
        )
        .limit(1);
      if (invoice?.customerPartyId == null) throw new Error('invoice of the promise not found');

      const [open] = await tx
        .select({ id: openItemBalances.openItemId })
        .from(openItemBalances)
        .where(
          and(
            eq(openItemBalances.tenantId, c.tenantId),
            eq(openItemBalances.organizationId, c.organizationId),
            eq(openItemBalances.sourceId, locked.invoiceId),
            sql`${openItemBalances.sourceType} = ${invoice.kind}`,
            eq(openItemBalances.side, 'receivable'),
            eq(openItemBalances.direction, 'debit'),
            gt(openItemBalances.openAmount, '0'),
          ),
        )
        .limit(1);

      return {
        invoiceId: locked.invoiceId,
        invoiceNumber: invoice.number ?? 'the invoice',
        customerPartyId: invoice.customerPartyId,
        promisedDate: locked.promisedDate,
        note: locked.note,
        recordedByUserId: locked.recordedByUserId,
        invoiceOpen: open !== undefined,
      };
    },

    async staff(tx, c) {
      return loadAssignmentParties(tx, { tenantId: c.tenantId, organizationId: c.organizationId });
    },

    async planCall(tx, c, call) {
      // A planned collection call on the customer (D39, 0154): a due time, not completed or cancelled.
      // created_by_user_id stays NULL, as for every system-written row (0062).
      const [row] = await tx
        .insert(activities)
        .values({
          tenantId: c.tenantId,
          organizationId: c.organizationId,
          kind: 'collection_call',
          subject: call.subject,
          body: call.body,
          customerId: call.customerPartyId,
          dueAt: call.dueAt,
          assigneeUserId: call.assigneeUserId,
          createdByUserId: null,
        })
        .returning({ id: activities.id });
      if (row === undefined) throw new Error('collection call insert returned no row');
      return row.id;
    },

    async markMissed(tx, c, activityId, now) {
      await tx
        .update(paymentPromises)
        .set({
          status: 'missed',
          missedAt: now,
          collectionActivityId: activityId,
          updatedAt: now,
          ...bump,
        })
        .where(and(own(c), eq(paymentPromises.status, 'open')));
    },

    async markKept(tx, c, now) {
      await tx
        .update(paymentPromises)
        .set({ status: 'kept', updatedAt: now, ...bump })
        .where(and(own(c), eq(paymentPromises.status, 'open')));
    },
  };
}

@Processor(PAYMENT_PROMISE_QUEUE)
export class PaymentPromiseProcessor extends WorkerHost {
  constructor(private readonly sweeper: PaymentPromiseSweeper) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === PAYMENT_PROMISE_SWEEP_JOB) {
      await this.sweeper.sweep();
      return;
    }
    // A job name nobody handles is a bug; failing keeps it visible instead of silently dropping it.
    throw new Error(`Unknown payment promise job: ${job.name}`);
  }
}

/** Registers the hourly sweep. upsertJobScheduler is idempotent, so restarts never stack schedules. */
@Injectable()
export class PaymentPromiseScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(PAYMENT_PROMISE_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      PAYMENT_PROMISE_SWEEP_JOB,
      { every: PROMISE_EVERY_MS },
      { name: PAYMENT_PROMISE_SWEEP_JOB, opts: { removeOnComplete: 5, removeOnFail: 20 } },
    );
  }
}
