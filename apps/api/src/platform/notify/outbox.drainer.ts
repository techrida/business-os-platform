// Sends the emails waiting in app.outbox. Serves the Reliability NFR (Non-Functional Requirement: a
// measurable quality target): an email is retried on a schedule, never sent twice by two workers, and an
// email that runs out of retries becomes a visible "dead letter" (log + metric + notice to the founder)
// instead of silently disappearing.
//
// One call to drainOnce() is one pass:
//   1. reclaim   rows stuck in `sending` by a crashed drainer go back to `pending` (or `dead`);
//   2. claim     lock up to 20 due rows and mark them `sending` (FOR UPDATE SKIP LOCKED);
//   3. send      each claimed row through the EmailProvider, OUTSIDE any transaction;
//   4. update    each row in its own small transaction: `sent`, back to `pending` with a backoff, or `dead`.
//                only if this worker still holds the claim (see claimGuard); otherwise the update is skipped.
// The claim commits before any email is sent, so the row lock is never held across a slow SMTP call.
import { Logger } from '@nestjs/common';
import { outbox } from '@bos/db';
import { type SQL, and, eq, sql } from 'drizzle-orm';

import { type Db, type DbTransaction, inTransaction } from '../db/db.module';
import { UNAUDITED_WRITE, systemActor, type TxOptions, withTx } from '../db/tx';
import { type EmailProvider, redactError } from './email.provider';
import { type DeadLetterMetric } from './notify-metrics';

/** Injection token for the clock, so a test can move time without sleeping. */
export const OUTBOX_CLOCK = Symbol('OUTBOX_CLOCK');
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** The fifth failure makes the row `dead`. */
export const MAX_ATTEMPTS = 5;

/**
 * Minutes to wait after failure n (index n-1) before the next try: 1, 5, 10, 20 min. The fifth failure
 * does not wait, it kills the row, so the 24 is unused at MAX_ATTEMPTS = 5. It is kept so that moving to
 * 6 attempts (60 min of retrying in total) is a one-constant change: raise MAX_ATTEMPTS and nothing else.
 */
export const BACKOFF_MIN = [1, 5, 10, 20, 24] as const;

/** Minutes to wait after failure number `failures` (1-based). Never runs past the end of the table. */
function backoffMinutes(failures: number): number {
  return BACKOFF_MIN[Math.min(failures, BACKOFF_MIN.length) - 1] ?? BACKOFF_MIN[0];
}

/** A `sending` row older than this belongs to a drainer that crashed (a normal send takes seconds). */
export const STALE_CLAIM_MIN = 10;

/** Rows per pass: small enough that one pass finishes well inside the 5 s schedule when SMTP is healthy. */
export const CLAIM_BATCH = 20;

const SYSTEM_JOB = 'outbox';
const DEAD_LETTER_TEMPLATE = 'outbox.dead_letter';

/**
 * The part of NotifyService (U5b) that the drainer uses. Typed structurally so this file does not depend
 * on the shape of notify.service.ts; the real NotifyService is assignable to it.
 */
export interface DeadLetterNotifier {
  notifyRole(
    tx: DbTransaction,
    role: 'founder',
    n: {
      title: string;
      body: string;
      link: string;
      email: { template: 'outbox.dead_letter'; vars: Record<string, string> };
      dedupeKey: string;
    },
  ): Promise<void>;
}

export interface DrainResult {
  /** Rows locked by this pass. */
  claimed: number;
  sent: number;
  /** Send attempts that failed, including the ones that turned the row dead. */
  failed: number;
  /** Rows that became dead in this pass (a failed fifth send, or a reclaimed stale row out of attempts). */
  dead: number;
}

type ClaimedRow = {
  id: string;
  tenant_id: string;
  organization_id: string;
  template: string;
  to_email: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  attempts: number;
  resend_count: number;
};

type ReclaimedRow = {
  id: string;
  tenant_id: string;
  organization_id: string;
  template: string;
  attempts: number;
  resend_count: number;
  status: string;
};

type DeadRef = {
  id: string;
  tenantId: string;
  organizationId: string;
  template: string;
  attempts: number;
  /** How many times the row was resent from the delivery log: each resend cycle gets its own notice. */
  resendCount: number;
  /** The claim time this worker wrote in step 2. Absent for a reclaimed row, which is not ours to update. */
  claimedAt?: Date;
};

/**
 * The WHERE clause of every update that follows a send. The claim token is the pair (attempts, claimed_at)
 * and the row must still be `sending`: attempts goes up on every claim and a reclaim clears claimed_at, so
 * once another worker has reclaimed the row the pair no longer matches and this worker's late result
 * updates nothing. That also means a `sent` or `dead` row can never be moved back to retry. app.outbox has
 * no claim-token column; a dedicated token would be stricter, but this pair already differs per claim.
 */
