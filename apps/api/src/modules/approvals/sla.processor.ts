// The approvals SLA tick (worker only): every 5 minutes it finds active steps whose reminder or
// escalation time has passed, sends one reminder to the step's approvers and, later, one escalation to
// the frozen spec's sla.escalateTo role. It never reassigns a step: escalation tells someone senior,
// it does not move the decision. Serves the NFR "approvals do not stall silently" and stays auditable
// (each reminder and escalation is an approval_actions row plus an audit event).
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { approvalRequests, approvalSteps } from '@bos/db';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Job, Queue } from 'bullmq';
import { and, eq, isNull, lte, or } from 'drizzle-orm';

import { DB, type Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { APPROVALS_CLOCK, ApprovalsAudit, ApprovalsNotify, type Clock } from './ports';
import { ApprovalsService, stepSpecOf } from './requests.service';

export const APPROVALS_QUEUE = 'approvals';
export const SLA_JOB = 'approvals.sla';
export const SLA_EVERY_MS = 5 * 60_000;
/** Steps handled per tick; the rest wait 5 minutes. Keeps one tick's transactions short. */
const BATCH = 200;

const due = (now: Date) =>
  or(
    and(lte(approvalSteps.remindAt, now), isNull(approvalSteps.remindedAt)),
    and(lte(approvalSteps.escalateAt, now), isNull(approvalSteps.escalatedAt)),
  );

@Injectable()
export class ApprovalsSlaService {
  private readonly logger = new Logger(ApprovalsSlaService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly approvals: ApprovalsService,
    private readonly audit: ApprovalsAudit,
    private readonly notify: ApprovalsNotify,
    @Inject(APPROVALS_CLOCK) private readonly clock: Clock,
  ) {}

  /** One pass over every tenant. Each step gets its own transaction under the system actor. */
  async tick(now: Date = this.clock()): Promise<{ reminded: number; escalated: number }> {
    const candidates = await this.db
      .select({
        stepId: approvalSteps.id,
        requestId: approvalSteps.requestId,
        tenantId: approvalSteps.tenantId,
        organizationId: approvalSteps.organizationId,
      })
      .from(approvalSteps)
      .innerJoin(approvalRequests, eq(approvalRequests.id, approvalSteps.requestId))
      .where(
        and(eq(approvalSteps.status, 'active'), eq(approvalRequests.status, 'pending'), due(now)),
      )
      .limit(BATCH);

    let reminded = 0;
    let escalated = 0;
    for (const c of candidates) {
      const scope = { tenantId: c.tenantId, organizationId: c.organizationId };
      let done: { remind: boolean; escalate: boolean };
      try {
        done = await this.handle(c, scope, now);
      } catch (error) {
        // One bad step (a broken spec, a failing notify) must not stall the rest of the batch; its
        // transaction rolled back, so it is due again and retried on the next tick.
        this.logger.error(
          `SLA tick: step ${c.stepId} of request ${c.requestId} failed: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
        continue;
      }
      if (done.remind) reminded += 1;
      if (done.escalate) escalated += 1;
    }
    if (reminded + escalated > 0)
      this.logger.log(`SLA tick: ${reminded} reminded, ${escalated} escalated`);
    return { reminded, escalated };
  }

  /** One candidate step, in its own transaction under the system actor. */
  private handle(
    c: { stepId: string; requestId: string },
    scope: { tenantId: string; organizationId: string },
    now: Date,
  ): Promise<{ remind: boolean; escalate: boolean }> {
    return withTx(this.db, scope, systemActor(SLA_JOB), async (tx) => {
      // Lock the request, then the step: the same order as act(), so the tick and a decider never
      // deadlock. NO KEY UPDATE matches act() too. Re-read both: another worker or a decision may
      // have handled the step since the scan.
      const [request] = await tx
        .select()
        .from(approvalRequests)
        .where(and(eq(approvalRequests.id, c.requestId), eq(approvalRequests.status, 'pending')))
        .for('no key update');
      if (request === undefined) return { remind: false, escalate: false };
      const [step] = await tx
        .select()
        .from(approvalSteps)
        .where(and(eq(approvalSteps.id, c.stepId), eq(approvalSteps.status, 'active'), due(now)))
        .for('update');
      if (step === undefined) return { remind: false, escalate: false };
      const spec = await this.approvals.frozenSpec(tx, request.workflowVersionId);

      const remind = step.remindAt !== null && step.remindAt <= now && step.remindedAt === null;
      const escalate =
        step.escalateAt !== null && step.escalateAt <= now && step.escalatedAt === null;
      await tx
        .update(approvalSteps)
        .set({
          ...(remind ? { remindedAt: now } : {}),
          ...(escalate ? { escalatedAt: now } : {}),
        })
        .where(eq(approvalSteps.id, step.id));

      if (remind) {
        await this.approvals.writeAction(tx, scope, {
          requestId: request.id,
          stepId: step.id,
          actorUserId: null,
          action: 'remind',
          requestVersion: request.version,
          now,
        });
        await this.audit.record(tx, {
          action: 'approvals.remind',
          entityType: 'approval_request',
          entityId: request.id,
          meta: { seq: step.seq },
        });
        // An explicit-route request (internal memo) names its approver on the step row, not in the frozen spec:
        // load that user too, so the reminder goes to the named person (and not to a user who left).
        const data = await this.approvals.loadDirectory(
          tx,
          scope,
          spec,
          step.kind === 'user' && step.userId !== null ? [step.userId] : [],
        );
        // A step whose author named its approver reminds only them (and their delegates), as submit told them.
        const eligible =
          this.approvals.assignedApprovers(request, step, data, now) ??
          this.approvals
            .directory(data, now, request.documentType, request.sodUserIds)
            .eligible(stepSpecOf(step, data));
        await this.approvals.notifyApprovers(
          tx,
          request.id,
          request.documentNumber,
          request.title,
          eligible,
          step.seq,
          'reminder',
        );
      }
      if (escalate) {
        await this.approvals.writeAction(tx, scope, {
          requestId: request.id,
          stepId: step.id,
          actorUserId: null,
          action: 'escalate',
          comment: `Escalated to ${spec.sla.escalateTo.role}`,
          requestVersion: request.version,
          now,
        });
        await this.audit.record(tx, {
          action: 'approvals.escalate',
          entityType: 'approval_request',
          entityId: request.id,
          meta: { seq: step.seq, role: spec.sla.escalateTo.role },
        });
        await this.notify.notifyRole(tx, spec.sla.escalateTo.role, {
          title: `Overdue approval: ${request.documentNumber}`,
          body: `Step ${step.seq} (${step.reason}) has waited ${spec.sla.escalateAfterHours} hours.`,
          link: `/inbox/${request.id}`,
          email: {
            template: 'approval.escalated',
            vars: { documentNumber: request.documentNumber },
          },
          dedupeKey: `approval:${request.id}:${step.seq}:escalated`,
        });
      }
      return { remind, escalate };
    });
  }
}

@Processor(APPROVALS_QUEUE)
export class ApprovalsSlaProcessor extends WorkerHost {
  constructor(private readonly sla: ApprovalsSlaService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === SLA_JOB) {
      await this.sla.tick();
      return;
    }
    // A job name nobody handles is a bug; failing keeps it visible instead of silently dropping it.
    throw new Error(`Unknown approvals job: ${job.name}`);
  }
}

/** Registers the 5-minute tick. upsertJobScheduler is idempotent, so restarts never stack schedules. */
@Injectable()
export class ApprovalsSlaScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(APPROVALS_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SLA_JOB,
      { every: SLA_EVERY_MS },
      { name: SLA_JOB, opts: { removeOnComplete: 5, removeOnFail: 20 } },
    );
  }
}
