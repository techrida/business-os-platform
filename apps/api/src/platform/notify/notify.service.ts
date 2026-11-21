// Notifications: the in-app bell (app.notifications) and the email outbox (app.outbox), plus the
// "nudge" that wakes the drainer. Serves the Reliability NFR (Non-Functional Requirement: a measurable
// quality target): a business change and its notices commit together, so a rolled-back change sends
// nothing and a committed one can never lose its email.
//
// How a caller uses it (the order matters):
//
//   await withTx(db, scope, actor, async (tx) => {
//     await doBusinessChange(tx);
//     await notify.notifyUser(tx, { userId, title, body, link, email, dedupeKey });
//   });
//   await notify.nudge(); // AFTER the commit, never inside the callback
//
// Why nudge after the commit: the drainer runs in another process on its own connection. A job that
// arrives before COMMIT finds no row, does nothing, and the email waits for the next 5 s repeat. A job
// queued for a transaction that then rolls back is harmless but pointless. nudge() only makes delivery
// quick; the repeatable drain job is the backstop, so a failed nudge loses nothing.
import type { NotificationDto, RoleKey } from '@bos/contracts';
import { notifications, outbox, scoped } from '@bos/db';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';

import { UserDirectory } from '../authz/user-directory';
import { principal } from '../authz/principal';
import { CoreConfig } from '../config/config';
import { DB, type Db, type DbTransaction } from '../db/db.module';
import { type TxScope, requestTx, withTx } from '../db/tx';
import { nudgeWithin } from '../queue/nudge-timeout';
import { ctx } from '../tenancy/request-context';
import { OUTBOX_DRAIN_JOB, OUTBOX_QUEUE } from './notify.constants';
import { type EmailTemplate, renderEmail } from './templates';

export interface NotifyInput {
  userId: string;
  title: string;
  body: string;
  /** A workspace path such as /inbox/<id>, never an absolute URL. */
  link: string;
  /** Also email the user. `vars` follow EMAIL_TEMPLATE_VARS; `linkPath` must be under /inbox/ or /memos/. */
  email?: { template: EmailTemplate; vars: Record<string, string> };
  /** Names the event (for example `approval.pending:<requestId>`) so a retried action notifies nobody twice. */
  dedupeKey: string;
}

/**
 * An email to an address that is not a user, such as a customer contact (customer contacts are not users,
 * so notifyUser cannot resolve them). No bell row: there is no workspace user to show it to.
 */
export interface NotifyEmailInput {
  toEmail: string;
  template: EmailTemplate;
  /** Follow EMAIL_TEMPLATE_VARS; `linkPath` must be under one of the template's own areas. */
  data: Record<string, string>;
  /** Names the event (for example `quotation.sent:<versionId>`): a retried action queues no second email. */
  dedupeKey: string;
}

