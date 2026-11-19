// ApprovalsService: submits documents for approval, records decisions and answers the inbox.
// This is the money path. Serves the NFRs:
// - "approvals are auditable": a frozen snapshot with its SHA-256, the frozen spec version, a reason per
//   step, an append-only action log and an audit event for every change;
// - "no double decisions": act() locks the request (FOR UPDATE), replays an Idempotency-Key and refuses
//   a stale expectedVersion with 409;
// - "separation of duties": the people in sod_user_ids never approve, and (with distinctApprovers) one
//   person never approves two steps of the same request.
import {
  ApprovalActionBodySchema,
  DEFAULT_DEPARTMENT_HEAD_FALLBACK_ROLE,
  DEFAULT_ROLE_PERMISSIONS,
  DecimalString,
  MemoTemplateSnapshotSchema,
  ROLE_KEYS,
  WorkflowSpecSchema,
  type ApprovalActionBody,
  type ApprovalRequestDto,
  type InboxItemDto,
  type RoleKey,
  type RoutePlan,
  type StepSpec,
  type WorkflowSpec,
} from '@bos/contracts';
import {
  approvalActions,
  approvalGroupMembers,
  approvalGroups,
  approvalRequests,
  approvalSteps,
  delegations,
  departments,
  idpOrgs,
  userEntities,
  users as appUsers,
  workflowDefinitions,
  workflowVersions,
} from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { can } from '../../platform/authz/can';
import type { Principal } from '../../platform/authz/principal';
import { UserDirectory } from '../../platform/authz/user-directory';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { canonicalSha256 } from '../../platform/hashing/canonical-json';
import { exactMatch } from '../../platform/list';
import { personNames } from '../../platform/users/person-names';
import {
  ASSIGNABLE_SEQ,
  assigneeOf,
  effectiveAssignee,
  outsideRoleAssigneeRoles,
  withAssignee,
} from './assignee';
import { ConditionError } from './conditions';
import {
  APPROVALS_CLOCK,
  ApprovalsAudit,
  ApprovalsCaller,
  ApprovalsNotify,
  type Clock,
} from './ports';
import {
  buildDirectory,
  delegationActive,
  route,
  type BuiltDirectory,
  type DirectoryData,
  type StepDecision,
} from './router';

/** A document type that can be approved. Every hook runs in the transaction that changes the request. */
export interface ApprovalSubject {
  documentType: string;
  onDecided(
    tx: DbTransaction,
    documentId: string,
    outcome: 'approved' | 'returned' | 'rejected',
  ): Promise<void>;
  /**
   * Optional: the request was cancelled (cancel()). Separate from onDecided because a cancel is not a
   * decision, and a subject whose onDecided maps every outcome to a document state must not be handed a
   * fourth one it never handled. Usually the subject's own module called cancel(), so most need no hook.
   */
  onCancelled?(tx: DbTransaction, documentId: string, reason: string): Promise<void>;
  /**
   * Optional: the workspace page of the document, for the decided notice to the requester (for example
   * `/memos/<id>`). Without it the requester is sent to the request in the inbox. The path must be an area
   * the `approval.decided` email allows (notify/templates.ts), else the notice fails at enqueue.
   * Runs in the deciding transaction, before onDecided, so it may read the document (a quotation version
   * links to its quotation). Undefined also falls back to the inbox.
   */
  link?(tx: DbTransaction, documentId: string): string | undefined | Promise<string | undefined>;
}

export interface SubmitInput {
  documentType: string;
  documentId: string;
  /**
   * The document's number. Optional: a document that is numbered only at issue (after approval) has none
   * yet, so the request carries `Draft <documentType> <first 8 chars of documentId>` instead. That text is
   * stored on the request and is what the inbox titles and notices show.
   */
  documentNumber?: string;
  title: string;
  snapshot: unknown;
  facts: Record<string, unknown>;
  requesterUserId: string;
  /** Who pressed submit, when not the requester (someone submitting on their behalf). Defaults to the requester. */
  submittedByUserId?: string;
  sodUserIds: string[];
  /** Proposed printed signers, checked against the authoritative plan inside the submit transaction. */
  proposedApproverIds?: string[];
  /**
   * Optional: route the document through exactly these named people, in order, instead of the published
   * workflow's role steps and amount rules. Used by internal correspondence, where the author names every
   * signer and no financial threshold applies. The published definition and version are still recorded on
   * the request (its SLA and distinctApprovers apply); only the steps are replaced. The plan still runs
   * through the router, so separation of duties and blocked handling are the engine's. A blocked plan is
   * refused with 409 rather than stored, because a named person who cannot sign is a mistake to fix, not a
   * route for an administrator to repair.
   */
  explicitSteps?: ExplicitRouteStep[];
  /**
   * Optional: the one person who decides the first (role) step, chosen by the author. Must be one of
   * assignableApprovers(); checked again here, in the submit transaction. Only they (or their delegate, when
   * they hold the step's role) then see and decide that step. Not combined with explicitSteps.
   */
  assigneeUserId?: string;
}

/** Someone the author may name as the approver of the first step. */
export interface AssignableApprover {
  userId: string;
  /** The role that qualifies them: the step's own role, or a widened one (assignee.ts). */
  roleKey: RoleKey;
}

/** One named signer of an explicit route. `reason` is shown to the approver and kept in the audit trail. */
export interface ExplicitRouteStep {
  userId: string;
  reason: string;
}

/**
 * Marker stored in `approval_requests.facts` of an explicit-route request (jsonb, no migration). Decision time
 * (act, inbox, reroute) rebuilds the spec from the stored user steps when it is present, so it must never be
 * set on a request whose stored steps are not all user steps. Requests submitted before it existed lack it
 * and keep routing from the frozen workflow spec exactly as before.
 */
export const EXPLICIT_ROUTE_FACT = 'routing';
export const EXPLICIT_ROUTE_VALUE = 'explicit';

/** The published spec with its steps replaced by named people and its amount rules dropped. */
export function explicitSpecOf(
  published: WorkflowSpec,
  steps: readonly ExplicitRouteStep[],
): WorkflowSpec {
  return {
    ...published,
    steps: steps.map((s, i) => ({
      id: `selected-${i + 1}`,
      kind: 'user' as const,
      user: s.userId,
      reason: s.reason,
    })),
    rules: [],
  };
}

type Q = Db | DbTransaction;
type RequestRow = typeof approvalRequests.$inferSelect;
type StepRow = typeof approvalSteps.$inferSelect;

const HOUR_MS = 3_600_000;
const addHours = (d: Date, h: number) => new Date(d.getTime() + h * HOUR_MS);
/** Roles told about a blocked request: whoever may change role assignments (admin.roles.write). */
const BLOCKED_NOTICE_ROLES = ROLE_KEYS.filter(
  (r) => DEFAULT_ROLE_PERMISSIONS[r]['admin.roles.write'] !== undefined,
);

/** What the inbox list accepts. No default limit: the dashboard count and inbox/[id] read every item. */
export interface InboxQuery {
  q?: string | undefined;
  documentType?: readonly string[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

const inboxLink = (requestId: string) => `/inbox/${requestId}`;
const MAX_CANCEL_REASON = 2000;
/** What a request shows as its number while its document has none yet (numbered at issue, after approval). */
const draftReference = (documentType: string, documentId: string) =>
  `Draft ${documentType} ${documentId.slice(0, 8)}`;
/** Email vars are plain strings; a value that is not known is left out so the template default applies. */
const emailVars = (v: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => e[1] !== undefined));

/** Postgres error code from a pg error, also when drizzle wraps it (DrizzleQueryError.cause). */
export function pgCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

const forbidden = (reason: 'out_of_scope' | 'separation_of_duties', message: string) =>
  new ForbiddenException({ code: 'forbidden', reason, message });

@Injectable()
export class ApprovalsService {
  private readonly subjects = new Map<string, ApprovalSubject>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: ApprovalsAudit,
    private readonly notify: ApprovalsNotify,
    private readonly users: UserDirectory,
    private readonly caller: ApprovalsCaller,
    @Inject(APPROVALS_CLOCK) private readonly clock: Clock,
  ) {}

  registerSubject(s: ApprovalSubject): void {
    if (this.subjects.has(s.documentType)) {
      throw new Error(`approval subject "${s.documentType}" is already registered`);
    }
    this.subjects.set(s.documentType, s);
  }

  /** The plan a submit would produce now, without writing anything. */
  async preview(
    scope: TxScope,
    documentType: string,
    facts: Record<string, unknown>,
    sodUserIds: string[],
    explicitSteps?: readonly ExplicitRouteStep[],
  ): Promise<RoutePlan> {
    const published = await this.publishedSpec(this.db, scope, documentType);
    const spec =
      explicitSteps === undefined ? published.spec : explicitSpecOf(published.spec, explicitSteps);
    const data = await this.loadDirectory(this.db, scope, spec);
    const plan = this.plan(spec, facts, data, sodUserIds);
    // Who can approve is the approvers' business: a requester (read only) sees the steps and whether
    // each is blocked, not the people. No resource is passed, so only the permission itself counts.
    if (can(this.caller.current().principal, 'approvals.requests.act').allowed) return plan;
    return { ...plan, steps: plan.steps.map((s) => ({ ...s, eligibleUserIds: [] })) };
  }