function claimGuard(ref: DeadRef): SQL {
  if (ref.claimedAt === undefined) throw new Error(`outbox row ${ref.id} has no claim to guard`);
  return and(
    eq(outbox.id, ref.id),
    eq(outbox.status, 'sending'),
    eq(outbox.attempts, ref.attempts),
    eq(outbox.claimedAt, ref.claimedAt),
  ) as SQL;
}

export class OutboxDrainer {
  private readonly logger = new Logger(OutboxDrainer.name);

  constructor(
    private readonly db: Db,
    private readonly provider: EmailProvider,
    private readonly clock: Clock,
    private readonly metrics: DeadLetterMetric,
    /** Optional so a test (or a deployment with no notify service) can run the drainer alone. */
    private readonly notify?: DeadLetterNotifier,
  ) {}

  async drainOnce(): Promise<DrainResult> {
    const now = this.clock();

    // No bos.* settings here: app.outbox has no audit trigger (it is rewritten on every retry), so this
    // transaction needs no actor.
    const { claimed, reclaimedDead } = await inTransaction(this.db, async (tx) => {
      // Step 1, reclaim. A row can sit in `sending` only while a drainer holds it, and that is seconds.
      // An old claimed_at means the drainer crashed between the claim and the update, so the row would
      // otherwise stay `sending` forever. attempts was already counted at claim time, so a row that
      // crashed its last allowed attempt goes dead rather than getting a sixth.
      const reclaimed = await tx.execute<ReclaimedRow>(sql`
        UPDATE app.outbox
        SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'dead' ELSE 'pending' END,
            claimed_at = NULL,
            last_error = CASE WHEN attempts >= ${MAX_ATTEMPTS}
              THEN 'drainer stopped while sending, no attempts left' ELSE last_error END
        WHERE status = 'sending'
          AND claimed_at < ${now.toISOString()}::timestamptz - (${STALE_CLAIM_MIN}::int * interval '1 minute')
        RETURNING id, tenant_id, organization_id, template, attempts, resend_count, status`);

      // Step 2, claim. SKIP LOCKED makes a second drainer pass over rows the first one has locked, so each
      // due row is handed to exactly one of them.
      const claimedRows = await tx.execute<ClaimedRow>(sql`
        UPDATE app.outbox
        SET status = 'sending', claimed_at = ${now.toISOString()}::timestamptz, attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM app.outbox
          WHERE status = 'pending' AND next_attempt_at <= ${now.toISOString()}::timestamptz
          ORDER BY next_attempt_at
          LIMIT ${CLAIM_BATCH}
          FOR UPDATE SKIP LOCKED)
        RETURNING id, tenant_id, organization_id, template, to_email, subject, body_text, body_html, attempts,
                  resend_count`);

      return {
        claimed: claimedRows.rows,
        reclaimedDead: reclaimed.rows.filter((r) => r.status === 'dead'),
      };
    });

    const result: DrainResult = { claimed: claimed.length, sent: 0, failed: 0, dead: 0 };

    // The status change to `dead` is already committed above; what is left is the notice and the metric.
    for (const r of reclaimedDead) {
      const ref: DeadRef = {
        id: r.id,
        tenantId: r.tenant_id,
        organizationId: r.organization_id,
        template: r.template,
        attempts: r.attempts,
        resendCount: r.resend_count,
      };
      if (await this.settle(ref, () => this.announceDead(ref, undefined))) result.dead += 1;
    }

    // Step 3 and 4, one row at a time. A slow or failing row never stops the rows behind it, and a
    // database error on one row's update is logged and left for the reclaim step instead of aborting.
    for (const row of claimed) {
      const ref: DeadRef = {
        id: row.id,
        tenantId: row.tenant_id,
        organizationId: row.organization_id,
        template: row.template,
        attempts: row.attempts,
        resendCount: row.resend_count,
        claimedAt: now,
      };
      let outcome: { providerMessageId: string } | { error: string };
      try {
        const info = await this.provider.send({
          to: row.to_email,
          subject: row.subject,
          text: row.body_text,
          ...(row.body_html === null ? {} : { html: row.body_html }),
        });
        outcome = { providerMessageId: info.providerMessageId };
      } catch (err) {
        // The provider already redacts its errors; redact again because a fake or a future provider may not.
        outcome = { error: redactError(err) };
      }

      if ('providerMessageId' in outcome) {
        const messageId = outcome.providerMessageId;
        const ok = await this.settle(ref, () =>
          this.inRowTx(
            ref,
            async (tx) => {
              const updated = await tx
                .update(outbox)
                .set({
                  status: 'sent',
                  providerMessageId: messageId,
                  sentAt: this.clock(),
                  claimedAt: null,
                  lastError: null,
                })
                .where(claimGuard(ref))
                .returning({ id: outbox.id });
              return updated.length > 0;
            },
            UNAUDITED_WRITE,
          ),
        );
        if (ok) result.sent += 1;
        continue;
      }

      result.failed += 1;
      const error = outcome.error;
      if (row.attempts >= MAX_ATTEMPTS) {
        const ok = await this.settle(ref, () => this.announceDead(ref, error));
        if (ok) result.dead += 1;
      } else {
        // After failure n the next try is BACKOFF_MIN[n - 1] minutes away.
        const nextAttemptAt = new Date(
          this.clock().getTime() + backoffMinutes(row.attempts) * 60_000,
        );
        await this.settle(ref, () =>
          this.inRowTx(
            ref,
            async (tx) => {
              const updated = await tx
                .update(outbox)
                .set({ status: 'pending', nextAttemptAt, claimedAt: null, lastError: error })
                .where(claimGuard(ref))
                .returning({ id: outbox.id });
              return updated.length > 0;
            },
            UNAUDITED_WRITE,
          ),
        );
      }
    }

    return result;
  }

