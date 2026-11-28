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
  DecimalString,
  MemoTemplateSnapshotSchema,
  WorkflowSpecSchema,
  type ApprovalActionBody,
  type ApprovalContext,
  type ApprovalRequestDto,
  type InboxItemDto,
  type ReferenceName,
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
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, eq, getTableColumns, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { can } from '../../platform/authz/can';
import type { Principal } from '../../platform/authz/principal';
import { RoleCache } from '../../platform/authz/role-cache';
import { UserDirectory } from '../../platform/authz/user-directory';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { canonicalSha256 } from '../../platform/hashing/canonical-json';
import { exactMatch } from '../../platform/list';
import { nameIn, personNameMap, personNames } from '../../platform/users/person-names';
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
import { requestVisibleTo } from './snapshot-visibility';

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
   * Optional: runs after the transaction that decided the request (and ran onDecided) has committed, for work that must
   * see the decision and must not hold the decision up, such as enqueueing a render. It cannot roll anything back: an
   * error is logged and the decision stands. Not called for a replay. `snapshot` is the request's frozen snapshot.
   */
  afterDecided?(decided: {
    scope: TxScope;
    documentId: string;
    outcome: 'approved' | 'returned' | 'rejected';
    snapshot: unknown;
  }): Promise<void>;
  /**
   * Optional: the workspace page of the document, for the decided notice to the requester (for example
   * `/memos/<id>`). Without it the requester is sent to the request in the inbox. The path must be an area
   * the `approval.decided` email allows (notify/templates.ts), else the notice fails at enqueue.
   * Runs in the deciding transaction, before onDecided, so it may read the document (a quotation version
   * links to its quotation). Undefined also falls back to the inbox.
   */
  link?(tx: DbTransaction, documentId: string): string | undefined | Promise<string | undefined>;
  /**
   * Optional: names for the records the frozen snapshot refers to by id (a vendor, an order), read in the request's
   * tenant and entity when a reader who may already see this request opens it. The snapshot itself is never
   * changed; an id the subject cannot name is left out, and the page says the name is unavailable.
   */
  referenceNames?(q: Db, scope: TxScope, snapshot: unknown): Promise<ReferenceName[]>;
  /**
   * Optional: the record as it stands now, for `viewer`, who may already read this request (an approver needs no read
   * grant on the record). Main fields and the record's own files only; files and the link to the record's page are
   * gated on `viewer`'s grants (context.ts). Null when the record is gone. Only the plain read (get) asks for it.
   */
  context?(
    q: Db,
    scope: TxScope,
    request: { documentId: string; snapshot: unknown },
    viewer: Principal,
  ): Promise<ApprovalContext | null>;
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
/** The stored step fields used to resolve a routing target. */
type AssignmentStep = Pick<StepRow, 'seq' | 'kind' | 'userId' | 'roleKey' | 'groupId'> & {
  reason?: string;
};
/** What the assignment checks read of a request. */
type AssignmentRequest = Pick<
  RequestRow,
  'tenantId' | 'organizationId' | 'documentType' | 'facts' | 'sodUserIds'
>;
const {
  snapshot: _snapshot,
  snapshotSha256: _snapshotSha256,
  ...INBOX_REQUEST_COLUMNS
} = getTableColumns(approvalRequests);
/** Frozen specs kept in memory; a published version never changes, so an entry never goes stale. */
const SPEC_CACHE_SIZE = 64;