  /**
   * Who the author may name as the approver of the first step of this document's route, or null when that
   * step is not a role step (nothing to choose). Active staff of this entity holding the step's role, plus
   * the widened roles of assignee.ts, minus `sodUserIds` (the author and whoever submits). Unlike preview(),
   * not redacted: the author needs the people to choose one. Read-only.
   */
  async assignableApprovers(
    scope: TxScope,
    documentType: string,
    facts: Record<string, unknown>,
    sodUserIds: readonly string[],
    q: Q = this.db,
  ): Promise<{ seq: number; candidates: AssignableApprover[] } | null> {
    const { spec } = await this.publishedSpec(q, scope, documentType);
    const data = await this.loadDirectory(q, scope, spec);
    return this.assignableFrom(q, scope, spec, facts, data, sodUserIds);
  }

  private async assignableFrom(
    q: Q,
    scope: TxScope,
    spec: WorkflowSpec,
    facts: Record<string, unknown>,
    data: DirectoryData,
    sodUserIds: readonly string[],
  ): Promise<{ seq: number; candidates: AssignableApprover[] } | null> {
    const first = this.plan(spec, facts, data, sodUserIds).steps.find(
      (s) => s.seq === ASSIGNABLE_SEQ,
    );
    if (first?.kind !== 'role' || first.roleKey === undefined) return null;
    const sod = new Set(sodUserIds);
    const byUser = new Map<string, RoleKey>();
    for (const role of [first.roleKey, ...outsideRoleAssigneeRoles(spec.documentType)]) {
      for (const id of data.roleMembers.get(role) ?? []) {
        if (!sod.has(id) && !byUser.has(id)) byUser.set(id, role);
      }
    }
    // The role lists come from the directory; the tenant, entity, staff and active checks are made here too.
    const active =
      byUser.size === 0
        ? new Set<string>()
        : new Set(await activeEntityStaff(q, scope, [...byUser.keys()]));
    return {
      seq: first.seq,
      candidates: [...byUser]
        .filter(([id]) => active.has(id))
        .map(([userId, roleKey]) => ({ userId, roleKey })),
    };
  }

  async submit(
    tx: DbTransaction,
    i: SubmitInput,
  ): Promise<{ requestId: string; status: 'pending' | 'blocked' }> {
    if (!this.subjects.has(i.documentType)) {
      throw new Error(`no approval subject registered for "${i.documentType}"`);
    }
    const scope = await scopeOf(tx);
    const now = this.clock();
    const published = await this.publishedSpec(tx, scope, i.documentType);
    const { definitionId, versionId } = published;
    const spec =
      i.explicitSteps === undefined
        ? published.spec
        : explicitSpecOf(published.spec, i.explicitSteps);
    // What is stored on the request: for an explicit route, the marker decision time keys on.
    const routed =
      i.explicitSteps === undefined
        ? i.facts
        : { ...i.facts, [EXPLICIT_ROUTE_FACT]: EXPLICIT_ROUTE_VALUE };
    const data = await this.loadDirectory(tx, scope, spec);
    const plan = this.plan(spec, routed, data, i.sodUserIds);
    if (i.assigneeUserId !== undefined) {
      if (i.explicitSteps !== undefined) {
        throw new Error('submit() takes an assignee or explicit steps, not both');
      }
      const choice = await this.assignableFrom(tx, scope, spec, routed, data, i.sodUserIds);
      if (!choice?.candidates.some((c) => c.userId === i.assigneeUserId)) {
        throw approverNotEligible(i.sodUserIds.includes(i.assigneeUserId));
      }
    }
    const facts = i.assigneeUserId === undefined ? routed : withAssignee(routed, i.assigneeUserId);
    if (i.explicitSteps !== undefined && plan.blocked) {
      const seq = plan.steps.find((s) => s.blocked)?.seq;
      throw new ConflictException(
        `${seq === undefined ? 'A selected signer' : `Selected signer ${seq}`} cannot approve this document: they prepared or edited it, or are no longer active. Choose different people and submit again.`,
      );
    }
    for (const s of plan.steps) {
      if (s.kind === 'group' && s.groupId === undefined) {
        throw new ConflictException('The workflow names an approval group that does not exist');
      }
    }
    if (
      i.proposedApproverIds &&
      (plan.blocked ||
        plan.steps.length !== i.proposedApproverIds.length ||
        i.proposedApproverIds.some((id, index) => !plan.steps[index]?.eligibleUserIds.includes(id)))
    ) {
      throw new ConflictException(
        'Selected recommenders and approver must match the current approval route in order. Review the route before submitting.',
      );
    }
    const status = plan.blocked ? 'blocked' : 'pending';
    const documentNumber = i.documentNumber ?? draftReference(i.documentType, i.documentId);

    let requestId: string;
    try {
      const [row] = await tx
        .insert(approvalRequests)
        .values({
          ...scope,
          definitionId,
          workflowVersionId: versionId,
          documentType: i.documentType,
          documentId: i.documentId,
          documentNumber,
          title: i.title,
          snapshot: i.snapshot,
          snapshotSha256: canonicalSha256(i.snapshot),
          facts,
          requesterUserId: i.requesterUserId,
          sodUserIds: [...new Set(i.sodUserIds)],
          status,
          blockReason: plan.blockReason ?? null,
          currentSeq: 1,
          version: 1,
          submittedAt: now,
        })
        .returning({ id: approvalRequests.id });
      requestId = row!.id;
    } catch (error) {
      if (pgCode(error) === '23505') {
        throw new ConflictException('This document already has an open approval request');
      }
      throw error;
    }

    await tx.insert(approvalSteps).values(
      plan.steps.map((s) => ({
        ...scope,
        requestId,
        seq: s.seq,
        kind: s.kind,
        roleKey: s.roleKey ?? null,
        groupId: s.groupId ?? null,
        userId: s.userId ?? null,
        reason: s.reason,
        ...(s.seq === 1 && !plan.blocked ? activation(now, spec) : { status: 'waiting' as const }),
      })),
    );
    await this.writeAction(tx, scope, {
      requestId,
      actorUserId: i.submittedByUserId ?? i.requesterUserId,
      action: 'submit',
      requestVersion: 1,
      now,
    });
    if (plan.blocked) {
      await this.writeAction(tx, scope, {
        requestId,
        actorUserId: i.requesterUserId,
        action: 'block',
        comment: plan.blockReason ?? null,
        requestVersion: 1,
        now,
      });
    }
    await this.audit.record(tx, {
      action: 'approvals.submit',
      entityType: 'approval_request',
      entityId: requestId,
      after: {
        status,
        documentType: i.documentType,
        documentId: i.documentId,
        steps: plan.steps,
        ...(i.assigneeUserId === undefined
          ? {}
          : { assignee: { seq: ASSIGNABLE_SEQ, userId: i.assigneeUserId } }),
      },
      meta: { workflowVersionId: versionId },
    });

    if (plan.blocked) {
      await this.notifyBlocked(tx, requestId, documentNumber, plan.blockReason, 1);
    } else {
      await this.notifyApprovers(
        tx,
        requestId,
        documentNumber,
        i.title,
        // A named approver (and their delegates) are the only ones told: the step is theirs alone.
        i.assigneeUserId === undefined
          ? plan.steps[0]!.eligibleUserIds
          : (this.assignedApprovers(
              { facts, documentType: i.documentType, sodUserIds: i.sodUserIds },
              { seq: 1, kind: plan.steps[0]!.kind, roleKey: plan.steps[0]!.roleKey ?? null },
              data,
              now,
            ) ?? plan.steps[0]!.eligibleUserIds),
        1,
        'pending',
      );
    }
    return { requestId, status };
  }

