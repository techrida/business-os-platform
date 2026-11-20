// The lead stage planner: decides whether a move is allowed and what the row becomes. Pure, so every edge of
// LEAD_TRANSITIONS is unit-testable without a database. Serves the NFR "the pipeline is auditable": a stage
// moves only along the table, Converted is reached by the convert action alone, and a move to Lost or On Hold
// always carries its reason and note.
import { findTransition, LEAD_TRANSITIONS, type LeadStage, resumeTarget } from '@bos/contracts';

import { can, type Principal, type ResourceRef } from '../../platform/authz/can';
import type { RecordReaders } from '../../platform/authz/record-reach';

/** Who is asking: a user, or a manager (who may also reopen a lost lead). */
export type LeadStageCaller = 'user' | 'manager';

/** Whether the caller may take manager-only stage edges (reopening a lost lead or opportunity). */
export function isStageManager(principal: Principal): boolean {
  return (
    principal.roles.includes('founder') ||
    principal.level === 'manager' ||
    principal.level === 'head'
  );
}

/**
 * What authz decides on for one lead. No party column: a portal grant reaches no lead. The department (stamped by
 * the database from the owner, D55-4) lets a department grant reach the lead. `readers` (record-reach.ts
 * `loadRecordReaders`) add the creator and the follow-up assignees, which only a read permission honours: pass them
 * on a read so the record check agrees with the list query, and leave them out of a write.
 */
export function leadRef(
  row: {
    tenantId: string;
    organizationId: string;
    ownerUserId: string | null;
    departmentId?: string | null;
  },
  readers?: RecordReaders,
): ResourceRef {
  return {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    ownerUserId: row.ownerUserId,
    departmentId: row.departmentId ?? null,
    ...(readers === undefined
      ? {}
      : { creatorUserId: readers.creatorUserId, assigneeUserIds: readers.assigneeUserIds }),
  };
}

/**
 * May `principal` reopen this lost lead (the manager edge)? Two rules, both required: the code rule (Founder, or a
 * manager or head, `isStageManager`) and the live `crm.lead.reopen` grant reaching the lead's department, which the
 * Founder narrows or widens per role in Settings > Access. Staff never reopen, whatever they are granted. The ref
 * carries no readers: reopening is a change, so creator and assignee reach never count.
 */
export function mayReopenLead(
  principal: Principal,
  row: {
    tenantId: string;
    organizationId: string;
    ownerUserId: string | null;
    departmentId?: string | null;
  },
): boolean {
  return isStageManager(principal) && can(principal, 'crm.lead.reopen', leadRef(row)).allowed;
}

/**
 * The stage targets `principal` may move `row` to over HTTP. Pure, using live `crm.lead.write`, and for the reopen
 * edge also `mayReopenLead`.
 */
export function allowedLeadMoves(
  principal: Principal,
  row: {
    tenantId: string;
    organizationId: string;
    ownerUserId: string | null;
    departmentId?: string | null;
    stage: LeadStage;
    heldFromStage?: LeadStage | null;
  },
): LeadStage[] {
  if (!can(principal, 'crm.lead.write', leadRef(row)).allowed) return [];
  const manager = mayReopenLead(principal, row);
  return LEAD_TRANSITIONS.filter(
    (t) =>
      t.from === row.stage &&
      t.to !== 'converted' &&
      (t.by === 'user' || (t.by === 'manager' && manager)) &&
      (row.stage !== 'on_hold' || t.to === resumeTarget('lead', row.heldFromStage ?? null)),
  ).map((t) => t.to);
}

export interface LeadStageInput {
  current: LeadStage;
  currentVersion: number;
  to: LeadStage;
  by: LeadStageCaller;
  reason?: string | undefined;
  note?: string | undefined;
  /** The version the caller saw. */
  expectedVersion?: number | undefined;
  /** The stage an on_hold lead was held at (F1-Q53); null or absent for a hold older than that. */
  heldFromStage?: LeadStage | null | undefined;
}

export interface LeadStageFields {
  stage: LeadStage;
  stageReason: string | null;
  stageNote: string | null;
  /** Set to the stage left when moving to on_hold, and cleared by every other move. */
  heldFromStage: LeadStage | null;
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
  if (input.current === 'on_hold') {
    const back = resumeTarget('lead', input.heldFromStage ?? null);
    if (input.to !== back) {
      return refuse('no_edge', `This lead was put on hold at ${back} and resumes to ${back} only`);
    }
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
    set: {
      stage: input.to,
      stageReason: input.reason ?? null,
      stageNote: input.note ?? null,
      heldFromStage: input.to === 'on_hold' ? input.current : null,
    },
  };
}
