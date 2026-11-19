// The quotation expiry job (worker only): every hour it finds quotation versions that were sent or approved and
// whose valid_until is before today in Asia/Kathmandu, and moves each one to `expired`. Serves the rule "an expired
// quotation can no longer be accepted" without anyone having to remember to close it.
//
// Safe to repeat and to run on two workers at once. Every version is its own transaction: the row is locked
// (SELECT ... FOR UPDATE) and the status is changed by one UPDATE that still requires `sent` or `approved`. A
// version that finished another way meanwhile (accepted, rejected, revised) is therefore never touched: the lock
// makes the job wait for that transaction, re-read the row and skip it. A second run finds nothing left to do.
// The status history row, the audit event and the owner's bell notice commit with the status change or not at all.
//
// Expiring soon (second pass of every run, after the expiry pass): a version with status `sent` only (a customer
// cannot see an approved one) and valid_until from today to today + 2 days (Kathmandu) gets one K5
// `quotation.expiring` email through `NotifyService.notifyEmail` (the recipient is a customer contact, not a
// user). It goes to the address the quote was sent to: the `to_email` of the `quotation.sent:<versionId>` outbox
// row Send wrote. The version's own contact_id is not used: it is optional and Send may have been given another
// contact. A sent version with no such outbox row is not a candidate and is never emailed. Once per version: the
// dedupe key `quotation.expiring:<versionId>` makes a second insert a no-op, and the candidate query leaves out
// versions whose expiring row already exists, so the hourly runs of the two days do not keep re-reading them. Each
// notice is its own transaction, and the version row is locked FOR SHARE and re-read inside it, so an accept that
// commits first is not emailed.
// The link is the portal path `/quotations/<versionId>` (the portal looks quotations up by version id, and this is
// the sent version the customer was emailed); the template adds PORTAL_PUBLIC_URL, which the worker must have.
//
// The owner is told in the bell only. K5's `quotation.expired` template is customer-facing (it links to the portal
// through PORTAL_PUBLIC_URL and says the customer can no longer accept), so it is not sent to staff, and K5 has no
// staff template for this event. Adding one is a change to platform/notify/templates.ts, which this unit does not own.
//
// The tests drive the sweeper through an ExpiryStore fake; the drizzle store below is checked by the integration
// test against a real database.
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { customers, outbox, quotations, quotationStatusHistory, quotationVersions } from '@bos/db';
import { kathmanduDateString } from '@bos/locale';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Job, Queue } from 'bullmq';
import {
  and,
  asc,
  eq,
  exists,
  gte,
  inArray,
  lt,
  lte,
  notExists,
  sql,
  type SQLWrapper,
} from 'drizzle-orm';

import type { AuditService } from '../../../platform/audit/audit.service';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import { type Actor, systemActor, type TxScope } from '../../../platform/db/tx';
import type { NotifyService } from '../../../platform/notify/notify.service';

export const QUOTATION_EXPIRY_QUEUE = 'quotation.expiry';
export const QUOTATION_EXPIRY_SWEEP_JOB = 'quotation.expiry.sweep';
/** The job name after the `system:` prefix of the actor id; the audit log shows `system:quotation-expiry`. */
export const QUOTATION_EXPIRY_JOB_PREFIX = 'quotation-expiry';
export const EXPIRY_EVERY_MS = 60 * 60_000;
/** Versions handled per run. A larger backlog (the job was down for days) drains over the following hours. */
export const EXPIRY_BATCH = 500;
/** A sent version whose last valid day is within this many days from today gets the expiring-soon email. */
export const EXPIRING_SOON_DAYS = 2;

export const EXPIRY_STORE = Symbol('QUOTATION_EXPIRY_STORE');
export const EXPIRY_TX = Symbol('QUOTATION_EXPIRY_TX');
export const EXPIRY_AUDIT = Symbol('QUOTATION_EXPIRY_AUDIT');
export const EXPIRY_NOTIFY = Symbol('QUOTATION_EXPIRY_NOTIFY');
export const EXPIRY_CLOCK = Symbol('QUOTATION_EXPIRY_CLOCK');

export interface ExpiryCandidate {
  tenantId: string;
  organizationId: string;
  versionId: string;
}

/** What the audit event and the notice need, read inside the transaction that expired the version. */
export interface ExpiredVersion {
  quotationId: string;
  quotationNumber: string;
  /** The staff owner of the quotation; null when it has none, and then nobody is notified. */
  ownerUserId: string | null;
  validUntil: string;
  fromStatus: 'sent' | 'approved';
}

/** What the expiring-soon email needs, read inside the transaction that queues it. */
export interface ExpiringNotice {
  quotationId: string;
  quotationNumber: string;
  customerName: string;
  validUntil: string;
  /** The address the quote was sent to (the to_email of its `quotation.sent` outbox row). */
  toEmail: string;
}