  /** Approve, return or reject the active step. The 8 steps of P1-PLAN section 6.2, in one transaction. */
  async act(
    requestId: string,
    body: ApprovalActionBody,
    idempotencyKey: string,
  ): Promise<ApprovalRequestDto> {
    const { scope, actor, principal } = this.caller.current();
    this.requireStaff(scope, principal);
    const parsed = ApprovalActionBodySchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException(parsed.error.issues.map((x) => x.message).join('; '));
    const action = parsed.data;
    const userId = principal.userId;
    // Refuse unassigned callers before acquiring the row lock; repeat eligibility under the lock.
    await this.eligibleRequest(requestId, { action, idempotencyKey });

    return withTx(this.db, scope, actor, async (tx) => {
      const now = this.clock();
      // 1. Lock: two approvers clicking at once are serialised here.
      const request = await this.lockRequest(tx, scope, requestId);

      // 2. Idempotency: a retried click returns what the first one returned.
      const requestHash = canonicalSha256({ requestId, ...action });
      const [previous] = await tx
        .select()
        .from(approvalActions)
        .where(
          and(
            eq(approvalActions.tenantId, scope.tenantId),
            eq(approvalActions.actorUserId, userId),
            eq(approvalActions.requestId, requestId),
            eq(approvalActions.idempotencyKey, idempotencyKey),
          ),
        );
      if (previous !== undefined) {
        if (
          !can(principal, 'approvals.requests.act').allowed &&
          !(await this.prHeadReplay(tx, scope, principal, request, previous, requestHash, now)) &&
          !(await this.outsideRoleReplay(tx, principal, request, previous, requestHash))
        ) {
          throw forbidden('out_of_scope', 'You are not an approver for this request');
        }
        if (previous.requestHash?.equals(requestHash) === true)
          return previous.result as ApprovalRequestDto;
        throw new ConflictException('This Idempotency-Key was already used for a different action');
      }

      // 3. Eligibility, then separation of duties, before any version or status answer: someone who may
      // not act learns nothing about the request's state. Checked against the step at currentSeq whatever
      // its status, because a decided or blocked request has no active step.
      const steps = await this.stepsOf(tx, requestId);
      const current = steps.find((s) => s.seq === request.currentSeq);
      if (current === undefined) throw new ConflictException('The request has no current step');
      // An explicit-route request is routed by its stored user steps, not by the published role steps.
      const spec = routingSpecOf(
        request.facts,
        await this.frozenSpec(tx, request.workflowVersionId),
        steps,
      );
      const data = await this.loadDirectory(tx, scope, spec);
      if (
        !can(principal, 'approvals.requests.act').allowed &&
        !(
          request.status === 'pending' &&
          current.status === 'active' &&
          (this.prHeadAssignment(principal, request, current, spec, data, now) ||
            this.outsideRoleAssignment(principal, request, current, data))
        )
      ) {
        throw forbidden('out_of_scope', 'You are not an approver for the active step');
      }
      const sod = new Set(request.sodUserIds);
      const earlier = spec.distinctApprovers
        ? earlierDeciders(decisionsOf(steps), current.seq)
        : new Set<string>();
      // A delegate for several approvers acts for one who may decide: not an SoD person and, under
      // distinctApprovers, not someone who decided an earlier step (else the check below refuses them).
      const who = this.decider(request, current, data, now, userId, new Set([...sod, ...earlier]));
      if (!who.eligible) {
        throw forbidden(
          'out_of_scope',
          who.assigned
            ? 'The author named a different approver for this step'
            : 'You are not an approver for the active step',
        );
      }
      if (request.documentType === 'test_memo') {
        const memo = z.object({ template: MemoTemplateSnapshotSchema }).safeParse(request.snapshot);
        if (memo.success) {
          const selected = [...memo.data.template.recommenders, memo.data.template.approvedBy][
            current.seq - 1
          ];
          if (!selected || (selected.userId !== userId && selected.userId !== who.onBehalfOf)) {
            throw forbidden(
              'out_of_scope',
              'This memo names a different person for this approval step',
            );
          }
        }
      }
      // The role mirror lags ZITADEL: a revoked role stays in app.user_roles until the sync runs. The
      // token's roles are the truth for a direct approver. A delegate acts on the delegator's mirror roles
      // (the delegator is not the caller, so there is no token to check): an accepted limit.
      if (!holdsStepRole(principal, request.documentType, current, who)) {
        throw forbidden('out_of_scope', 'You no longer hold the role this step needs');
      }
      if (sod.has(userId) || (who.onBehalfOf !== null && sod.has(who.onBehalfOf))) {
        throw forbidden(
          'separation_of_duties',
          'You prepared this document, so you cannot approve it',
        );
      }
      if (earlier.has(userId) || (who.onBehalfOf !== null && earlier.has(who.onBehalfOf))) {
        throw forbidden(
          'separation_of_duties',
          'You already decided an earlier step of this request',
        );
      }

      // 4. Stale view.
      if (request.version !== action.expectedVersion) {
        throw new ConflictException(
          `The request changed (version ${request.version}, you saw ${action.expectedVersion}); reload it`,
        );
      }
      if (request.status !== 'pending') {
        throw new ConflictException(`The request is ${request.status}; nothing to decide`);
      }
      if (current.status !== 'active')
        throw new ConflictException('The request has no active step');
      const active = current;

      // 5. Advance.
      const outcome =
        action.action === 'approve'
          ? 'approved'
          : action.action === 'return'
            ? 'returned'
            : 'rejected';
      await tx
        .update(approvalSteps)
        .set({
          status: outcome,
          decidedBy: userId,
          decidedOnBehalfOf: who.onBehalfOf,
          decidedAt: now,
        })
        .where(eq(approvalSteps.id, active.id));
      const next = steps.find((s) => s.seq === active.seq + 1);
      const decided = action.action !== 'approve' || next === undefined;
      // Who may decide the next step, routed like reroute() with this decision counted: under
      // distinctApprovers a step left with only earlier deciders would stay pending with nobody able to
      // act, so it blocks instead (founders are told, and reroute reopens it once someone is added).
      let nextEligible: readonly string[] = [];
      let blockReason: string | null = null;
      if (action.action === 'approve' && next !== undefined) {
        const plan = this.plan(
          spec,
          request.facts as Record<string, unknown>,
          data,
          request.sodUserIds,
          decisionsOf(
            steps.map((s) =>
              s.id === active.id
                ? { ...s, decidedBy: userId, decidedOnBehalfOf: who.onBehalfOf }
                : s,
            ),
          ),
        );
        const nextPlanned = plan.steps.find((s) => s.seq === next.seq);
        nextEligible = nextPlanned?.eligibleUserIds ?? [];
        if (nextEligible.length === 0) {
          blockReason = plan.blockReason ?? 'No eligible approver';
        } else {
          await tx
            .update(approvalSteps)
            .set({ ...activation(now, spec), ...retarget(next, nextPlanned) })
            .where(eq(approvalSteps.id, next.id));
        }
      }
      const blocked = blockReason !== null;
      if (action.action !== 'approve') {
        await tx
          .update(approvalSteps)
          .set({ status: 'skipped' })
          .where(and(eq(approvalSteps.requestId, requestId), eq(approvalSteps.status, 'waiting')));
      }
      // 8 (done before the action row so the stored result shows the new version).
      const newVersion = request.version + 1;
      await tx
        .update(approvalRequests)
        .set({
          version: newVersion,
          currentSeq: next !== undefined && !decided ? next.seq : request.currentSeq,
          ...(decided ? { status: outcome, decidedAt: now } : {}),
          ...(blocked ? { status: 'blocked' as const, blockReason } : {}),
        })
        .where(eq(approvalRequests.id, requestId));

      // 6. Action row (with the result for replays), audit, notifications.
      const dto = await this.loadDto(tx, scope, requestId);
      dto.actions.push({
        action: action.action,
        actorUserId: userId,
        onBehalfOfUserId: who.onBehalfOf,
        comment: action.comment ?? null,
        createdAt: now.toISOString(),
      });
      // The block row, as submit() writes it, is in the stored result too so a replay shows it.
      if (blocked) {
        dto.actions.push({
          action: 'block',
          actorUserId: userId,
          onBehalfOfUserId: null,
          comment: blockReason,
          createdAt: now.toISOString(),
        });
      }
      try {
        await this.writeAction(tx, scope, {
          requestId,
          stepId: active.id,
          actorUserId: userId,
          onBehalfOfUserId: who.onBehalfOf,
          action: action.action,
          comment: action.comment ?? null,
          idempotencyKey,
          requestHash,
          requestVersion: newVersion,
          result: dto,
          now,
        });
      } catch (error) {
        // The same key used at the same moment on another request (a different lock): that is a
        // client reusing a key, so 409 like any other key reuse, not a 500.
        if (pgCode(error) === '23505') {
          throw new ConflictException(
            'This Idempotency-Key was already used for a different action',
          );
        }
        throw error;
      }
      if (blocked) {
        await this.writeAction(tx, scope, {
          requestId,
          stepId: next!.id,
          actorUserId: userId,
          action: 'block',
          comment: blockReason,
          requestVersion: newVersion,
          now,
        });
      }
      await this.audit.record(tx, {
        action: `approvals.${action.action}`,
        entityType: 'approval_request',
        entityId: requestId,
        before: { status: request.status, version: request.version, seq: active.seq },
        after: {
          status: dto.status,
          version: newVersion,
          seq: dto.currentSeq,
          ...(blocked ? { blockReason } : {}),
        },
        meta: { onBehalfOf: who.onBehalfOf },
      });
      if (decided) {
        // The requester opens the document itself when it has a page (a memo); else the request in the inbox.
        const requesterLink =
          (await this.subjectOf(request.documentType).link?.(tx, request.documentId)) ??
          inboxLink(requestId);
        await this.notify.notifyUser(tx, {
          userId: request.requesterUserId,
          title: `${request.documentNumber} was ${outcome}`,
          body: action.comment ?? `${request.title} was ${outcome}.`,
          link: requesterLink,
          email: {
            template: 'approval.decided',
            vars: emailVars({
              documentNumber: request.documentNumber,
              documentType: request.documentType,
              // The template reads `decision`; a key it does not list is ignored, so "outcome" made every
              // subject say "updated".
              decision: outcome,
              deciderName: await this.displayName(userId),
              linkPath: requesterLink,
            }),
          },
          dedupeKey: `approval:${requestId}:decided`,
        });
        // 7. Tell the document. Same transaction: if it fails, the decision rolls back too.
        await this.subjectOf(request.documentType).onDecided(tx, request.documentId, outcome);
      } else if (blocked) {
        await this.notifyBlocked(tx, requestId, request.documentNumber, blockReason, newVersion);
      } else if (next !== undefined) {
        // From the plan, so under distinctApprovers whoever decided an earlier step is not asked.
        await this.notifyApprovers(
          tx,
          requestId,
          request.documentNumber,
          request.title,
          this.assignedApprovers(request, next, data, now) ?? nextEligible,
          next.seq,
          'pending',
        );
      }
      return dto;
    });
  }

