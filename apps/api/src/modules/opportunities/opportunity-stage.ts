// The opportunity stage planner: decides whether a move is allowed and what the row becomes. The planner is pure,
// so every edge of the transition table is unit-testable without a database. Serves the NFR "the pipeline is
// auditable": a stage moves only along OPPORTUNITY_TRANSITIONS, Won and Quotation Sent are set by the system alone,
// and a move to Lost or On Hold always carries its reason and note.
// applyStageChange at the end is the one writer of opportunities.stage: it updates the row and records the change in
// opportunity_stage_history (0162) in the same transaction.
import {
  findTransition,
  OPPORTUNITY_TRANSITIONS,
  type OpportunityStage,
  resumeTarget,
  type StageTransition,
  type TransitionActor,
} from '@bos/contracts';
import { opportunities, opportunityStageHistory, scoped } from '@bos/db';
import { asc, eq } from 'drizzle-orm';

import { can, type Principal, type ResourceRef } from '../../platform/authz/can';
import type { RecordReaders } from '../../platform/authz/record-reach';
import { updateVersioned } from '../../platform/db/idempotency';
import type { Db, DbTransaction, TxScope } from '../../platform/db/tx';
import { actorUuid, readTxContext } from '../../platform/documents/tx-context';
import { isStageManager } from '../leads/lead-stage';

export { isStageManager } from '../leads/lead-stage';

/** Who is asking: a user, a manager (may also reopen a lost opportunity), or the system (a side effect). */
export type StageCaller = TransitionActor;

/**
 * What authz decides on for one opportunity: its entity, owner and department (stamped from the owner, migration
 * 0080), so a department grant reaches it. `readers` (its assignees, record-reach.ts) only for a read: assigned
 * reach never lets anyone change a deal (D55-3). No party column: a portal grant reaches no opportunity.
 */
export function opportunityRef(
  row: {
    tenantId: string;
    organizationId: string;
    ownerUserId: string | null;
    departmentId: string | null;
  },
  readers?: RecordReaders,
): ResourceRef {
  return {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    ownerUserId: row.ownerUserId,
    departmentId: row.departmentId,
    ...(readers === undefined
      ? {}
      : { creatorUserId: readers.creatorUserId, assigneeUserIds: readers.assigneeUserIds }),
  };
}

/**
 * May `principal` reopen this lost opportunity (the manager edge)? Both rules are required: the code rule (Founder,
 * or a manager or head, `isStageManager`) and the live `crm.opportunity.reopen` grant reaching the opportunity's
 * department, which the Founder narrows or widens per role in Settings > Access. Staff never reopen, whatever they
 * are granted. The ref carries no readers: reopening is a change, so assignee reach never counts (D55-3).
 */
export function mayReopenOpportunity(
  principal: Principal,
  row: {
    tenantId: string;
    organizationId: string;
    ownerUserId: string | null;
    departmentId: string | null;
  },
): boolean {
  return (
    isStageManager(principal) &&
    can(principal, 'crm.opportunity.reopen', opportunityRef(row)).allowed
  );
}

/**
 * The stage targets `principal` may move `row` to over HTTP. Pure, using live `crm.opportunity.write`, and for the
 * reopen edge also `mayReopenOpportunity`.
 */
export function allowedOpportunityMoves(
  principal: Principal,
  row: {
    tenantId: string;
    organizationId: string;
    ownerUserId: string | null;
    departmentId: string | null;
    stage: OpportunityStage;
    heldFromStage?: OpportunityStage | null;
  },
): OpportunityStage[] {
  if (!can(principal, 'crm.opportunity.write', opportunityRef(row)).allowed) return [];
  const manager = mayReopenOpportunity(principal, row);
  return OPPORTUNITY_TRANSITIONS.filter(
    (t) =>
      t.from === row.stage &&
      t.by !== 'system' &&
      (t.by === 'user' || (t.by === 'manager' && manager)) &&
      (row.stage !== 'on_hold' || t.to === resumeTarget('opportunity', row.heldFromStage ?? null)),
  ).map((t) => t.to);
}

export interface StageChangeInput {
  current: OpportunityStage;
  currentVersion: number;
  to: OpportunityStage;
  by: StageCaller;
  reason?: string | undefined;
  note?: string | undefined;
  /** The version the caller saw. Left out for a system move, which acts on the row as it finds it. */
  expectedVersion?: number | undefined;
  /** The stage an on_hold opportunity was held at (F1-Q53); null or absent for a hold older than that. */
  heldFromStage?: OpportunityStage | null | undefined;
}

export interface StageFields {
  stage: OpportunityStage;
  stageReason: string | null;
  stageNote: string | null;
  /** Set to the stage left when moving to on_hold, and cleared by every other move. */
  heldFromStage: OpportunityStage | null;
}

export type StageChangeRefusal =
  /** The row changed since the caller read it. */
  | 'stale'
  /** The table has no edge from the current stage to the requested one. */
  | 'no_edge'
  /** A user asked for a move only the system makes (won, quotation_sent). */
  | 'system_only'
  /** The system asked for a move that belongs to users. */
  | 'not_system'
  /** The edge is a manager's (reopening a lost opportunity). */
  | 'manager_only'
  /** Lost and On Hold need both a reason and a note. */
  | 'reason_required';

export type StagePlan =
  { ok: true; set: StageFields } | { ok: false; kind: StageChangeRefusal; message: string };

const refuse = (kind: StageChangeRefusal, message: string): StagePlan => ({
  ok: false,
  kind,
  message,
});

