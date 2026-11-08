// The opportunity stage planner: decides whether a move is allowed and what the row becomes. Pure, so every edge
// of the transition table is unit-testable without a database. Serves the NFR "the pipeline is auditable":
// a stage moves only along OPPORTUNITY_TRANSITIONS, Won and Quotation Sent are set by the system alone, and a
// move to Lost or On Hold always carries its reason and note.
import {
  findTransition,
  type OpportunityStage,
  type StageTransition,
  type TransitionActor,
} from '@bos/contracts';

/** Who is asking: a user, a manager (may also reopen a lost opportunity), or the system (a side effect). */
export type StageCaller = TransitionActor;

export interface StageChangeInput {
  current: OpportunityStage;
  currentVersion: number;
  to: OpportunityStage;
  by: StageCaller;
  reason?: string | undefined;
  note?: string | undefined;
  /** The version the caller saw. Left out for a system move, which acts on the row as it finds it. */
  expectedVersion?: number | undefined;
}

export interface StageFields {
  stage: OpportunityStage;
  stageReason: string | null;
  stageNote: string | null;
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
    return { ok: true, set: { stage: input.to, stageReason: null, stageNote: null } };
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
    },
  };
}