const HOUR_MS = 3_600_000;
const addHours = (d: Date, h: number) => new Date(d.getTime() + h * HOUR_MS);
/** Whoever holds this is told about a blocked request: they may fix role assignments. */
const BLOCKED_NOTICE_PERMISSION = 'admin.roles.write' as const;

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
  private readonly specCache = new Map<string, WorkflowSpec>();
  private readonly log = new Logger(ApprovalsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: ApprovalsAudit,
    private readonly notify: ApprovalsNotify,
    private readonly users: UserDirectory,
    private readonly caller: ApprovalsCaller,
    @Inject(APPROVALS_CLOCK) private readonly clock: Clock,
    // Optional and last: the worker process (SLA tick) has no AuthzModule, and a hand-built service keeps working.
    // Either way the fallback reads the same live rows, only without the shared cache.
    @Optional() private readonly roleCache: RoleCache = new RoleCache(db),
  ) {}

  /**
   * The roles told when a request has nobody who may decide it: those whose live grants in this tenant hold
   * admin.roles.write, so a role the Founder gave it hears too, and one it was taken from does not. The document
   * services that refuse a blocked submit before any request exists use the same list.
   */
  async blockedNoticeRoles(tenantId: string): Promise<RoleKey[]> {
    return this.roleCache.rolesGranting(tenantId, BLOCKED_NOTICE_PERMISSION);
  }

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
   * The plan of a document type's published workflow, not redacted, for a module that checks a person it names
   * against the workflow (the memo's "Approved by" against the Memo approver workflow, F1-Q9). No HTTP route reaches
   * it; the caller decides what to show. With no published workflow for the type, plans `builtIn` when given (the
   * rule the type starts with), else 409. Read-only.
   */
  async planOf(
    scope: TxScope,
    documentType: string,
    facts: Record<string, unknown>,
    sodUserIds: readonly string[],
    q: Q = this.db,
    builtIn?: WorkflowSpec,
  ): Promise<RoutePlan> {
    const spec = await this.publishedSpec(q, scope, documentType).then(
      (published) => published.spec,
      (error: unknown) => {
        if (builtIn !== undefined && error instanceof ConflictException) return builtIn;
        throw error;
      },
    );
    const data = await this.loadDirectory(q, scope, spec);
    return this.plan(spec, facts, data, sodUserIds);
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
      await this.notifyBlocked(tx, scope.tenantId, requestId, documentNumber, plan.blockReason, 1);
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

    /** Set when this call decided the request: the subject's afterDecided runs once the decision commits. */
    let decision:
      | {
          documentType: string;
          documentId: string;
          outcome: 'approved' | 'returned' | 'rejected';
          snapshot: unknown;
        }
      | undefined;
    // The stored result (kept for replays) and the row keep the full snapshot; only the answer is filtered (D29).
    const result = await withTx(this.db, scope, actor, async (tx) => {
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
            eq(approvalActions.organizationId, scope.organizationId),
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
      const steps = await this.stepsOf(tx, request);
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
              deciderName: await this.displayName(tx, scope.tenantId, userId),
              linkPath: requesterLink,
            }),
          },
          dedupeKey: `approval:${requestId}:decided`,
        });
        // 7. Tell the document. Same transaction: if it fails, the decision rolls back too.
        await this.subjectOf(request.documentType).onDecided(tx, request.documentId, outcome);
        decision = {
          documentType: request.documentType,
          documentId: request.documentId,
          outcome,
          snapshot: request.snapshot,
        };
      } else if (blocked) {
        await this.notifyBlocked(
          tx,
          scope.tenantId,
          requestId,
          request.documentNumber,
          blockReason,
          newVersion,
        );
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
    if (decision !== undefined) await this.afterDecided(scope, decision);
    return requestVisibleTo(principal, result);
  }

  /** The subject's post-commit hook, if it has one. Never throws: the decision has committed. */
  private async afterDecided(
    scope: TxScope,
    d: {
      documentType: string;
      documentId: string;
      outcome: 'approved' | 'returned' | 'rejected';
      snapshot: unknown;
    },
  ): Promise<void> {
    const subject = this.subjectOf(d.documentType);
    if (subject.afterDecided === undefined) return;
    try {
      await subject.afterDecided({
        scope,
        documentId: d.documentId,
        outcome: d.outcome,
        snapshot: d.snapshot,
      });
    } catch (error) {
      this.log.warn(
        `afterDecided failed for ${d.documentType} ${d.documentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    const current = (await this.stepsOf(tx, request)).find((s) => s.seq === request.currentSeq);
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

  async inboxPage(query: InboxQuery): Promise<{ items: InboxItemDto[]; total: number }> {
    const { scope, principal } = this.caller.current();
    const read = await this.inboxSelection(scope, principal, query);
    const page = this.db
      .select({
        request: INBOX_REQUEST_COLUMNS,
        step: approvalSteps,
        total: sql<number>`count(*) over ()`.mapWith(Number),
      })
      .from(approvalRequests)
      .innerJoin(approvalSteps, read.join)
      .innerJoin(read.rules, read.match)
      .where(read.where)
      .orderBy(asc(approvalRequests.submittedAt), asc(approvalRequests.id))
      .offset(query.offset ?? 0)
      .$dynamic();
    const rows = await (query.limit === undefined ? page : page.limit(query.limit));
    const total =
      rows[0]?.total ?? (query.offset || query.limit === 0 ? await this.selectionCount(read) : 0);
    if (!read.generic && total === 0) {
      if (query.q !== undefined || query.documentType?.length) await this.inboxCount();
      else await this.refuseWithoutAssignment(scope, principal, false, 0);
    }
    const items = rows.map(({ request, step }) => {
      const amount = (request.facts as Record<string, unknown>)['amountNpr'];
      return {
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
      };
    });
    return { items, total };
  }

  private async selectionCount(read: Awaited<ReturnType<ApprovalsService['inboxSelection']>>) {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(approvalRequests)
      .innerJoin(approvalSteps, read.join)
      .innerJoin(read.rules, read.match)
      .where(read.where);
    return row!.count;
  }

  async inboxCount(): Promise<{ count: number }> {
    const { scope, principal } = this.caller.current();
    const read = await this.inboxSelection(scope, principal, {});
    const count = await this.selectionCount(read);
    await this.refuseWithoutAssignment(scope, principal, read.generic, count);
    return { count };
  }

  async inboxSummary() {
    const { scope, principal } = this.caller.current();
    const read = await this.inboxSelection(scope, principal, {});
    const now = this.clock();
    const age = sql<
      'under_day' | 'under_week' | 'week_or_more'
    >`case when ${approvalRequests.submittedAt} > ${addHours(now, -24).toISOString()}::timestamptz then 'under_day'
      when ${approvalRequests.submittedAt} > ${addHours(now, -168).toISOString()}::timestamptz then 'under_week' else 'week_or_more' end`;
    const buckets = await this.db
      .select({
        documentType: approvalRequests.documentType,
        state: approvalRequests.status,
        age,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(approvalRequests)
      .innerJoin(approvalSteps, read.join)
      .innerJoin(read.rules, read.match)
      .where(read.where)
      .groupBy(approvalRequests.documentType, approvalRequests.status, sql`3`);
    await this.refuseWithoutAssignment(scope, principal, read.generic, buckets.length);
    return buckets;
  }

  /** The inbox 403: no generic grant, nothing eligible, and no duty that makes an empty inbox a list. */
  private async refuseWithoutAssignment(
    scope: TxScope,
    principal: Principal,
    genericApprover: boolean,
    unfilteredCount: number,
  ): Promise<void> {
    if (
      !genericApprover &&
      unfilteredCount === 0 &&
      !mayBeNamedOutsideRole(principal) &&
      !(await this.hasPrHeadDuty(scope, principal))
    ) {
      throw forbidden('out_of_scope', 'You have no approval assignment');
    }
  }

  /** Resolve each distinct assignment once. SQL checks request-specific exclusions for both
   * the actor and at least one identity they can represent, before it pages or aggregates. */
  private async inboxSelection(scope: TxScope, principal: Principal, query: InboxQuery) {
    this.requireStaff(scope, principal);
    const generic = can(principal, 'approvals.requests.act').allowed;
    const r = approvalRequests,
      s = approvalSteps;
    const join = and(eq(s.requestId, r.id), eq(s.seq, r.currentSeq))!;
    const base = and(
      eq(r.tenantId, scope.tenantId),
      eq(r.organizationId, scope.organizationId),
      eq(r.status, 'pending'),
      eq(s.status, 'active'),
      query.documentType?.length ? inArray(r.documentType, query.documentType) : undefined,
      query.q === undefined
        ? undefined
        : exactMatch(query.q, [r.title, r.documentNumber, s.reason]),
    );
    // A head without a generic grant must still match today's routing plan. Only that
    // case needs the full routing facts and separation-of-duties inputs in the key.
    const head = generic
      ? sql`false`
      : sql`${r.documentType}='purchase_request' and ${s.kind}='department_head'`;
    const facts = sql<Record<
      string,
      unknown
    > | null>`case when ${head} then ${r.facts} else nullif(${r.facts}->'assignedApprover','null'::jsonb) end`;
    const sod = sql<string[] | null>`case when ${head} then ${r.sodUserIds} end`;
    const keys = await this.db
      .selectDistinct({
        version: r.workflowVersionId,
        document: r.documentType,
        seq: s.seq,
        kind: s.kind,
        role: s.roleKey,
        target: s.userId,
        team: s.groupId,
        facts,
        sod,
      })
      .from(r)
      .innerJoin(s, join)
      .where(base);

    const specs = await this.frozenSpecs(this.db, [...new Set(keys.map((k) => k.version))]);
    const users = [
      ...new Set(keys.flatMap((k) => (k.kind === 'user' && k.target ? [k.target] : []))),
    ];
    const data = await this.loadDirectoryFor(this.db, scope, [...specs.values()], users);
    const views = new Map([...specs].map(([id, spec]) => [id, directoryViewOf(data, spec, users)]));
    const now = this.clock();
    const rules = [];
    for (const key of keys) {
      const documentType = key.document;
      const step = {
        seq: key.seq,
        kind: key.kind,
        userId: key.target,
        groupId: key.team,
        roleKey: key.role,
      };
      const request = {
        ...scope,
        documentType,
        facts: key.sod ? key.facts : { assignedApprover: key.facts },
        sodUserIds: key.sod ?? [],
      };
      const spec = specs.get(key.version)!;
      const view = views.get(key.version)!;
      if (
        !generic &&
        !this.prHeadAssignment(principal, request, step, spec, view, now) &&
        !this.outsideRoleAssignment(principal, request, step, view)
      )
        continue;
      const identities = new Set<string>();
      for (;;) {
        const who = this.decider(request, step, view, now, principal.userId, identities);
        const identity = who.onBehalfOf ?? principal.userId;
        if (
          !who.eligible ||
          !holdsStepRole(principal, documentType, step, who) ||
          identities.has(identity)
        )
          break;
        identities.add(identity);
        if (!who.onBehalfOf || who.assigned) break;
      }
      if (identities.size)
        rules.push({
          ...key,
          identities: [...identities],
          distinct_approvers: spec.distinctApprovers,
        });
    }
    const actor = principal.userId;
    const ruleTable = sql`jsonb_to_recordset(${JSON.stringify(rules)}::jsonb)
        as rule(version uuid, document text, seq int, kind text, role text, target uuid, team uuid,
          facts jsonb, sod uuid[], identities uuid[], distinct_approvers boolean)`;
    const match = sql`rule.version=${r.workflowVersionId} and rule.document=${r.documentType}
        and rule.seq=${s.seq} and rule.kind=${s.kind}
        and rule.role is not distinct from ${s.roleKey} and rule.target is not distinct from ${s.userId}
        and rule.team is not distinct from ${s.groupId} and rule.facts is not distinct from ${facts}
        and rule.sod is not distinct from ${sod}`;
    const eligible = sql`not (${actor}::uuid = any(${r.sodUserIds})) and exists (
        select 1 from unnest(rule.identities) as identity(id)
        where not (identity.id = any(${r.sodUserIds})) and
          (not rule.distinct_approvers or ${s.seq} = 1 or not exists (
            select 1 from ${approvalSteps} prior where prior.tenant_id=${r.tenantId}
              and prior.organization_id=${r.organizationId} and prior.request_id=${r.id}
              and prior.seq<${s.seq} and (prior.decided_by in (${actor}::uuid,identity.id)
                or prior.decided_on_behalf_of in (${actor}::uuid,identity.id)))))`;
    return { join, rules: ruleTable, match, where: and(base, eligible), generic };
  }

  /**
   * One request for its requester, a generic reader, its currently eligible PR department head or named assignee, or
   * anyone with an action on it (a head who decided keeps reading it).
   */
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
    const { scope, principal } = this.caller.current();
    const dto = requestVisibleTo(principal, await this.loadDto(this.db, scope, requestId));
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
    const subject = this.subjects.get(dto.documentType);
    const references = await subject?.referenceNames?.(this.db, scope, dto.snapshot);
    const context = replay === undefined ? await this.contextOf(subject, dto, principal) : null;
    return {
      ...dto,
      people,
      ...(references !== undefined ? { references } : {}),
      ...(context !== null ? { context } : {}),
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
    // Whoever acted on this request (themselves or as a delegate), or the person a delegate acted for, keeps reading
    // it once their step has moved on: a department head or a named assignee who reloads the request they just
    // decided must not get a 404. A plain read only: deciding again still takes the checks below.
    if (replay === undefined && (await this.tookPart(scope, requestId, principal.userId))) return;
    if (request.documentType === 'purchase_request') {
      const steps = await this.stepsOf(this.db, request);
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
      const steps = await this.stepsOf(this.db, request);
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
    request: AssignmentRequest,
    step: AssignmentStep,
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
    const step = (await this.stepsOf(q, request)).find((s) => s.id === previous.stepId);
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

  /**
   * The subject's view of its record for this reader, or null. A record that cannot be described (gone, or a read
   * that fails) never stops the approver reading and deciding the request: the page simply shows no context.
   */
  private async contextOf(
    subject: ApprovalSubject | undefined,
    dto: ApprovalRequestDto,
    viewer: Principal,
  ): Promise<ApprovalContext | null> {
    if (subject?.context === undefined) return null;
    const { scope } = this.caller.current();
    try {
      return await subject.context(
        this.db,
        scope,
        { documentId: dto.documentId, snapshot: dto.snapshot },
        viewer,
      );
    } catch (error) {
      this.log.warn(
        `no context for ${dto.documentType} ${dto.documentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** True when `userId` has an action on the request, as its actor or as the person a delegate acted for. */
  private async tookPart(scope: TxScope, requestId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ requestId: approvalActions.requestId })
      .from(approvalActions)
      .where(
        and(
          eq(approvalActions.tenantId, scope.tenantId),
          eq(approvalActions.organizationId, scope.organizationId),
          eq(approvalActions.requestId, requestId),
          or(eq(approvalActions.actorUserId, userId), eq(approvalActions.onBehalfOfUserId, userId)),
        ),
      )
      .limit(1);
    return row !== undefined;
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
    request: AssignmentRequest,
    step: AssignmentStep,
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
    const step = (await this.stepsOf(q, request)).find((s) => s.id === previous.stepId);
    return step !== undefined && assigneeOf(request.facts, step.seq) === p.userId;
  }

  /**
   * Whether `userId` may decide `step`, and for whom. Without a named approver this is the directory's answer
   * for the step. With one (assignee.ts), only they may, or a delegate acting for them when they hold the
   * step's own role; `assigned` says the step was narrowed, for the refusal message.
   */
  private decider(
    request: Pick<RequestRow, 'facts' | 'documentType'>,
    step: AssignmentStep,
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
    const result = await withTx(this.db, scope, actor, async (tx) => {
      const now = this.clock();
      const request = await this.lockRequest(tx, scope, requestId);
      if (request.status !== 'pending' && request.status !== 'blocked') {
        throw new ConflictException(
          `The request is ${request.status}; only open requests can be rerouted`,
        );
      }
      const steps = await this.stepsOf(tx, request);
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
        await this.notifyBlocked(
          tx,
          scope.tenantId,
          requestId,
          request.documentNumber,
          blockReason,
          newVersion,
        );
      }
      return this.loadDto(tx, scope, requestId);
    });
    return requestVisibleTo(principal, result);
  }

  /** P1-PLAN 6.2 "Blocked": whoever may fix role assignments (admin.roles.write) is told. */
  private async notifyBlocked(
    tx: DbTransaction,
    tenantId: string,
    requestId: string,
    documentNumber: string,
    reason: string | null | undefined,
    version: number,
  ): Promise<void> {
    const { documentType } = await this.emailContext(tx, requestId);
    for (const role of await this.blockedNoticeRoles(tenantId)) {
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
    return (await this.frozenSpecs(q, [workflowVersionId])).get(workflowVersionId)!;
  }

  /**
   * `frozenSpec` for several versions in at most one statement. A frozen version never changes, so a spec read once
   * stays in a small least-recently-used map and costs no statement the next time. Callers must not mutate it.
   */
  async frozenSpecs(q: Q, versionIds: readonly string[]): Promise<Map<string, WorkflowSpec>> {
    const found = new Map<string, WorkflowSpec>();
    const missing: string[] = [];
    for (const id of versionIds) {
      const cached = this.specCache.get(id);
      if (cached === undefined) {
        missing.push(id);
        continue;
      }
      // Re-insert so the map's order stays oldest-used first.
      this.specCache.delete(id);
      this.specCache.set(id, cached);
      found.set(id, cached);
    }
    if (missing.length === 0) return found;
    const rows = await q
      .select({ id: workflowVersions.id, spec: workflowVersions.spec })
      .from(workflowVersions)
      .where(inArray(workflowVersions.id, missing));
    for (const row of rows) {
      const spec = WorkflowSpecSchema.parse(row.spec);
      this.specCache.set(row.id, spec);
      found.set(row.id, spec);
    }
    for (const id of missing) {
      if (!found.has(id)) throw new Error(`workflow version ${id} is missing`);
    }
    while (this.specCache.size > SPEC_CACHE_SIZE) {
      this.specCache.delete(this.specCache.keys().next().value!);
    }
    return found;
  }

  /** Loads the people the spec can route to: role holders, group members and delegations. */
  async loadDirectory(
    q: Q,
    scope: TxScope,
    spec: WorkflowSpec,
    /** Users named by stored steps rather than by `spec` (an explicit route read through the frozen spec). */
    extraUserIds: readonly string[] = [],
  ): Promise<DirectoryData> {
    return this.loadDirectoryFor(q, scope, [spec], extraUserIds);
  }

  /**
   * The directory of several specs at once: the union of their roles, groups, users and department heads, in one
   * read each. A spec's router only looks up the keys of its own steps, so the extra entries change no answer
   * (except `activeUserIds`: see `directoryViewOf`).
   */
  async loadDirectoryFor(
    q: Q,
    scope: TxScope,
    specs: readonly WorkflowSpec[],
    /** Users named by stored steps rather than by a spec (an explicit route read through the frozen spec). */
    extraUserIds: readonly string[] = [],
  ): Promise<DirectoryData> {
    const all = specs.flatMap((spec) => [...spec.steps, ...spec.rules.map((r) => r.add)]);
    const roles = [
      ...new Set([
        ...specs.flatMap((spec) => outsideRoleAssigneeRoles(spec.documentType)),
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

    // On `q`: inside submit or a decision it is the transaction, and a pool read there takes a second connection.
    // One statement, not a Promise.all of reads, so a transaction (and later row-level security) sees one connection.
    let roleMembers: Map<string, readonly string[]>;
    if (this.users.userIdsWithRoles !== undefined) {
      roleMembers = await this.users.userIdsWithRoles(scope, roles, q);
    } else {
      roleMembers = new Map();
      for (const role of roles) {
        roleMembers.set(role, await this.users.userIdsWithRole(scope, role, q));
      }
    }

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

  /** What the approval emails say about a request: its type and who asked. */
  private async emailContext(
    tx: DbTransaction,
    requestId: string,
  ): Promise<{ documentType: string | undefined; requesterName: string | undefined }> {
    const [row] = await tx
      .select({
        tenantId: approvalRequests.tenantId,
        documentType: approvalRequests.documentType,
        requesterUserId: approvalRequests.requesterUserId,
      })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    return {
      documentType: row?.documentType,
      requesterName:
        row === undefined
          ? undefined
          : await this.displayName(tx, row.tenantId, row.requesterUserId),
    };
  }

  /**
   * A person's name for an email: their display name, or "Unnamed user" (D54-2), never a piece of their address.
   * Read through the caller's transaction, not a second pooled connection (which can stall the pool under load),
   * and never throws: the read runs in a savepoint, so a failed lookup rolls back only the savepoint and the decision
   * goes on. The catch sits outside the savepoint on purpose: caught inside it, the failed statement would still
   * abort the whole transaction. The template has a neutral default for a missing name.
   */
  private async displayName(
    tx: DbTransaction,
    tenantId: string,
    userId: string,
  ): Promise<string | undefined> {
    try {
      return await tx.transaction(
        async (sp) => nameIn(await personNameMap(sp, tenantId, [userId]), userId) ?? undefined,
      );
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
    const steps = await this.stepsOf(q, request);
    const actions = await q
      .select({
        action: approvalActions.action,
        actorUserId: approvalActions.actorUserId,
        onBehalfOfUserId: approvalActions.onBehalfOfUserId,
        comment: approvalActions.comment,
        createdAt: approvalActions.createdAt,
      })
      .from(approvalActions)
      .where(
        and(
          eq(approvalActions.tenantId, request.tenantId),
          eq(approvalActions.organizationId, request.organizationId),
          eq(approvalActions.requestId, requestId),
        ),
      )
      // Rows of one transaction share created_at; seq keeps them in the order they were written.
      .orderBy(asc(approvalActions.createdAt), asc(approvalActions.seq));
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

  private stepsOf(
    q: Q,
    request: Pick<RequestRow, 'id' | 'tenantId' | 'organizationId'>,
  ): Promise<StepRow[]> {
    return q
      .select()
      .from(approvalSteps)
      .where(
        and(
          eq(approvalSteps.tenantId, request.tenantId),
          eq(approvalSteps.organizationId, request.organizationId),
          eq(approvalSteps.requestId, request.id),
        ),
      )
      .orderBy(asc(approvalSteps.seq));
  }

  private subjectOf(documentType: string): ApprovalSubject {
    const s = this.subjects.get(documentType);
    if (s === undefined) throw new Error(`no approval subject registered for "${documentType}"`);
    return s;
  }
}

/**
 * The directory of several specs, seen as one spec alone would have loaded it. Roles, groups, delegations and
 * heads are looked up by key, so extra entries change no answer; `activeUserIds` is different: the router also
 * checks the user a stored step names against it, and an absent set means "no restriction". So the view keeps
 * only the users this spec (its `user` steps, its department heads when it has such a step, and the users the
 * listed rows name) would have asked about, and leaves the set out when that list is empty.
 */
export function directoryViewOf(
  data: DirectoryData,
  spec: WorkflowSpec,
  extraUserIds: readonly string[],
): DirectoryData {
  const union = data.activeUserIds;
  if (union === undefined) return data;
  const steps = [...spec.steps, ...spec.rules.map((r) => r.add)];
  const asked = new Set<string>(extraUserIds);
  for (const s of steps) if (s.kind === 'user' && s.user !== undefined) asked.add(s.user);
  if (steps.some((s) => s.kind === 'department_head')) {
    for (const head of data.departmentHeads?.values() ?? []) asked.add(head);
  }
  if (asked.size === 0) {
    const { activeUserIds: _unrestricted, ...rest } = data;
    return rest;
  }
  return { ...data, activeUserIds: new Set([...asked].filter((id) => union.has(id))) };
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
export function stepSpecOf(step: AssignmentStep, data: DirectoryData): StepSpec {
  const base = { id: `seq-${step.seq}`, reason: step.reason ?? '' };
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
  step: AssignmentStep,
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