  /**
   * Withdraws an open (pending or blocked) request, for the module that owns the document: for example a
   * quotation revised while its approval is pending. Not an HTTP route and checks no permission itself: the
   * calling module has already authorised the change to its document (that is what triggers the cancel).
   * Runs in the caller's transaction (opened with withTx, which also scopes it to the entity), so the cancel,
   * its action row, its audit event and the subject's onCancelled commit or roll back with the module's change.
   * Open steps become skipped, so the request leaves every inbox and the SLA tick; a later act() gets 409.
   * A request that is not open (already cancelled, or decided) answers 409.
   */
  async cancel(
    tx: DbTransaction,
    requestId: string,
    reason: string,
    actor: Actor,
  ): Promise<ApprovalRequestDto> {
    const why = reason.trim();
    if (why === '' || why.length > MAX_CANCEL_REASON) {
      throw new BadRequestException(
        `a cancel reason of 1 to ${MAX_CANCEL_REASON} characters is required`,
      );
    }
    const scope = await scopeOf(tx);
    const now = this.clock();
    const request = await this.lockRequest(tx, scope, requestId);
    if (request.status !== 'pending' && request.status !== 'blocked') {
      throw new ConflictException(
        `The request is ${request.status}; only open requests can be cancelled`,
      );
    }
    const newVersion = request.version + 1;
    const current = (await this.stepsOf(tx, requestId)).find((s) => s.seq === request.currentSeq);
    await tx
      .update(approvalSteps)
      .set({ status: 'skipped', remindAt: null, escalateAt: null })
      .where(
        and(
          eq(approvalSteps.requestId, requestId),
          inArray(approvalSteps.status, ['active', 'waiting']),
        ),
      );
    await tx
      .update(approvalRequests)
      .set({ status: 'cancelled', version: newVersion, decidedAt: now })
      .where(eq(approvalRequests.id, requestId));
    await this.writeAction(tx, scope, {
      requestId,
      ...(current === undefined ? {} : { stepId: current.id }),
      // A user id only: the column references app.users, and a system job (an expiry) has none.
      actorUserId: actor.kind === 'user' ? actor.id : null,
      action: 'cancel',
      comment: why,
      requestVersion: newVersion,
      now,
    });
    await this.audit.record(tx, {
      action: 'approvals.cancel',
      entityType: 'approval_request',
      entityId: requestId,
      before: { status: request.status, version: request.version },
      after: { status: 'cancelled', version: newVersion, reason: why },
      meta: {
        documentType: request.documentType,
        documentId: request.documentId,
        actorKind: actor.kind,
        actorId: actor.id,
      },
    });
    await this.subjectOf(request.documentType).onCancelled?.(tx, request.documentId, why);
    return this.loadDto(tx, scope, requestId);
  }

  /** Pending requests whose active step the caller may decide now. */
  async inbox(): Promise<InboxItemDto[]> {
    return (await this.inboxPage({})).items;
  }

  /**
   * The inbox narrowed by search and type, then paged. Loads every matching row, runs the eligibility checks and
   * only then counts and slices: the total is what the caller may decide, never what the filters match.
   */
  async inboxPage(query: InboxQuery): Promise<{ items: InboxItemDto[]; total: number }> {
    const { scope, principal } = this.caller.current();
    this.requireStaff(scope, principal);
    const genericApprover = can(principal, 'approvals.requests.act').allowed;
    const types = query.documentType ?? [];
    const filtered = query.q !== undefined || types.length > 0;
    const eligible = await this.eligibleInbox(scope, principal, genericApprover, query);
    // A filter that hides everything is an empty list, not a missing assignment: judge the 403 unfiltered.
    const unfiltered =
      eligible.length === 0 && filtered
        ? await this.eligibleInbox(scope, principal, genericApprover, {})
        : eligible;
    if (
      !genericApprover &&
      unfiltered.length === 0 &&
      !mayBeNamedOutsideRole(principal) &&
      !(await this.hasPrHeadDuty(scope, principal))
    ) {
      throw forbidden('out_of_scope', 'You have no approval assignment');
    }
    const offset = query.offset ?? 0;
    const end = query.limit === undefined ? undefined : offset + query.limit;
    return { items: eligible.slice(offset, end), total: eligible.length };
  }

  private async eligibleInbox(
    scope: TxScope,
    principal: Principal,
    genericApprover: boolean,
    query: InboxQuery,
  ): Promise<InboxItemDto[]> {
    const now = this.clock();
    const types = query.documentType ?? [];
    const rows = await this.db
      .select({ request: approvalRequests, step: approvalSteps })
      .from(approvalRequests)
      .innerJoin(
        approvalSteps,
        and(
          eq(approvalSteps.requestId, approvalRequests.id),
          eq(approvalSteps.seq, approvalRequests.currentSeq),
        ),
      )
      .where(
        and(
          eq(approvalRequests.tenantId, scope.tenantId),
          eq(approvalRequests.organizationId, scope.organizationId),
          eq(approvalRequests.status, 'pending'),
          eq(approvalSteps.status, 'active'),
          types.length > 0 ? inArray(approvalRequests.documentType, types) : undefined,
          query.q === undefined
            ? undefined
            : exactMatch(query.q, [
                approvalRequests.title,
                approvalRequests.documentNumber,
                approvalSteps.reason,
              ]),
        ),
      )
      .orderBy(asc(approvalRequests.submittedAt), asc(approvalRequests.id));

    // Earlier decisions of every listed request, for the distinctApprovers check below.
    const decided = new Map<string, StepDecision[]>();
    if (rows.length > 0) {
      const stepRows = await this.db
        .select({
          requestId: approvalSteps.requestId,
          seq: approvalSteps.seq,
          decidedBy: approvalSteps.decidedBy,
          decidedOnBehalfOf: approvalSteps.decidedOnBehalfOf,
        })
        .from(approvalSteps)
        .where(inArray(approvalSteps.requestId, [...new Set(rows.map((r) => r.request.id))]));
      for (const d of stepRows) {
        decided.set(d.requestId, [...(decided.get(d.requestId) ?? []), ...decisionsOf([d])]);
      }
    }

    // Explicit-route requests name their approvers on the step rows, not in the frozen spec, so the active
    // check needs those users too (one load per version, for every listed request).
    const stepUserIds = rows.flatMap(({ step }) =>
      step.kind === 'user' && step.userId !== null ? [step.userId] : [],
    );
    const specs = new Map<string, { spec: WorkflowSpec; data: DirectoryData }>();
    const items: InboxItemDto[] = [];
    for (const { request, step } of rows) {
      let entry = specs.get(request.workflowVersionId);
      if (entry === undefined) {
        const spec = await this.frozenSpec(this.db, request.workflowVersionId);
        entry = {
          spec,
          data: await this.loadDirectory(this.db, scope, spec, stepUserIds),
        };
        specs.set(request.workflowVersionId, entry);
      }
      if (
        !genericApprover &&
        !this.prHeadAssignment(principal, request, step, entry.spec, entry.data, now) &&
        !this.outsideRoleAssignment(principal, request, step, entry.data)
      ) {
        continue;
      }
      // The same checks as act() step 3, in the same order and with the same directory, so the inbox
      // never lists an item act() would refuse (and both pick the same principal for a delegate).
      const userId = principal.userId;
      const sod = new Set(request.sodUserIds);
      const earlier = entry.spec.distinctApprovers
        ? earlierDeciders(decided.get(request.id) ?? [], step.seq)
        : new Set<string>();
      const who = this.decider(
        request,
        step,
        entry.data,
        now,
        userId,
        new Set([...sod, ...earlier]),
      );
      if (!who.eligible) continue;
      // The token's roles, not the lagging mirror, decide a direct approver of a role step.
      if (!holdsStepRole(principal, request.documentType, step, who)) continue;
      if (sod.has(userId) || (who.onBehalfOf !== null && sod.has(who.onBehalfOf))) continue;
      if (earlier.has(userId) || (who.onBehalfOf !== null && earlier.has(who.onBehalfOf))) {
        continue;
      }
      const amount = (request.facts as Record<string, unknown>)['amountNpr'];
      items.push({
        requestId: request.id,
        documentType: request.documentType,
        documentId: request.documentId,
        documentNumber: request.documentNumber,
        title: request.title,
        amountNpr: DecimalString.safeParse(amount).success ? (amount as string) : null,
        reason: step.reason,
        activeStep: stepDto(step, request.facts),
        submittedAt: request.submittedAt.toISOString(),
        version: request.version,
      });
    }
    return items;
  }

  /** One request for its requester, a generic reader, or its currently eligible PR department head. */
  async get(requestId: string): Promise<ApprovalRequestDto> {
    return this.readRequest(requestId);
  }

  /** Internal pre-action read; an exact own retry does not grant a public historical read. */
  async getForAction(
    requestId: string,
    action: ApprovalActionBody,
    idempotencyKey: string,
  ): Promise<ApprovalRequestDto> {
    return this.readRequest(requestId, { action, idempotencyKey });
  }

