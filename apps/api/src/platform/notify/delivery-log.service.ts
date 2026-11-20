// The email delivery log behind Settings > Email delivery (F1-Q15): list what the outbox sent or failed to send,
// and put a failed or bounced email back in the queue. Serves the Reliability NFR: an email that ran out of
// retries is no longer silently lost, because an admin can see it and send it again.
//
// app.outbox has no row-level security (the drainer reads it across tenants), so every query here names the
// caller's tenant and organization itself (scoped()). Another tenant's id answers 404, never 403.
//
// Resend re-queues the same row; it never inserts a copy, because the (tenant, dedupe_key) unique key exists
// so one event sends one email. The row lock (FOR UPDATE) plus the eligibility check make a double click safe:
// the second request waits for the first, then finds the row `pending` and changes nothing.
import type {
  EmailDeliveryDto,
  EmailDeliveryFilter,
  EmailDeliveryPage,
  EmailDeliveryState,
  EmailResendResult,
} from '@bos/contracts';
import { outbox, scoped } from '@bos/db';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type SQL, and, desc, eq, or, sql } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service';
import { DB, type Db } from '../db/db.module';
import { requestTx, withTx } from '../db/tx';
import { ctx } from '../tenancy/request-context';
import { NotifyService } from './notify.service';

/** What the bounce webhook writes into last_error on the row that bounced (bounce.store.ts). */
const BOUNCED_PREFIX = 'bounced (';
/** What the bounce webhook writes on rows it stopped because their recipient hard-bounced. */
/** A soft bounce is not resendable: the mail server may still deliver it, and a resend would send a second copy. */
const HARD_BOUNCE = 'bounced (hard)';
const RECIPIENT_BOUNCED = 'recipient bounced';

type OutboxStatus = (typeof outbox.$inferSelect)['status'];

/** A row an admin may resend: out of retries, or sent and then hard-bounced. */
function resendable(status: OutboxStatus, lastError: string | null): boolean {
  if (status === 'dead') return true;
  return status === 'sent' && lastError === HARD_BOUNCE;
}

/** The same rule as `resendable`, as SQL for the list filter. */
const RESENDABLE_SQL: SQL = or(
  eq(outbox.status, 'dead'),
  and(eq(outbox.status, 'sent'), eq(outbox.lastError, HARD_BOUNCE)),
) as SQL;

function stateOf(status: OutboxStatus, lastError: string | null): EmailDeliveryState {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'sending':
      return 'sending';
    case 'sent':
      return lastError?.startsWith(BOUNCED_PREFIX) ? 'bounced' : 'delivered';
    case 'dead':
      return lastError === RECIPIENT_BOUNCED ? 'bounced' : 'failed';
  }
}

export interface DeliveryListQuery {
  filter: EmailDeliveryFilter;
  limit: number;
  /** The id of the last row of the previous page. */
  before?: string | undefined;
}

@Injectable()
export class DeliveryLogService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  /** The caller's tenant and organization emails, newest first. */
  async list(q: DeliveryListQuery): Promise<EmailDeliveryPage> {
    const { tenantId, organizationId } = ctx();
    const s = scoped({ tenantId, organizationId });

    const conditions: SQL[] = [];
    if (q.filter === 'failed') conditions.push(RESENDABLE_SQL);
    // Page by (created_at, id): ids are random. An unknown or foreign id makes the subquery NULL and the
    // page empty, which confirms nothing about another tenant's rows.
    if (q.before !== undefined) {
      conditions.push(sql`(${outbox.createdAt}, ${outbox.id}) < (
        SELECT b.created_at, b.id FROM app.outbox b
         WHERE b.id = ${q.before} AND b.tenant_id = ${tenantId} AND b.organization_id = ${organizationId})`);
    }

    const rows = await this.db
      .select({
        id: outbox.id,
        template: outbox.template,
        toEmail: outbox.toEmail,
        subject: outbox.subject,
        status: outbox.status,
        attempts: outbox.attempts,
        resendCount: outbox.resendCount,
        lastError: outbox.lastError,
        createdAt: outbox.createdAt,
        sentAt: outbox.sentAt,
      })
      .from(outbox)
      .where(s.where(outbox, conditions.length === 0 ? undefined : and(...conditions)))
      .orderBy(desc(outbox.createdAt), desc(outbox.id))
      // One extra row says whether an older page exists.
      .limit(q.limit + 1);

    const page = rows.slice(0, q.limit);
    const items: EmailDeliveryDto[] = page.map((r) => ({
      id: r.id,
      template: r.template,
      recipient: r.toEmail,
      subject: r.subject,
      state: stateOf(r.status, r.lastError),
      attempts: r.attempts,
      resendCount: r.resendCount,
      lastError: r.lastError,
      createdAt: r.createdAt.toISOString(),
      sentAt: r.sentAt === null ? null : r.sentAt.toISOString(),
      canResend: resendable(r.status, r.lastError),
    }));
    const last = page.at(-1);
    return { items, nextBefore: rows.length > q.limit && last !== undefined ? last.id : null };
  }

  /**
   * Puts a failed or bounced email back in the queue with a fresh set of attempts, records who did it, and
   * wakes the drainer after the commit. A row that is already waiting or sending is left alone and answers
   * `already_queued`; a delivered row is refused (409), so a stale page can never send a second copy.
   */
  async resend(id: string): Promise<EmailResendResult> {
    const { scope, actor } = requestTx();
    const s = scoped(scope);

    const outcome = await withTx(this.db, scope, actor, async (tx) => {
      const [row] = await tx
        .select({
          status: outbox.status,
          attempts: outbox.attempts,
          resendCount: outbox.resendCount,
          lastError: outbox.lastError,
          template: outbox.template,
        })
        .from(outbox)
        .where(s.where(outbox, eq(outbox.id, id)))
        .for('update');
      if (row === undefined) throw new NotFoundException('Email not found');

      if (row.status === 'pending' || row.status === 'sending') return 'already_queued' as const;
      if (!resendable(row.status, row.lastError)) {
        throw new ConflictException('This email was delivered, so it cannot be sent again.');
      }

      const resendCount = row.resendCount + 1;
      // provider_message_id and sent_at are cleared too: a late bounce for the old message must not mark
      // the new attempt (the bounce webhook matches on the message id alone).
      await tx
        .update(outbox)
        .set({
          status: 'pending',
          attempts: 0,
          nextAttemptAt: sql`now()`,
          claimedAt: null,
          lastError: null,
          providerMessageId: null,
          sentAt: null,
          resendCount,
        })
        .where(s.where(outbox, eq(outbox.id, id)));

      // The address and the error text stay out of the audit trail, as they stay out of the drainer's logs.
      await this.audit.record(tx, {
        action: 'notify.email.resent',
        entityType: 'outbox',
        entityId: id,
        before: {
          state: stateOf(row.status, row.lastError),
          attempts: row.attempts,
          resendCount: row.resendCount,
        },
        after: { state: 'queued', attempts: 0, resendCount },
        meta: { template: row.template },
      });
      return 'queued' as const;
    });

    if (outcome === 'queued') await this.notify.nudge();
    return { outcome };
  }
}