/** The job's database access, as a port. `tx` is the transaction `EXPIRY_TX` opened for the version's scope. */
export interface ExpiryStore {
  /** Sent or approved versions with valid_until before `today` (YYYY-MM-DD), oldest first, across tenants. */
  candidates(today: string, limit: number): Promise<ExpiryCandidate[]>;
  /**
   * Locks the version, then expires it and writes its status history row. Undefined when the version is no
   * longer sent or approved and past its date (it was accepted, rejected or revised meanwhile): nothing is written.
   */
  expire(
    tx: DbTransaction,
    c: ExpiryCandidate,
    today: string,
    now: Date,
  ): Promise<ExpiredVersion | undefined>;
  /**
   * Sent versions with valid_until from `from` to `until` (YYYY-MM-DD, both included) that have a
   * `quotation.sent:<versionId>` outbox row and no expiring-soon email queued yet, soonest first, across tenants.
   */
  expiringCandidates(from: string, until: string, limit: number): Promise<ExpiryCandidate[]>;
  /**
   * Locks the version (shared) and reads what the email needs, the recipient being the to_email of the version's
   * `quotation.sent:<versionId>` outbox row. Undefined when the version is no longer sent or no longer in the window
   * (accepted, rejected or revised meanwhile), or has no such row: nothing to send.
   */
  expiringNotice(
    tx: DbTransaction,
    c: ExpiryCandidate,
    from: string,
    until: string,
  ): Promise<ExpiringNotice | undefined>;
}

export type RunInTx = <T>(
  scope: TxScope,
  actor: Actor,
  fn: (tx: DbTransaction) => Promise<T>,
) => Promise<T>;
export type ExpiryAudit = Pick<AuditService, 'record'>;
export type ExpiryNotify = Pick<NotifyService, 'notifyUser' | 'notifyEmail'>;
export type Clock = () => Date;

export type ExpiryOutcome = 'expired' | 'skipped';
export type NoticeOutcome = 'noticed' | 'skipped';
export interface SweepResult {
  expired: number;
  /** Versions another transaction finished first, from either pass. */
  skipped: number;
  /** Versions whose transaction failed, from either pass. */
  failed: number;
  /** Expiring-soon emails queued. */
  expiring: number;
}