/** Does a caller of this kind may take an edge of this kind? A manager may take user edges too. */
function mayTake(
  by: StageCaller,
  edge: StageTransition<OpportunityStage>,
): StageChangeRefusal | null {
  if (by === 'system') return edge.by === 'system' ? null : 'not_system';
  if (edge.by === 'system') return 'system_only';
  if (edge.by === 'manager' && by !== 'manager') return 'manager_only';
  return null;
}

/**
 * The version is checked before the move: a user who saw an older stage is told the record changed, not that
 * the move they asked for is invalid. The row lock and `updateVersioned` stay the guard against a race.
 */
export function planStageChange(input: StageChangeInput): StagePlan {
  if (input.expectedVersion !== undefined && input.expectedVersion !== input.currentVersion) {
    return refuse('stale', 'This opportunity was changed by someone else; reload it and try again');
  }
  const edge = findTransition('opportunity', input.current, input.to);
  if (edge === undefined) {
    return refuse('no_edge', `An opportunity cannot move from ${input.current} to ${input.to}`);
  }
  if (input.current === 'on_hold') {
    const back = resumeTarget('opportunity', input.heldFromStage ?? null);
    if (input.to !== back) {
      return refuse(
        'no_edge',
        `This opportunity was put on hold at ${back} and resumes to ${back} only`,
      );
    }
  }
  const refusal = mayTake(input.by, edge);
  if (refusal === 'system_only') {
    return refuse(refusal, `Moving to ${input.to} is done by the system, not by a user`);
  }
  if (refusal === 'not_system') {
    return refuse(refusal, `The move from ${input.current} to ${input.to} is not a system move`);
  }
  if (refusal === 'manager_only') {
    return refuse(
      refusal,
      `Only a manager may move an opportunity from ${input.current} to ${input.to}`,
    );
  }

  if (input.by === 'system') {
    // A system move comes from the quotation lifecycle: no user reason, and none left over from an earlier stage.
    return {
      ok: true,
      set: { stage: input.to, stageReason: null, stageNote: null, heldFromStage: null },
    };
  }
  if (edge.needsReason && (input.reason === undefined || input.note === undefined)) {
    return refuse('reason_required', `A reason and a note are required to move to ${input.to}`);
  }
  // Moving out of lost or on_hold must not leave their text on the new stage, so the two are always
  // replaced by what this request says (null when it says nothing).
  return {
    ok: true,
    set: {
      stage: input.to,
      stageReason: input.reason ?? null,
      stageNote: input.note ?? null,
      heldFromStage: input.to === 'on_hold' ? input.current : null,
    },
  };
}

// ------------------------------------------------------------------------------------------- writing a change

type OpportunityRecord = typeof opportunities.$inferSelect;
type StageHistoryActorKind = (typeof opportunityStageHistory.$inferInsert)['actorKind'];

const NON_USER_ACTOR_KINDS: ReadonlySet<string> = new Set(['system', 'seed', 'zitadel']);

/**
 * Records one stage change of `opportunity` in opportunity_stage_history, in the caller's transaction. The actor is
 * the transaction's (withTx): the user who moved the deal or set off a system move, or a job with no user (actor
 * kind 'system', no user id). Only applyStageChange calls it.
 */
export async function recordStageChange(
  tx: DbTransaction,
  opportunity: Pick<OpportunityRecord, 'id' | 'tenantId' | 'organizationId'>,
  from: OpportunityStage,
  to: OpportunityStage,
): Promise<void> {
  const context = await readTxContext(tx);
  const userId = actorUuid(context);
  let actorKind: StageHistoryActorKind;
  if (userId !== null) {
    actorKind = 'user';
  } else if (NON_USER_ACTOR_KINDS.has(context.actorKind)) {
    actorKind = context.actorKind as StageHistoryActorKind;
  } else {
    // A user actor whose id is not a user uuid: refuse rather than record an unknown author.
    throw new Error(`opportunity stage history: unknown actor ${context.actorKind}`);
  }
  await tx.insert(opportunityStageHistory).values({
    tenantId: opportunity.tenantId,
    organizationId: opportunity.organizationId,
    opportunityId: opportunity.id,
    fromStage: from,
    toStage: to,
    actorKind,
    actorUserId: userId,
  });
}

/**
 * The one writer of opportunities.stage: applies a planned stage change (planStageChange's `set`) to the locked row
 * with the version check, and records the change in the same transaction. A throw anywhere rolls back both.
 */
export async function applyStageChange(
  tx: DbTransaction,
  row: Pick<OpportunityRecord, 'id' | 'tenantId' | 'organizationId' | 'stage'>,
  expectedVersion: number,
  set: StageFields & { lostReasonId: string | null; wonQuotationVersionId?: string },
): Promise<OpportunityRecord> {
  const updated = await updateVersioned(tx, opportunities, row.id, expectedVersion, {
    ...set,
    updatedAt: new Date(),
  });
  await recordStageChange(tx, row, row.stage, updated.stage);
  return updated;
}

/** The stage changes of one opportunity in `scope`, oldest first. Another entity or tenant gets none. */
export function stageHistoryOf(q: Db | DbTransaction, scope: TxScope, opportunityId: string) {
  return q
    .select()
    .from(opportunityStageHistory)
    .where(
      scoped(scope).where(
        opportunityStageHistory,
        eq(opportunityStageHistory.opportunityId, opportunityId),
      ),
    )
    .orderBy(asc(opportunityStageHistory.createdAt), asc(opportunityStageHistory.seq));
}