  private async readRequest(
    requestId: string,
    replay?: { action: ApprovalActionBody; idempotencyKey: string },
  ): Promise<ApprovalRequestDto> {
    await this.eligibleRequest(requestId, replay);
    const { scope } = this.caller.current();
    const dto = await this.loadDto(this.db, scope, requestId);
    const people = await personNames(this.db, scope.tenantId, [
      dto.requesterUserId,
      ...dto.steps.flatMap((step) => [
        step.userId,
        step.assigneeUserId,
        step.decidedBy,
        step.decidedOnBehalfOf,
      ]),
      ...dto.actions.flatMap((action) => [
        action.actorUserId === 'system' ? null : action.actorUserId,
        action.onBehalfOfUserId,
      ]),
    ]);
    const groupIds = dto.steps.flatMap((step) => (step.groupId ? [step.groupId] : []));
    const groups = groupIds.length
      ? await this.db
          .select({ id: approvalGroups.id, name: approvalGroups.name })
          .from(approvalGroups)
          .where(
            and(
              eq(approvalGroups.tenantId, scope.tenantId),
              eq(approvalGroups.organizationId, scope.organizationId),
              inArray(approvalGroups.id, groupIds),
            ),
          )
      : [];
    const groupNames = new Map(groups.map((group) => [group.id, group.name]));
    return {
      ...dto,
      people,
      steps: dto.steps.map((step) => ({
        ...step,
        groupName: step.groupId ? (groupNames.get(step.groupId) ?? null) : null,
      })),
    };
  }

  private requireStaff(scope: TxScope, p: Principal): void {
    if (
      p.status !== 'active' ||
      p.orgKind !== 'staff' ||
      p.tenantId !== scope.tenantId ||
      p.organizationId !== scope.organizationId
    ) {
      throw new NotFoundException('Approval request not found');
    }
  }

  /** No DTO or lock until the caller's read, current assignment, or exact own retry is proven. */
  private async eligibleRequest(
    requestId: string,
    replay?: { action: ApprovalActionBody; idempotencyKey: string },
  ): Promise<void> {
    const { scope, principal } = this.caller.current();
    this.requireStaff(scope, principal);
    const [request] = await this.db
      .select()
      .from(approvalRequests)
      .where(requestInScope(scope, requestId));
    if (request === undefined) throw new NotFoundException('Approval request not found');
    const allowed =
      replay === undefined
        ? can(principal, 'approvals.requests.read', {
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            ownerUserId: request.requesterUserId,
          }).allowed
        : can(principal, 'approvals.requests.act').allowed;
    if (allowed) return;
    if (request.documentType === 'purchase_request') {
      const steps = await this.stepsOf(this.db, requestId);
      const current = steps.find((s) => s.seq === request.currentSeq);
      const spec = await this.frozenSpec(this.db, request.workflowVersionId);
      const data = await this.loadDirectory(this.db, scope, spec);
      if (
        request.status === 'pending' &&
        current?.status === 'active' &&
        this.prHeadAssignment(principal, request, current, spec, data, this.clock())
      ) {
        return;
      }
      if (replay !== undefined) {
        const previous = await this.ownAction(this.db, scope, requestId, principal.userId, replay);
        if (
          previous !== undefined &&
          (await this.prHeadReplay(
            this.db,
            scope,
            principal,
            request,
            previous,
            canonicalSha256({ requestId, ...replay.action }),
            this.clock(),
          ))
        ) {
          return;
        }
      }
    }
    if (outsideRoleAssigneeRoles(request.documentType).length > 0) {
      // A user named outside the step's role (assignee.ts) reads the request they were named on while it waits
      // on them, and replays their own decision; nothing else.
      const steps = await this.stepsOf(this.db, requestId);
      const current = steps.find((s) => s.seq === request.currentSeq);
      if (request.status === 'pending' && current?.status === 'active') {
        const spec = await this.frozenSpec(this.db, request.workflowVersionId);
        const data = await this.loadDirectory(this.db, scope, spec);
        if (this.outsideRoleAssignment(principal, request, current, data)) return;
      }
      if (replay !== undefined) {
        const previous = await this.ownAction(this.db, scope, requestId, principal.userId, replay);
        if (
          previous !== undefined &&
          (await this.outsideRoleReplay(
            this.db,
            principal,
            request,
            previous,
            canonicalSha256({ requestId, ...replay.action }),
          ))
        ) {
          return;
        }
      }
    }
    throw new NotFoundException('Approval request not found');
  }

  /** PR department-head duty grants no rights on another document type or a named-user step. */
  private prHeadAssignment(
    p: Principal,
    request: RequestRow,
    step: StepRow,
    spec: WorkflowSpec,
    data: DirectoryData,
    now: Date,
  ): boolean {
    if (
      p.status !== 'active' ||
      p.orgKind !== 'staff' ||
      p.tenantId !== request.tenantId ||
      p.organizationId !== request.organizationId ||
      request.documentType !== 'purchase_request' ||
      step.kind !== 'department_head' ||
      (step.roleKey !== null && step.roleKey !== DEFAULT_DEPARTMENT_HEAD_FALLBACK_ROLE)
    ) {
      return false;
    }
    // A designation can change while a request is open. Until reroute, the stored target must still
    // agree with today's department head (or the default fallback), not merely name an active user.
    const planned = this.plan(
      spec,
      request.facts as Record<string, unknown>,
      data,
      request.sodUserIds,
    ).steps.find((s) => s.seq === step.seq);
    if (
      planned?.kind !== 'department_head' ||
      (planned.userId ?? null) !== step.userId ||
      (planned.roleKey ?? null) !== step.roleKey
    ) {
      return false;
    }
    const sod = new Set(request.sodUserIds);
    const who = this.directory(data, now, request.documentType).resolveActor(
      stepSpecOf(step, data),
      p.userId,
      sod,
    );
    return (
      who.eligible &&
      !sod.has(p.userId) &&
      (who.onBehalfOf === null || !sod.has(who.onBehalfOf)) &&
      (who.onBehalfOf !== null || step.roleKey === null || p.roles.includes(step.roleKey))
    );
  }

  private async prHeadReplay(
    q: Q,
    scope: TxScope,
    p: Principal,
    request: RequestRow,
    previous: typeof approvalActions.$inferSelect,
    hash: Buffer,
    now: Date,
  ): Promise<boolean> {
    if (
      previous.requestId !== request.id ||
      previous.actorUserId !== p.userId ||
      !previous.requestHash?.equals(hash) ||
      previous.stepId === null
    ) {
      return false;
    }
    const step = (await this.stepsOf(q, request.id)).find((s) => s.id === previous.stepId);
    if (step === undefined) return false;
    const spec = await this.frozenSpec(q, request.workflowVersionId);
    const data = await this.loadDirectory(q, scope, spec);
    return this.prHeadAssignment(p, request, step, spec, data, now);
  }

  /** Empty inboxes remain available to current heads; this never adds rows to the filtered list. */
  private async hasPrHeadDuty(scope: TxScope, p: Principal): Promise<boolean> {
    if (p.status !== 'active' || p.orgKind !== 'staff') return false;
    const [head] = await this.db
      .select({ id: departments.id })
      .from(departments)
      .where(
        and(
          eq(departments.tenantId, scope.tenantId),
          eq(departments.organizationId, scope.organizationId),
          eq(departments.headUserId, p.userId),
        ),
      )
      .limit(1);
    if (head !== undefined) return true;
    return (
      p.roles.includes(DEFAULT_DEPARTMENT_HEAD_FALLBACK_ROLE) &&
      (await this.users.userIdsWithRole(scope, DEFAULT_DEPARTMENT_HEAD_FALLBACK_ROLE)).includes(
        p.userId,
      )
    );
  }

  /** The caller's own earlier action on the request under `replay`'s Idempotency-Key, if any. */
  private async ownAction(
    q: Q,
    scope: TxScope,
    requestId: string,
    userId: string,
    replay: { idempotencyKey: string },
  ): Promise<typeof approvalActions.$inferSelect | undefined> {
    const [previous] = await q
      .select()
      .from(approvalActions)
      .where(
        and(
          eq(approvalActions.tenantId, scope.tenantId),
          eq(approvalActions.organizationId, scope.organizationId),
          eq(approvalActions.requestId, requestId),
          eq(approvalActions.actorUserId, userId),
          eq(approvalActions.idempotencyKey, replay.idempotencyKey),
        ),
      );
    return previous;
  }

  /**
   * The narrow grant of assignee.ts: `p` holds no approvals.requests.act, but the author named them (holding a
   * widened role such as Sales) as the approver of this one step. Grants nothing on any other request or step.
   */
  private outsideRoleAssignment(
    p: Principal,
    request: RequestRow,
    step: StepRow,
    data: DirectoryData,
  ): boolean {
    if (
      p.status !== 'active' ||
      p.orgKind !== 'staff' ||
      p.tenantId !== request.tenantId ||
      p.organizationId !== request.organizationId
    ) {
      return false;
    }
    const assigned = effectiveAssignee(request.facts, request.documentType, step, data);
    return (
      assigned !== null &&
      assigned.outsideRole &&
      assigned.userId === p.userId &&
      outsideRoleAssigneeRoles(request.documentType).some((r) => p.roles.includes(r))
    );
  }