  /** The write for one row runs as the system actor, scoped to that row's tenant and organization. */
  private inRowTx<T>(
    ref: DeadRef,
    fn: (tx: DbTransaction) => Promise<T>,
    options?: TxOptions,
  ): Promise<T> {
    return withTx(
      this.db,
      { tenantId: ref.tenantId, organizationId: ref.organizationId },
      systemActor(SYSTEM_JOB),
      fn,
      options,
    );
  }

  /**
   * Marks a row dead (when `lastError` is given; a reclaimed row is already dead) and tells the founder.
   * Both happen in one transaction, so a committed `dead` row always has its notice. The log line and the
   * metric come after the commit, so a rollback never counts a dead letter that did not happen.
   * Returns false, with no notice and no metric, when this worker no longer holds the claim: whoever took
   * the row over owns its outcome (and its dead-letter notice).
   */
  private async announceDead(ref: DeadRef, lastError: string | undefined): Promise<boolean> {
    const held = await this.inRowTx(ref, async (tx) => {
      if (lastError !== undefined) {
        const updated = await tx
          .update(outbox)
          .set({ status: 'dead', claimedAt: null, lastError })
          .where(claimGuard(ref))
          .returning({ id: outbox.id });
        if (updated.length === 0) return false;
      }
      await this.notifyFounder(tx, ref);
      return true;
    });
    if (!held) return false;
    // The row id and the template identify the email. The address and the error text stay out of the log.
    this.logger.error(`outbox row ${ref.id} is dead (template ${ref.template})`);
    this.metrics.recordDeadLetter();
    return true;
  }

  private async notifyFounder(tx: DbTransaction, ref: DeadRef): Promise<void> {
    // Loop guard: if the dead-letter email itself dies, notifying the founder would queue another
    // dead-letter email that can die the same way, forever. Log only.
    if (ref.template === DEAD_LETTER_TEMPLATE || this.notify === undefined) return;
    try {
      // A savepoint (nested transaction): if the notice fails, only the notice rolls back and the row
      // still becomes `dead`. A dead row without a notice is better than a row that can never settle.
      await tx.transaction(async (sp) => {
        await this.notify?.notifyRole(sp, 'founder', {
          title: 'Email could not be delivered',
          body: `An "${ref.template}" email failed ${ref.attempts} times and was dropped.`,
          // The delivery log, where the Founder can resend it.
          link: '/settings/email-delivery',
          // No last_error here: an email is read outside our control, and errors can quote hosts.
          email: {
            template: DEAD_LETTER_TEMPLATE,
            vars: { failedTemplate: ref.template, attempts: String(ref.attempts) },
          },
          // A resent email that dies again needs a new notice: the first one's key is already used.
          dedupeKey:
            ref.resendCount === 0
              ? `dead-letter:${ref.id}`
              : `dead-letter:${ref.id}:resend-${ref.resendCount}`,
        });
      });
    } catch (err) {
      this.logger.error(
        `could not notify the founder about dead outbox row ${ref.id}: ${redactError(err)}`,
      );
    }
  }

  /**
   * Runs one row's update; a failure is logged and the pass goes on. `fn` returns false when the update
   * matched no row because the claim was lost; that is logged and nothing is overwritten. Returns whether
   * the row was updated.
   */
  private async settle(ref: DeadRef, fn: () => Promise<boolean>): Promise<boolean> {
    try {
      if (await fn()) return true;
      this.logger.warn(`outbox row ${ref.id} was claimed by another worker, its result is dropped`);
      return false;
    } catch (err) {
      this.logger.error(`could not update outbox row ${ref.id}: ${redactError(err)}`);
      return false;
    }
  }
}
