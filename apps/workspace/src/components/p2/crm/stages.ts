import {
  findTransition,
  LEGACY_RESUME_STAGE,
  LEAD_STAGES,
  LEAD_TRANSITIONS,
  OPPORTUNITY_STAGES,
  OPPORTUNITY_TRANSITIONS,
  STAGE_CATALOGUE,
  type LeadStage,
  type OpportunityStage,
  type RecordKind,
} from '@bos/contracts';

/**
 * Stage rules for the CRM screens, read from the contracts' state machine so the UI never offers
 * a move the API would refuse. Server-side only: it imports the contracts at runtime, so Client
 * Components get the result as props and never import this file (kernel-ui.ts keeps zod out of the
 * browser bundle the same way).
 */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

/** A move a person may make from the current stage. */
export interface Move {
  stage: string;
  label: string;
  needsReason: boolean;
}

export interface BoardColumn {
  stage: string;
  label: string;
  needsReason: boolean;
  /** Why nobody can drop a card here, when that is so. */
  note?: string;
}

const table = (kind: RecordKind): readonly { from: string; to: string; by: string }[] =>
  kind === 'lead' ? LEAD_TRANSITIONS : OPPORTUNITY_TRANSITIONS;

export function stageLabel(kind: RecordKind, stage: string): string {
  return STAGE_CATALOGUE.find((s) => s.recordKind === kind && s.code === stage)?.label ?? stage;
}

/**
 * True for a stage no person sets: Won and Quotation Sent move with the quotation lifecycle, and a
 * lead becomes Converted through the Convert action, not a stage change.
 */
export function isSetBySystem(kind: RecordKind, stage: string): boolean {
  if (kind === 'lead') return stage === 'converted';
  const edges = table(kind).filter((t) => t.to === stage);
  return edges.length > 0 && edges.every((t) => t.by === 'system');
}

/**
 * The moves a person can make from `from`: user edges only. Manager reopen edges are left out on
 * purpose (deny by default: the UI has no manager check), and `converted` is the Convert action.
 */
export function userMoves(kind: RecordKind, from: string): Move[] {
  const targets: readonly string[] = kind === 'lead' ? LEAD_STAGES : OPPORTUNITY_STAGES;
  return targets
    .filter((to) => {
      const edge =
        kind === 'lead'
          ? findTransition('lead', from as LeadStage, to as LeadStage)
          : findTransition('opportunity', from as OpportunityStage, to as OpportunityStage);
      // Without the record's held stage (F1-Q53) only the old fixed resume stage is safe to offer; the API's
      // `allowedMoves` names the real one.
      if (from === 'on_hold' && to !== LEGACY_RESUME_STAGE[kind]) return false;
      return edge !== undefined && edge.by === 'user' && !isSetBySystem(kind, to);
    })
    .map((to) => ({
      stage: to,
      label: stageLabel(kind, to),
      needsReason: STAGE_CATALOGUE.some(
        (s) => s.recordKind === kind && s.code === to && s.needsReason,
      ),
    }));
}

/**
 * The moves a record allows for the current caller. When the API returns `allowedMoves`, trust it
 * (preserving manager reopen edges like `lost -> contacted` / `lost -> qualified`, and returning
 * `[]` when the server returns `[]`), filtering out system-only stages. When `allowedMoves` is
 * absent (older payloads or fixtures), fall back to `userMoves`.
 */
export function resolvedMoves(
  kind: RecordKind,
  from: string,
  allowedMoves?: readonly string[],
): Move[] {
  if (allowedMoves === undefined) return userMoves(kind, from);
  return allowedMoves
    .filter((to) => !isSetBySystem(kind, to))
    .map((to) => ({
      stage: to,
      label: stageLabel(kind, to),
      needsReason: STAGE_CATALOGUE.some(
        (s) => s.recordKind === kind && s.code === to && s.needsReason,
      ),
    }));
}

/**
 * The moves a card offers on the board: `userMoves` without `lost`, because Lost needs a choice
 * from the tenant's lost-reason list on the record page (D49, D54-3).
 */
export function boardMoves(kind: RecordKind, from: string): Move[] {
  return userMoves(kind, from).filter((m) => m.stage !== 'lost');
}

export function boardColumns(kind: RecordKind): BoardColumn[] {
  return STAGE_CATALOGUE.filter((s) => s.recordKind === kind).map((s) => {
    const column: BoardColumn = { stage: s.code, label: s.label, needsReason: s.needsReason };
    if (isSetBySystem(kind, s.code)) {
      column.note = kind === 'lead' ? 'Set by Convert' : 'Set by the system';
    } else if (s.code === 'lost') {
      column.note = 'Mark lost on the record page';
    }
    return column;
  });
}

/** Every stage gets a list, so an empty column still draws. */
export function groupByStage<T extends { stage: string }>(
  kind: RecordKind,
  items: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>(boardColumns(kind).map((c) => [c.stage, []]));
  for (const item of items) groups.get(item.stage)?.push(item);
  return groups;
}

/** Colour carries state only where state is meaningful: done, lost, held. The rest is quiet. */
export function stageTone(kind: RecordKind, stage: string): Tone {
  if (stage === 'won' || stage === 'converted') return 'success';
  if (stage === 'lost') return 'error';
  if (stage === 'on_hold') return 'warning';
  if (kind === 'lead' && stage === 'new') return 'neutral';
  if (kind === 'opportunity' && stage === 'qualified') return 'neutral';
  return 'info';
}