  /** An exact retry by a user named outside the step's role, of the decision they made on that step. */
  private async outsideRoleReplay(
    q: Q,
    p: Principal,
    request: RequestRow,
    previous: typeof approvalActions.$inferSelect,
    hash: Buffer,
  ): Promise<boolean> {
    const widened = outsideRoleAssigneeRoles(request.documentType);
    if (
      widened.length === 0 ||
      !widened.some((r) => p.roles.includes(r)) ||
      previous.requestId !== request.id ||
      previous.actorUserId !== p.userId ||
      !previous.requestHash?.equals(hash) ||
      previous.stepId === null
    ) {
      return false;
    }
    const step = (await this.stepsOf(q, request.id)).find((s) => s.id === previous.stepId);
    return step !== undefined && assigneeOf(request.facts, step.seq) === p.userId;
  }

  /**
   * Whether `userId` may decide `step`, and for whom. Without a named approver this is the directory's answer
   * for the step. With one (assignee.ts), only they may, or a delegate acting for them when they hold the
   * step's own role; `assigned` says the step was narrowed, for the refusal message.
   */
  private decider(
    request: Pick<RequestRow, 'facts' | 'documentType'>,
    step: StepRow,
    data: DirectoryData,
    now: Date,
    userId: string,
    preferNot: ReadonlySet<string>,
  ): { eligible: boolean; onBehalfOf: string | null; outsideRole: boolean; assigned: boolean } {
    const assigned = effectiveAssignee(request.facts, request.documentType, step, data);
    if (assigned === null) {
      const who = this.directory(data, now, request.documentType).resolveActor(
        stepSpecOf(step, data),
        userId,
        preferNot,
      );
      return { ...who, outsideRole: false, assigned: false };
    }
    const named = { outsideRole: assigned.outsideRole, assigned: true };
    if (userId === assigned.userId) return { eligible: true, onBehalfOf: null, ...named };
    const delegate =
      !assigned.outsideRole &&
      data.delegations.some(
        (d) =>
          d.fromUserId === assigned.userId &&
          d.toUserId === userId &&
          delegationActive(d, now, request.documentType),
      );
    return { eligible: delegate, onBehalfOf: delegate ? assigned.userId : null, ...named };
  }

  /**
   * The people told about `step` when it names an approver: that person, plus their active delegates when they
   * hold the step's own role, minus the request's SoD users. Undefined when the step names nobody (the caller
   * then uses the step's normal eligible people).
   */
  assignedApprovers(
    request: { facts: unknown; documentType: string; sodUserIds: readonly string[] },
    step: { seq: number; kind: string; roleKey: string | null },
    data: DirectoryData,
    now: Date,
  ): string[] | undefined {
    const assigned = effectiveAssignee(request.facts, request.documentType, step, data);
    if (assigned === null) return undefined;
    const sod = new Set(request.sodUserIds);
    const delegates = assigned.outsideRole
      ? []
      : data.delegations
          .filter(
            (d) =>
              d.fromUserId === assigned.userId && delegationActive(d, now, request.documentType),
          )
          .map((d) => d.toUserId);
    return [...new Set([assigned.userId, ...delegates])].filter((id) => !sod.has(id));
  }

  /**
   * Routes an open request again with today's people (after an admin fixed a role or a group). The step
   * list is fixed by the frozen spec and facts, so only eligibility can change: a blocked request with an
   * approver for every step becomes pending; a pending one that lost all approvers becomes blocked.
   */
  async reroute(requestId: string): Promise<ApprovalRequestDto> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const now = this.clock();
      const request = await this.lockRequest(tx, scope, requestId);
      if (request.status !== 'pending' && request.status !== 'blocked') {
        throw new ConflictException(
          `The request is ${request.status}; only open requests can be rerouted`,
        );
      }
      const steps = await this.stepsOf(tx, requestId);
      const spec = routingSpecOf(
        request.facts,
        await this.frozenSpec(tx, request.workflowVersionId),
        steps,
      );
      const data = await this.loadDirectory(tx, scope, spec);
      // The decisions so far go into routing: under distinctApprovers whoever decided an earlier step
      // cannot decide a later one, so a later step with only them left is blocked, not pending forever.
      const plan = this.plan(
        spec,
        request.facts as Record<string, unknown>,
        data,
        request.sodUserIds,
        decisionsOf(steps),
      );
      const current = steps.find((s) => s.seq === request.currentSeq)!;
      const open = plan.steps.filter((s) => s.seq >= request.currentSeq);
      const blocked = open.some((s) => s.blocked);
      const blockReason = blocked ? (plan.blockReason ?? 'No eligible approver') : null;
      const newVersion = request.version + 1;

      // A department head named, changed or gone since submit moves an open department_head step to
      // the new head or its fallback role, so act() and the inbox use what this plan resolved.
      for (const s of steps.filter((row) => row.seq >= request.currentSeq)) {
        const planned = plan.steps.find((p) => p.seq === s.seq);
        const target = retarget(s, planned);
        if (Object.keys(target).length > 0) {
          await tx.update(approvalSteps).set(target).where(eq(approvalSteps.id, s.id));
        }
      }

