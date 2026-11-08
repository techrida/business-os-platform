// The lead stage planner: decides whether a move is allowed and what the row becomes. Pure, so every edge of
// LEAD_TRANSITIONS is unit-testable without a database. Serves the NFR "the pipeline is auditable": a stage
// moves only along the table, Converted is reached by the convert action alone, and a move to Lost or On Hold
// always carries its reason and note.
import { findTransition, type LeadStage } from '@bos/contracts';

/** Who is asking: a user, or a manager (who may also reopen a lost lead). */
export type LeadStageCaller = 'user' | 'manager';

export interface LeadStageInput {
  current: LeadStage;
  currentVersion: number;
  to: LeadStage;
  by: LeadStageCaller;
  reason?: string | undefined;
  note?: string | undefined;
  /** The version the caller saw. */
  expectedVersion?: number | undefined;
}

export interface LeadStageFields {
  stage: LeadStage;
  stageReason: string | null;
  stageNote: string | null;
}

export type LeadStageRefusal =
  /** The row changed since the caller read it. */
  | 'stale'
  /** The table has no edge from the current stage to the requested one. */
  | 'no_edge'
  /** Converted is set by `POST /v1/leads/:id/convert`, never by a stage change. */
  | 'use_convert'
  /** The edge is a manager's (reopening a lost lead). */
  | 'manager_only'
  /** Lost and On Hold need both a reason and a note. */
  | 'reason_required';

export type LeadStagePlan =
  { ok: true; set: LeadStageFields } | { ok: false; kind: LeadStageRefusal; message: string };

const refuse = (kind: LeadStageRefusal, message: string): LeadStagePlan => ({
  ok: false,
  kind,
  message,
});

/**
 * The version is checked first: a user who saw an older stage is told the record changed, not that the move they
 * asked for is invalid. The row lock and `updateVersioned` stay the guard against a race.
 */
export function planLeadStageChange(input: LeadStageInput): LeadStagePlan {
  if (input.expectedVersion !== undefined && input.expectedVersion !== input.currentVersion) {
    return refuse('stale', 'This lead was changed by someone else; reload it and try again');
  }
  if (input.to === 'converted') {
    return refuse('use_convert', 'A lead is converted with the convert action, not a stage change');
  }
  const edge = findTransition('lead', input.current, input.to);
  if (edge === undefined) {
    return refuse('no_edge', `A lead cannot move from ${input.current} to ${input.to}`);
  }
  if (edge.by === 'manager' && input.by !== 'manager') {
    return refuse(
      'manager_only',
      `Only a manager may move a lead from ${input.current} to ${input.to}`,
    );
  }
  if (edge.needsReason && (input.reason === undefined || input.note === undefined)) {
    return refuse('reason_required', `A reason and a note are required to move to ${input.to}`);
  }
  // Leaving lost or on_hold must not leave their text on the new stage, so the two are always replaced by what
  // this request says (null when it says nothing).
  return {
    ok: true,
    set: { stage: input.to, stageReason: input.reason ?? null, stageNote: input.note ?? null },
  };
}