/** A calendar date (YYYY-MM-DD) `days` later (or earlier, when negative). Pure date arithmetic, no time zone. */
export function addDays(day: string, days: number): string {
  const moved = new Date(`${day}T00:00:00.000Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/**
 * Today's calendar date (YYYY-MM-DD) in Asia/Kathmandu, which is UTC+5:45 all year. A quotation valid until
 * today stays valid until Kathmandu midnight, so a version expires when valid_until is before this date.
 */
export function kathmanduToday(now: Date): string {
  return kathmanduDateString(now);
}

@Injectable()
export class QuotationExpirySweeper {
  private readonly logger = new Logger(QuotationExpirySweeper.name);

  constructor(
    @Inject(EXPIRY_STORE) private readonly store: ExpiryStore,
    @Inject(EXPIRY_TX) private readonly runTx: RunInTx,
    @Inject(EXPIRY_AUDIT) private readonly audit: ExpiryAudit,
    @Inject(EXPIRY_NOTIFY) private readonly notify: ExpiryNotify,
    @Inject(EXPIRY_CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * One run over every tenant: the expiry pass, then the expiring-soon pass. A version that fails is logged and
   * left for the next run; the rest go on.
   */
  async sweep(): Promise<SweepResult> {
    const result: SweepResult = { expired: 0, skipped: 0, failed: 0, expiring: 0 };
    const today = kathmanduToday(this.clock());
    const candidates = await this.store.candidates(today, EXPIRY_BATCH);
    for (const c of candidates) {
      try {
        const outcome = await this.expireOne(c, today);
        result[outcome] += 1;
      } catch (error) {
        result.failed += 1;
        // The version id and a fixed word only: an error message can carry customer data.
        this.logger.error(
          `quotation expiry failed: version=${c.versionId} kind=${error instanceof Error ? error.name : 'error'}`,
        );
      }
    }

    const until = addDays(today, EXPIRING_SOON_DAYS);
    const expiring = await this.store.expiringCandidates(today, until, EXPIRY_BATCH);
    for (const c of expiring) {
      try {
        const outcome = await this.noticeOne(c, today, until);
        if (outcome === 'noticed') result.expiring += 1;
        else result.skipped += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.error(
          `quotation expiring notice failed: version=${c.versionId} kind=${error instanceof Error ? error.name : 'error'}`,
        );
      }
    }
    return result;
  }

  /** Queues the expiring-soon email of one version, in its own transaction under the job's system actor. */
  async noticeOne(c: ExpiryCandidate, from: string, until: string): Promise<NoticeOutcome> {
    const scope: TxScope = { tenantId: c.tenantId, organizationId: c.organizationId };
    const actor = systemActor(QUOTATION_EXPIRY_JOB_PREFIX);
    return this.runTx(scope, actor, async (tx) => {
      const n = await this.store.expiringNotice(tx, c, from, until);
      if (n === undefined) return 'skipped';
      await this.notify.notifyEmail(tx, {
        toEmail: n.toEmail,
        template: 'quotation.expiring',
        data: {
          quotationNumber: n.quotationNumber,
          customerName: n.customerName,
          validUntil: n.validUntil,
          // A path, not a URL: renderEmail prefixes PORTAL_PUBLIC_URL and refuses anything else. The portal's
          // `/quotations/:id` is a version id, so the link names the sent version that is about to expire.
          linkPath: `/quotations/${c.versionId}`,
        },
        dedupeKey: `quotation.expiring:${c.versionId}`,
      });
      return 'noticed';
    });
  }

  async expireOne(c: ExpiryCandidate, today: string): Promise<ExpiryOutcome> {
    const scope: TxScope = { tenantId: c.tenantId, organizationId: c.organizationId };
    const actor = systemActor(QUOTATION_EXPIRY_JOB_PREFIX);
    return this.runTx(scope, actor, async (tx) => {
      const expired = await this.store.expire(tx, c, today, this.clock());
      if (expired === undefined) return 'skipped';

      await this.audit.record(tx, {
        action: 'quotation.expired',
        entityType: 'quotation_version',
        entityId: c.versionId,
        meta: {
          quotationId: expired.quotationId,
          from: expired.fromStatus,
          validUntil: expired.validUntil,
        },
      });
      if (expired.ownerUserId !== null) {
        // Bell only (no `email`): see the file header. The dedupe key makes a replayed transaction a no-op.
        await this.notify.notifyUser(tx, {
          userId: expired.ownerUserId,
          title: `Quotation ${expired.quotationNumber} has expired`,
          body: `Quotation ${expired.quotationNumber} was valid until ${expired.validUntil} and can no longer be accepted. Revise it to offer the customer a new validity date.`,
          link: `/quotations/${expired.quotationId}`,
          dedupeKey: `quotation.expired:${c.versionId}`,
        });
      }
      return 'expired';
    });
  }
}

/** The store on the real tables. Every query names the tenant and the acting entity. */
export function drizzleExpiryStore(db: Db): ExpiryStore {
  const ownVersion = (c: ExpiryCandidate) =>
    and(
      eq(quotationVersions.tenantId, c.tenantId),
      eq(quotationVersions.organizationId, c.organizationId),
      eq(quotationVersions.id, c.versionId),
    );
  /** Still sent or approved, and past its last day. */
  const due = (today: string) =>
    and(
      inArray(quotationVersions.status, ['sent', 'approved']),
      lt(quotationVersions.validUntil, today),
    );

  /** The dedupe key Send gave the quote's outbox row (QuotationSendService). */
  const sentKey = (versionId: SQLWrapper) => sql`'quotation.sent:' || ${versionId}::text`;

  /** Sent, and valid from `from` to `until` inclusive. */
  const inWindow = (from: string, until: string) =>
    and(
      eq(quotationVersions.status, 'sent'),
      gte(quotationVersions.validUntil, from),
      lte(quotationVersions.validUntil, until),
    );

  return {
    async candidates(today, limit) {
      return db
        .select({
          tenantId: quotationVersions.tenantId,
          organizationId: quotationVersions.organizationId,
          versionId: quotationVersions.id,
        })
        .from(quotationVersions)
        .where(due(today))
        .orderBy(asc(quotationVersions.validUntil), asc(quotationVersions.id))
        .limit(limit);
    },

    async expire(tx, c, today, now) {
      // The lock is the race guard. Under READ COMMITTED a row another transaction changed (an accept that is
      // committing) is re-checked against `due` once that transaction ends, so an accepted version is not returned.
      const [locked] = await tx
        .select({
          status: quotationVersions.status,
          quotationId: quotationVersions.quotationId,
          validUntil: quotationVersions.validUntil,
        })
        .from(quotationVersions)
        .where(and(ownVersion(c), due(today)))
        .limit(1)
        .for('update');
      if (locked === undefined) return undefined;

      const updated = await tx
        .update(quotationVersions)
        .set({
          status: 'expired',
          expiredAt: now,
          version: sql`${quotationVersions.version} + 1`,
          updatedAt: now,
        })
        // The status is named again so the UPDATE is safe on its own, whatever the lock above did.
        .where(and(ownVersion(c), due(today)))
        .returning({ id: quotationVersions.id });
      if (updated.length !== 1) return undefined;

      const fromStatus = locked.status === 'sent' ? 'sent' : 'approved';
      // actor_id is NULL for the system (see the column's comment in 0016_quotations.sql).
      await tx.insert(quotationStatusHistory).values({
        tenantId: c.tenantId,
        organizationId: c.organizationId,
        versionId: c.versionId,
        fromStatus,
        toStatus: 'expired',
        actorId: null,
        reason: 'valid_until passed',
        at: now,
      });

      const [quotation] = await tx
        .select({ number: quotations.number, ownerUserId: quotations.ownerUserId })
        .from(quotations)
        .where(
          and(
            eq(quotations.tenantId, c.tenantId),
            eq(quotations.organizationId, c.organizationId),
            eq(quotations.id, locked.quotationId),
          ),
        )
        .limit(1);
      if (quotation === undefined) throw new Error('quotation of the expired version not found');

      return {
        quotationId: locked.quotationId,
        quotationNumber: quotation.number,
        ownerUserId: quotation.ownerUserId,
        validUntil: locked.validUntil,
        fromStatus,
      };
    },

    async expiringCandidates(from, until, limit) {
      return db
        .select({
          tenantId: quotationVersions.tenantId,
          organizationId: quotationVersions.organizationId,
          versionId: quotationVersions.id,
        })
        .from(quotationVersions)
        .where(
          and(
            inWindow(from, until),
            // Only versions expiringNotice can send: the quote went out by email (its outbox row exists), and
            // the notice is not queued yet. The others would be re-read every hour of the window for nothing.
            exists(
              db
                .select({ one: sql`1` })
                .from(outbox)
                .where(
                  and(
                    eq(outbox.tenantId, quotationVersions.tenantId),
                    sql`${outbox.dedupeKey} = ${sentKey(quotationVersions.id)}`,
                  ),
                ),
            ),
            notExists(
              db
                .select({ one: sql`1` })
                .from(outbox)
                .where(
                  and(
                    eq(outbox.tenantId, quotationVersions.tenantId),
                    sql`${outbox.dedupeKey} = 'quotation.expiring:' || ${quotationVersions.id}::text`,
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(quotationVersions.validUntil), asc(quotationVersions.id))
        .limit(limit);
    },

    async expiringNotice(tx, c, from, until) {
      // Shared lock on the version, in a select of its own on that one table. A lock with a table target on the
      // joined read below would not work: drizzle renders it as FOR SHARE OF "app"."quotation_versions" and
      // Postgres refuses a schema-qualified name there (no-locking-of.test.ts guards this). An accept waits for
      // this transaction, or has committed first and the WHERE no longer matches.
      const [locked] = await tx
        .select({ id: quotationVersions.id })
        .from(quotationVersions)
        .where(and(ownVersion(c), inWindow(from, until)))
        .limit(1)
        .for('share');
      if (locked === undefined) return undefined;

      const [row] = await tx
        .select({
          quotationId: quotations.id,
          quotationNumber: quotations.number,
          validUntil: quotationVersions.validUntil,
          customerName: customers.legalName,
          toEmail: outbox.toEmail,
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
        // The recipient is the address the quote went to: the to_email of the outbox row Send wrote for this
        // version (unique per tenant and key). Not the version's contact_id, which is optional and may differ.
        .innerJoin(
          outbox,
          and(
            eq(outbox.tenantId, quotationVersions.tenantId),
            sql`${outbox.dedupeKey} = ${sentKey(quotationVersions.id)}`,
          ),
        )
        .leftJoin(
          customers,
          and(
            eq(customers.tenantId, quotations.tenantId),
            eq(customers.id, quotations.customerPartyId),
          ),
        )
        .where(and(ownVersion(c), inWindow(from, until)))
        .limit(1);
      if (row === undefined) return undefined;
      return {
        quotationId: row.quotationId,
        quotationNumber: row.quotationNumber,
        customerName: row.customerName ?? '',
        validUntil: row.validUntil,
        toEmail: row.toEmail,
      };
    },
  };
}

@Processor(QUOTATION_EXPIRY_QUEUE)
export class QuotationExpiryProcessor extends WorkerHost {
  constructor(private readonly sweeper: QuotationExpirySweeper) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === QUOTATION_EXPIRY_SWEEP_JOB) {
      await this.sweeper.sweep();
      return;
    }
    // A job name nobody handles is a bug; failing keeps it visible instead of silently dropping it.
    throw new Error(`Unknown quotation expiry job: ${job.name}`);
  }
}

/** Registers the hourly sweep. upsertJobScheduler is idempotent, so restarts never stack schedules. */
@Injectable()
export class QuotationExpiryScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(QUOTATION_EXPIRY_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      QUOTATION_EXPIRY_SWEEP_JOB,
      { every: EXPIRY_EVERY_MS },
      { name: QUOTATION_EXPIRY_SWEEP_JOB, opts: { removeOnComplete: 5, removeOnFail: 20 } },
    );
  }
}