      if (blocked) {
        await tx
          .update(approvalSteps)
          .set({ status: 'waiting', activatedAt: null, remindAt: null, escalateAt: null })
          .where(eq(approvalSteps.id, current.id));
      } else if (request.status === 'blocked') {
        await tx
          .update(approvalSteps)
          .set(activation(now, spec))
          .where(eq(approvalSteps.id, current.id));
      }
      await tx
        .update(approvalRequests)
        .set({ status: blocked ? 'blocked' : 'pending', blockReason, version: newVersion })
        .where(eq(approvalRequests.id, requestId));
      await this.writeAction(tx, scope, {
        requestId,
        stepId: current.id,
        actorUserId: principal.userId,
        action: 'reroute',
        comment: blockReason,
        requestVersion: newVersion,
        now,
      });
      await this.audit.record(tx, {
        action: 'approvals.reroute',
        entityType: 'approval_request',
        entityId: requestId,
        before: { status: request.status, version: request.version },
        after: { status: blocked ? 'blocked' : 'pending', version: newVersion, blockReason },
      });
      if (!blocked && request.status === 'blocked') {
        const eligible =
          this.assignedApprovers(request, current, data, now) ??
          plan.steps.find((s) => s.seq === current.seq)?.eligibleUserIds ??
          [];
        await this.notifyApprovers(
          tx,
          requestId,
          request.documentNumber,
          request.title,
          eligible,
          current.seq,
          'pending',
        );
      }
      if (blocked && request.status === 'pending') {
        await this.notifyBlocked(tx, requestId, request.documentNumber, blockReason, newVersion);
      }
      return this.loadDto(tx, scope, requestId);
    });
  }

  /** P1-PLAN 6.2 "Blocked": whoever may fix role assignments (admin.roles.write) is told. */
  private async notifyBlocked(
    tx: DbTransaction,
    requestId: string,
    documentNumber: string,
    reason: string | null | undefined,
    version: number,
  ): Promise<void> {
    const { documentType } = await this.emailContext(tx, requestId);
    for (const role of BLOCKED_NOTICE_ROLES) {
      await this.notify.notifyRole(tx, role, {
        title: `Approval blocked: ${documentNumber}`,
        body: reason ?? 'No eligible approver',
        link: inboxLink(requestId),
        email: {
          template: 'approval.blocked',
          vars: emailVars({ documentNumber, documentType, linkPath: inboxLink(requestId) }),
        },
        // The version keeps a later block of the same request from being deduped against this one.
        dedupeKey: `approval:${requestId}:blocked:${version}`,
      });
    }
  }

  // ---- shared with the SLA tick ------------------------------------------------------------------

  /** The spec a request was submitted under (never the definition's current version). */
  async frozenSpec(q: Q, workflowVersionId: string): Promise<WorkflowSpec> {
    const [row] = await q
      .select({ spec: workflowVersions.spec })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, workflowVersionId));
    if (row === undefined) throw new Error(`workflow version ${workflowVersionId} is missing`);
    return WorkflowSpecSchema.parse(row.spec);
  }

  /** Loads the people the spec can route to: role holders, group members and delegations. */
  async loadDirectory(
    q: Q,
    scope: TxScope,
    spec: WorkflowSpec,
    /** Users named by stored steps rather than by `spec` (an explicit route read through the frozen spec). */
    extraUserIds: readonly string[] = [],
  ): Promise<DirectoryData> {
    const all = [...spec.steps, ...spec.rules.map((r) => r.add)];
    const roles = [
      ...new Set([
        ...outsideRoleAssigneeRoles(spec.documentType),
        ...all.flatMap((s) => {
          if (s.kind === 'role' && s.role !== undefined) return [s.role];
          // A department_head step may resolve to its fallback role (AD11).
          if (s.kind === 'department_head') {
            return [s.fallbackRole ?? DEFAULT_DEPARTMENT_HEAD_FALLBACK_ROLE];
          }
          return [];
        }),
      ]),
    ];
    const groupKeys = [
      ...new Set(
        all.flatMap((s) => (s.kind === 'group' && s.group !== undefined ? [s.group] : [])),
      ),
    ];

    const roleMembers = new Map<string, readonly string[]>();
    for (const role of roles) roleMembers.set(role, await this.users.userIdsWithRole(scope, role));

    const groups = new Map<string, { id: string; memberIds: string[] }>();
    if (groupKeys.length > 0) {
      const rows = await q
        .select({
          id: approvalGroups.id,
          key: approvalGroups.key,
          userId: appUsers.id,
        })
        .from(approvalGroups)
        .leftJoin(approvalGroupMembers, eq(approvalGroupMembers.groupId, approvalGroups.id))
        // Only active members of the request's entity approve, the same rule as userIdsWithRole
        // (ADR 0027 Â§3); an inactive member, or one without a membership in this entity, drops out
        // here, so their delegates (who act on their behalf) drop out with them.
        .leftJoin(
          appUsers,
          and(
            eq(appUsers.tenantId, approvalGroupMembers.tenantId),
            eq(appUsers.id, approvalGroupMembers.userId),
            eq(appUsers.status, 'active'),
            sql`EXISTS (SELECT 1 FROM ${userEntities} WHERE ${userEntities.tenantId} = ${appUsers.tenantId}
              AND ${userEntities.userId} = ${appUsers.id}
              AND ${userEntities.organizationId} = ${scope.organizationId})`,
          ),
        )
        .where(
          and(
            eq(approvalGroups.tenantId, scope.tenantId),
            eq(approvalGroups.organizationId, scope.organizationId),
            inArray(approvalGroups.key, groupKeys),
          ),
        );
      for (const r of rows) {
        const g = groups.get(r.key) ?? { id: r.id, memberIds: [] };
        if (r.userId !== null) g.memberIds.push(r.userId);
        groups.set(r.key, g);
      }
    }

    const delegationRows = await q
      .select({
        fromUserId: delegations.fromUserId,
        toUserId: delegations.toUserId,
        startsAt: delegations.startsAt,
        endsAt: delegations.endsAt,
        documentType: delegations.documentType,
        revokedAt: delegations.revokedAt,
      })
      .from(delegations)
      .where(
        and(
          eq(delegations.tenantId, scope.tenantId),
          eq(delegations.organizationId, scope.organizationId),
          isNull(delegations.revokedAt),
        ),
      );
    // The head map: every named head of this entity's departments, loaded only when a step needs it.
    const departmentHeads = new Map<string, string>();
    if (all.some((s) => s.kind === 'department_head')) {
      const rows = await q
        .select({ id: departments.id, headUserId: departments.headUserId })
        .from(departments)
        .where(
          and(
            eq(departments.tenantId, scope.tenantId),
            eq(departments.organizationId, scope.organizationId),
            isNotNull(departments.headUserId),
          ),
        );
      for (const r of rows) if (r.headUserId !== null) departmentHeads.set(r.id, r.headUserId);
    }
    // Heads count only while they are active members of the entity, the same rule as named users.
    const named = [
      ...new Set([
        ...all.flatMap((s) => (s.kind === 'user' && s.user !== undefined ? [s.user] : [])),
        ...departmentHeads.values(),
        ...extraUserIds,
      ]),
    ];
    // No named user: leave the set out (undefined). An empty set would mean "nobody is active", which would
    // silently block a user step the caller did not list (the SLA tick reads an explicit route through the
    // frozen spec, which names no one); the router only consults the set for user and department-head steps.
    const activeUserIds =
      named.length === 0 ? undefined : new Set(await this.activeUserIds(q, scope, named));
    return {
      roleMembers,
      groups,
      delegations: delegationRows,
      ...(activeUserIds === undefined ? {} : { activeUserIds }),
      departmentHeads,
    };
  }

  /** The ids among `ids` of active staff users of this tenant with a membership in the entity. */
  activeUserIds(q: Q, scope: TxScope, ids: readonly string[]): Promise<string[]> {
    return activeEntityStaff(q, scope, ids);
  }

  directory(
    data: DirectoryData,
    now: Date,
    documentType: string,
    sodUserIds: readonly string[] = [],
  ): BuiltDirectory {
    return buildDirectory(data, { now, documentType, sodUserIds });
  }

  async notifyApprovers(
    tx: DbTransaction,
    requestId: string,
    documentNumber: string,
    title: string,
    userIds: readonly string[],
    seq: number,
    kind: 'pending' | 'reminder',
  ): Promise<void> {
    // Read from the request row, not passed in: the SLA tick calls this too and has no other way to know them.
    const { documentType, requesterName } = await this.emailContext(tx, requestId);
    for (const userId of userIds) {
      await this.notify.notifyUser(tx, {
        userId,
        title:
          kind === 'pending'
            ? `Approval needed: ${documentNumber}`
            : `Reminder: ${documentNumber} awaits you`,
        body: title,
        link: inboxLink(requestId),
        email: {
          template: kind === 'pending' ? 'approval.pending' : 'approval.reminder',
          vars: emailVars({
            documentNumber,
            documentType,
            requesterName,
            linkPath: inboxLink(requestId),
          }),
        },
        dedupeKey: `approval:${requestId}:${seq}:${kind}`,
      });
    }
  }

  /** What the approval emails say about a request: its type and who asked. Name falls back to the email's local part. */
  private async emailContext(
    tx: DbTransaction,
    requestId: string,
  ): Promise<{ documentType: string | undefined; requesterName: string | undefined }> {
    const [row] = await tx
      .select({
        documentType: approvalRequests.documentType,
        requesterUserId: approvalRequests.requesterUserId,
      })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    return {
      documentType: row?.documentType,
      requesterName: row === undefined ? undefined : await this.displayName(row.requesterUserId),
    };
  }

  /**
   * A person's name for an email. UserDirectory has no display name yet, so this is the local part of the
   * address ("sita.sharma" from sita.sharma@..). Never throws: a lookup problem must not roll back a decision,
   * and the template has a neutral default for a missing name.
   */
  private async displayName(userId: string): Promise<string | undefined> {
    try {
      const email = await this.users.emailOf(userId);
      const local = email?.split('@')[0]?.trim();
      return local === undefined || local === '' ? undefined : local;
    } catch {
      return undefined;
    }
  }

  async writeAction(
    tx: DbTransaction,
    scope: TxScope,
    a: {
      requestId: string;
      stepId?: string;
      actorUserId: string | null;
      onBehalfOfUserId?: string | null;
      action: (typeof approvalActions.$inferInsert)['action'];
      comment?: string | null;
      idempotencyKey?: string;
      requestHash?: Buffer;
      requestVersion: number;
      result?: unknown;
      now: Date;
    },
  ): Promise<void> {
    await tx.insert(approvalActions).values({
      ...scope,
      requestId: a.requestId,
      stepId: a.stepId ?? null,
      actorUserId: a.actorUserId,
      onBehalfOfUserId: a.onBehalfOfUserId ?? null,
      action: a.action,
      comment: a.comment ?? null,
      idempotencyKey: a.idempotencyKey ?? null,
      requestHash: a.requestHash ?? null,
      requestVersion: a.requestVersion,
      result: a.result ?? null,
      createdAt: a.now,
    });
  }

  async loadDto(q: Q, scope: TxScope, requestId: string): Promise<ApprovalRequestDto> {
    const [request] = await q
      .select()
      .from(approvalRequests)
      .where(requestInScope(scope, requestId));
    if (request === undefined) throw new NotFoundException('Approval request not found');
    const steps = await this.stepsOf(q, requestId);
    const actions = await q
      .select()
      .from(approvalActions)
      .where(eq(approvalActions.requestId, requestId))
      .orderBy(asc(approvalActions.createdAt), asc(approvalActions.id));
    return {
      requestId: request.id,
      documentType: request.documentType,
      documentId: request.documentId,
      documentNumber: request.documentNumber,
      status: request.status,
      blockReason: request.blockReason,
      currentSeq: request.currentSeq,
      version: request.version,
      requesterUserId: request.requesterUserId,
      snapshot: request.snapshot,
      steps: steps.map((s) => stepDto(s, request.facts)),
      actions: actions.map((a) => ({
        action: a.action,
        actorUserId: a.actorUserId ?? 'system',
        onBehalfOfUserId: a.onBehalfOfUserId,
        comment: a.comment,
        createdAt: a.createdAt.toISOString(),
      })),
      submittedAt: request.submittedAt.toISOString(),
      decidedAt: request.decidedAt?.toISOString() ?? null,
    };
  }

  // ---- private helpers ---------------------------------------------------------------------------

  private plan(
    spec: WorkflowSpec,
    facts: Record<string, unknown>,
    data: DirectoryData,
    sodUserIds: readonly string[],
    decisions: readonly StepDecision[] = [],
  ): RoutePlan {
    try {
      return route(
        spec,
        facts,
        this.directory(data, this.clock(), spec.documentType, sodUserIds),
        sodUserIds,
        decisions,
      );
    } catch (error) {
      if (error instanceof ConditionError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  private async publishedSpec(q: Q, scope: TxScope, documentType: string) {
    const [row] = await q
      .select({
        definitionId: workflowDefinitions.id,
        versionId: workflowVersions.id,
        spec: workflowVersions.spec,
        status: workflowVersions.status,
      })
      .from(workflowDefinitions)
      .innerJoin(workflowVersions, eq(workflowVersions.id, workflowDefinitions.currentVersionId))
      .where(
        and(
          eq(workflowDefinitions.tenantId, scope.tenantId),
          eq(workflowDefinitions.organizationId, scope.organizationId),
          eq(workflowDefinitions.documentType, documentType),
        ),
      );
    if (row === undefined || row.status !== 'published') {
      throw new ConflictException(`No published approval workflow for "${documentType}"`);
    }
    return {
      definitionId: row.definitionId,
      versionId: row.versionId,
      spec: WorkflowSpecSchema.parse(row.spec),
    };
  }

  private async lockRequest(
    tx: DbTransaction,
    scope: TxScope,
    requestId: string,
  ): Promise<RequestRow> {
    const [request] = await tx
      .select()
      .from(approvalRequests)
      .where(requestInScope(scope, requestId))
      // NO KEY UPDATE, not UPDATE: still serialises two deciders, but does not block the FOR KEY SHARE
      // that every approval_actions/approval_steps FK check takes on this row (the SLA tick's inserts).
      .for('no key update');
    if (request === undefined) throw new NotFoundException('Approval request not found');
    return request;
  }

  private stepsOf(q: Q, requestId: string): Promise<StepRow[]> {
    return q
      .select()
      .from(approvalSteps)
      .where(eq(approvalSteps.requestId, requestId))
      .orderBy(asc(approvalSteps.seq));
  }

  private subjectOf(documentType: string): ApprovalSubject {
    const s = this.subjects.get(documentType);
    if (s === undefined) throw new Error(`no approval subject registered for "${documentType}"`);
    return s;
  }
}

/**
 * The ids among `ids` of active staff users of the tenant who have a membership in the scope's entity
 * (ADR 0027 Â§3): `app.users` is tenant-scoped, so the entity comes from `app.user_entities`, and the
 * staff IdP org tells staff from portal users. Shared with the admin service's user checks.
 */
export async function activeEntityStaff(
  q: Q,
  scope: TxScope,
  ids: readonly string[],
): Promise<string[]> {
  const rows = await q
    .select({ id: appUsers.id })
    .from(appUsers)
    .innerJoin(
      userEntities,
      and(
        eq(userEntities.tenantId, appUsers.tenantId),
        eq(userEntities.userId, appUsers.id),
        eq(userEntities.organizationId, scope.organizationId),
      ),
    )
    .innerJoin(
      idpOrgs,
      and(eq(idpOrgs.tenantId, appUsers.tenantId), eq(idpOrgs.id, appUsers.idpOrgId)),
    )
    .where(
      and(
        eq(appUsers.tenantId, scope.tenantId),
        eq(appUsers.status, 'active'),
        eq(idpOrgs.kind, 'staff'),
        inArray(appUsers.id, [...ids]),
      ),
    );
  return rows.map((r) => r.id);
}

/** Scope and actor live in the transaction (withTx set them); the kernel never reads ctx() here. */
async function scopeOf(tx: DbTransaction): Promise<TxScope> {
  const result = await tx.execute<{ tenant_id: string | null; organization_id: string | null }>(
    sql`SELECT current_setting('bos.tenant_id', true) AS tenant_id, current_setting('bos.organization_id', true) AS organization_id`,
  );
  const row = result.rows[0];
  if (!row?.tenant_id || !row.organization_id) {
    throw new Error('submit() needs a transaction opened with withTx (bos.tenant_id is not set)');
  }
  return { tenantId: row.tenant_id, organizationId: row.organization_id };
}

function requestInScope(scope: TxScope, requestId: string) {
  return and(
    eq(approvalRequests.id, requestId),
    eq(approvalRequests.tenantId, scope.tenantId),
    eq(approvalRequests.organizationId, scope.organizationId),
  );
}

/** A step becomes active: its reminder and escalation times come from the frozen spec's SLA. */
function activation(now: Date, spec: WorkflowSpec) {
  return {
    status: 'active' as const,
    activatedAt: now,
    remindAt: addHours(now, spec.sla.remindAfterHours),
    escalateAt: addHours(now, spec.sla.escalateAfterHours),
  };
}

/** Who decided each decided step: the decider and, for a delegate, the approver they acted for. */
function decisionsOf(
  steps: readonly Pick<StepRow, 'seq' | 'decidedBy' | 'decidedOnBehalfOf'>[],
): StepDecision[] {
  return steps.flatMap((s) => {
    const deciders = [s.decidedBy, s.decidedOnBehalfOf].filter((id): id is string => id !== null);
    return deciders.length === 0 ? [] : [{ seq: s.seq, deciders }];
  });
}

/** Everyone who decided a step before `seq` (the distinctApprovers exclusion for that step). */
function earlierDeciders(decisions: readonly StepDecision[], seq: number): Set<string> {
  return new Set(decisions.filter((d) => d.seq < seq).flatMap((d) => [...d.deciders]));
}

/**
 * The columns that move a stored department_head step to the head or fallback role `planned` resolved
 * to, or nothing when it already matches (and always nothing for the other kinds, whose target is fixed).
 */
function retarget(
  row: StepRow,
  planned: RoutePlan['steps'][number] | undefined,
): { userId?: string | null; roleKey?: string | null } {
  if (row.kind !== 'department_head' || planned === undefined) return {};
  const userId = planned.userId ?? null;
  const roleKey = planned.roleKey ?? null;
  return row.userId === userId && row.roleKey === roleKey ? {} : { userId, roleKey };
}

/**
 * The spec an open request routes by. An explicit-route request (marked in its facts, and made only of user
 * steps) is rebuilt from its stored step rows; every other request, including all submitted before the marker
 * existed, routes by the frozen workflow spec unchanged.
 */
function routingSpecOf(
  facts: unknown,
  frozen: WorkflowSpec,
  steps: readonly StepRow[],
): WorkflowSpec {
  const marked =
    facts !== null &&
    typeof facts === 'object' &&
    (facts as Record<string, unknown>)[EXPLICIT_ROUTE_FACT] === EXPLICIT_ROUTE_VALUE;
  const allNamed = steps.length > 0 && steps.every((s) => s.kind === 'user' && s.userId !== null);
  if (!marked || !allNamed) return frozen;
  return explicitSpecOf(
    frozen,
    steps.map((s) => ({ userId: s.userId!, reason: s.reason })),
  );
}

/** Rebuilds the routing view of a stored step (group id back to its key) for the directory. */
export function stepSpecOf(step: StepRow, data: DirectoryData): StepSpec {
  const base = { id: `seq-${step.seq}`, reason: step.reason };
  if (step.kind === 'role') return { ...base, kind: 'role', role: step.roleKey as RoleKey };
  if (step.kind === 'user') return { ...base, kind: 'user', user: step.userId ?? '' };
  // A department_head row stores what the router resolved it to: the head (user_id) or the fallback
  // role (role_key), so it is acted on exactly like that user or role step.
  if (step.kind === 'department_head') {
    if (step.userId !== null) return { ...base, kind: 'user', user: step.userId };
    return { ...base, kind: 'role', role: (step.roleKey ?? '') as RoleKey };
  }
  const key = [...data.groups.entries()].find(([, g]) => g.id === step.groupId)?.[0];
  return { ...base, kind: 'group', group: key ?? `missing:${step.groupId ?? ''}` };
}

/**
 * Whether the decider holds the role the step needs, from the token (the role mirror lags ZITADEL). A delegate
 * acts on the delegator's mirror roles (there is no token to check), and a user named outside the step's role
 * (assignee.ts) must hold one of the widened roles instead.
 */
function holdsStepRole(
  p: Principal,
  documentType: string,
  step: StepRow,
  who: { onBehalfOf: string | null; outsideRole: boolean },
): boolean {
  if (who.onBehalfOf !== null || step.roleKey === null) return true;
  if (who.outsideRole)
    return outsideRoleAssigneeRoles(documentType).some((r) => p.roles.includes(r));
  return p.roles.includes(step.roleKey as RoleKey);
}

/** A staff user who may be named on a step outside its role: their empty inbox is a list, not a 403. */
function mayBeNamedOutsideRole(p: Principal): boolean {
  return (
    p.status === 'active' &&
    p.orgKind === 'staff' &&
    // Any document type with a widening; today only quotation_version (assignee.ts).
    outsideRoleAssigneeRoles('quotation_version').some((r) => p.roles.includes(r))
  );
}

/** 422 for a named approver who may not decide the first step (or is the author). */
function approverNotEligible(self: boolean): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'APPROVER_NOT_ELIGIBLE',
    message: self
      ? 'You prepared this document, so you cannot approve it. Choose someone else.'
      : 'The chosen approver cannot approve this document. Choose someone from the list.',
  });
}

function stepDto(s: StepRow, facts: unknown): ApprovalRequestDto['steps'][number] {
  return {
    seq: s.seq,
    kind: s.kind,
    roleKey: (s.roleKey as RoleKey | null) ?? null,
    groupId: s.groupId,
    userId: s.userId,
    reason: s.reason,
    status: s.status,
    activatedAt: s.activatedAt?.toISOString() ?? null,
    decidedBy: s.decidedBy,
    decidedOnBehalfOf: s.decidedOnBehalfOf,
    assigneeUserId: assigneeOf(facts, s.seq),
  };
}