@Injectable()
export class NotifyService {
  private readonly log = new Logger(NotifyService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: CoreConfig,
    private readonly users: UserDirectory,
    @InjectQueue(OUTBOX_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Writes the bell row and, when `n.email` is set, the outbox row, both inside the caller's `tx`.
   * The scope comes from the transaction (set by withTx), never from a request: the worker calls this too.
   */
  async notifyUser(tx: DbTransaction, n: NotifyInput): Promise<void> {
    const scope = await scopeOf(tx);

    // DO NOTHING on the unique (tenant, user, dedupe_key): a retried business action is a no-op here.
    await tx
      .insert(notifications)
      .values({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        userId: n.userId,
        title: n.title,
        body: n.body,
        link: n.link,
        dedupeKey: n.dedupeKey,
      })
      .onConflictDoNothing({
        target: [notifications.tenantId, notifications.userId, notifications.dedupeKey],
      });

    if (n.email === undefined) return;

    // On `tx`, not the pool: a second pooled connection while the transaction holds one can stall the pool.
    const to = await this.users.emailOf(n.userId, tx);
    if (!to?.trim()) {
      this.log.warn({
        event: 'notify.email_skipped',
        reason: 'no_email_address',
        template: n.email.template,
      });
      return;
    }

    // Rendered here, not in the drainer: a forbidden variable or a bad link path is a bug in the caller
    // and should fail the caller's transaction, not die quietly in a background job.
    const rendered = renderEmail(n.email.template, n.email.vars, {
      workspaceUrl: this.config.WORKSPACE_PUBLIC_URL,
      portalUrl: this.config.PORTAL_PUBLIC_URL,
    });

    await tx
      .insert(outbox)
      .values({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        kind: 'email',
        template: n.email.template,
        toUserId: n.userId,
        toEmail: to,
        subject: rendered.subject,
        bodyText: rendered.text,
        bodyHtml: rendered.html,
        // Per recipient: one event that notifies three users makes three rows.
        dedupeKey: `${n.dedupeKey}:${n.userId}`,
      })
      .onConflictDoNothing({ target: [outbox.tenantId, outbox.dedupeKey] });
  }

  /**
   * Writes one outbox row to `n.toEmail` inside the caller's `tx`, rendered now (a bad variable or link fails
   * the caller's transaction, as in notifyUser). The scope comes from the transaction, never from a request.
   */
  async notifyEmail(tx: DbTransaction, n: NotifyEmailInput): Promise<void> {
    const scope = await scopeOf(tx);
    const rendered = renderEmail(n.template, n.data, {
      workspaceUrl: this.config.WORKSPACE_PUBLIC_URL,
      portalUrl: this.config.PORTAL_PUBLIC_URL,
    });
    await tx
      .insert(outbox)
      .values({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        kind: 'email',
        template: n.template,
        toUserId: null,
        toEmail: n.toEmail,
        subject: rendered.subject,
        bodyText: rendered.text,
        bodyHtml: rendered.html,
        dedupeKey: n.dedupeKey,
      })
      .onConflictDoNothing({ target: [outbox.tenantId, outbox.dedupeKey] });
  }

  /** Notifies every active user holding `role` in the transaction's scope (same input for each). */
  async notifyRole(
    tx: DbTransaction,
    role: RoleKey,
    n: Omit<NotifyInput, 'userId'>,
  ): Promise<void> {
    const scope = await scopeOf(tx);
    const userIds = await this.users.userIdsWithRole(scope, role, tx);
    // One after another: a drizzle transaction is a single connection, so there is nothing to gain from Promise.all.
    for (const userId of userIds) {
      await this.notifyUser(tx, { ...n, userId });
    }
  }

  /**
   * Asks the drainer to run now. Call it after the commit (see the file header). Never throws: the
   * 5 s repeatable drain is the backstop, so a Valkey outage here must not fail a request whose
   * business change already committed. It also stops waiting after NUDGE_TIMEOUT_MS: with Valkey down `queue.add`
   * would otherwise hang on its offline queue, and the request with it.
   */
  async nudge(): Promise<void> {
    await nudgeWithin(
      this.log,
      'outbox nudge',
      () =>
        this.queue.add(
          OUTBOX_DRAIN_JOB,
          {},
          {
            // One job per second: several commits in the same second share it instead of piling up jobs.
            jobId: `${OUTBOX_DRAIN_JOB}-${Math.floor(Date.now() / 1000)}`,
            removeOnComplete: true,
            removeOnFail: true,
          },
        ),
      (error) =>
        this.log.warn(
          `outbox nudge failed, the 5 s drain will pick it up: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }

  /** The caller's notifications, newest first. `beforeId` is the id of the last item of the previous page. */
  async listMine(limit: number, beforeId?: string): Promise<NotificationDto[]> {
    const { tenantId, organizationId } = ctx();
    const userId = principal().userId;
    const s = scoped({ tenantId, organizationId });

    const mine = eq(notifications.userId, userId);
    // Page by (created_at, id), not by id alone: ids are random uuids, so they say nothing about order.
    // An unknown or foreign id makes the subquery NULL and the page empty, which confirms nothing.
    const page =
      beforeId === undefined
        ? mine
        : and(
            mine,
            sql`(${notifications.createdAt}, ${notifications.id}) < (
              SELECT b.created_at, b.id FROM app.notifications b
               WHERE b.id = ${beforeId} AND b.tenant_id = ${tenantId} AND b.user_id = ${userId})`,
          );

    const rows = await this.db
      .select()
      .from(notifications)
      .where(s.where(notifications, page))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      link: r.link,
      readAt: r.readAt === null ? null : r.readAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async unreadCount(): Promise<number> {
    const { tenantId, organizationId } = ctx();
    const s = scoped({ tenantId, organizationId });
    const rows = await this.db
      .select({ n: count() })
      .from(notifications)
      .where(
        s.where(
          notifications,
          and(eq(notifications.userId, principal().userId), isNull(notifications.readAt)),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  /**
   * Marks one of the caller's notifications read; reading it again is fine (the first read time stays).
   * Someone else's id, or an unknown one, is a 404 and changes nothing, so an id is never confirmed
   * to exist for another user.
   */
  async markRead(id: string): Promise<void> {
    const { scope, actor } = requestTx();
    const s = scoped(scope);
    const updated = await withTx(this.db, scope, actor, (tx) =>
      tx
        .update(notifications)
        .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
        .where(
          s.where(
            notifications,
            and(eq(notifications.id, id), eq(notifications.userId, principal().userId)),
          ),
        )
        .returning({ id: notifications.id }),
    );
    if (updated.length === 0) throw new NotFoundException('Notification not found');
  }
}

/** The scope withTx set on this transaction. Empty means the transaction was not opened with withTx. */
async function scopeOf(tx: DbTransaction): Promise<TxScope> {
  const result = await tx.execute<{ tenant_id: string | null; organization_id: string | null }>(
    sql`SELECT current_setting('bos.tenant_id', true) AS tenant_id,
               current_setting('bos.organization_id', true) AS organization_id`,
  );
  const tenantId = result.rows[0]?.tenant_id;
  const organizationId = result.rows[0]?.organization_id;
  // Unset gives NULL; a setting that was set and then reverted at COMMIT gives ''.
  if (!tenantId || !organizationId) {
    throw new Error(
      'NotifyService needs a transaction opened with withTx: bos.tenant_id and bos.organization_id are not set',
    );
  }
  return { tenantId, organizationId };
}
