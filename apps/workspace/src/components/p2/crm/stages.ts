import {
  findTransition,
  LEAD_STAGES,
  LEAD_TRANSITIONS,
  OPPORTUNITY_STAGES,
  OPPORTUNITY_TRANSITIONS,
  resumeTarget,
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

/** The stage a record's fields say it is at, plus what the API sends about its moves. */
export interface StagedRecord {
  stage: string;
  /** On hold only (F1-Q53): the stage it was held at; null or absent for an older hold. */
  heldFromStage?: string | null | undefined;
  /** The moves the API computed for the caller; absent on older payloads. */
  allowedMoves?: readonly string[] | undefined;
}

const toMove = (kind: RecordKind, to: string): Move => ({
  stage: to,
  label: stageLabel(kind, to),
  needsReason: STAGE_CATALOGUE.some((s) => s.recordKind === kind && s.code === to && s.needsReason),
});

/**
 * The moves a person can make from `from`: user edges only. Manager reopen edges are left out on
 * purpose (deny by default: the UI has no manager check), and `converted` is the Convert action.
 * A held record resumes only to the stage it was held at (F1-Q53, `resumeTarget`); without
 * `heldFromStage` that is the old fixed stage, as the API decides for a hold older than the field.
 */
export function userMoves(kind: RecordKind, from: string, heldFromStage?: string | null): Move[] {
  const targets: readonly string[] = kind === 'lead' ? LEAD_STAGES : OPPORTUNITY_STAGES;
  const resumeTo =
    from === 'on_hold'
      ? kind === 'lead'
        ? resumeTarget('lead', (heldFromStage ?? null) as LeadStage | null)
        : resumeTarget('opportunity', (heldFromStage ?? null) as OpportunityStage | null)
      : null;
  return targets
    .filter((to) => {
      if (resumeTo !== null && to !== resumeTo) return false;
      const edge =
        kind === 'lead'
          ? findTransition('lead', from as LeadStage, to as LeadStage)
          : findTransition('opportunity', from as OpportunityStage, to as OpportunityStage);
      return edge !== undefined && edge.by === 'user' && !isSetBySystem(kind, to);
    })
    .map((to) => toMove(kind, to));
}

/**
 * The moves a record allows for the current caller. When the API returns `allowedMoves`, trust it
 * (preserving manager reopen edges like `lost -> contacted` / `lost -> qualified`, the one resume
 * target of a held record, and returning `[]` when the server returns `[]`), filtering out
 * system-only stages. When `allowedMoves` is absent (older payloads or fixtures), fall back to
 * `userMoves` with the record's held stage.
 */
export function resolvedMoves(
  kind: RecordKind,
  from: string,
  allowedMoves?: readonly string[],
  heldFromStage?: string | null,
): Move[] {
  if (allowedMoves === undefined) return userMoves(kind, from, heldFromStage);
  return allowedMoves.filter((to) => !isSetBySystem(kind, to)).map((to) => toMove(kind, to));
}

/**
 * The stage Resume moves a held record to: the one move out of On Hold (F1-Q53). `null`
 * when the record is not on hold or the caller may not resume it.
 */
export function resumeMove(from: string, moves: readonly Move[]): Move | null {
  if (from !== 'on_hold') return null;
  return moves.find((m) => m.stage !== 'lost') ?? null;
}

/**
 * The moves a card offers on the board: the record's own moves (`resolvedMoves`) without `lost`,
 * because Lost needs a choice from the tenant's lost-reason list on the record page (D49, D54-3).
 * A read-only viewer (`allowedMoves: []`) gets none, and a held card offers only its resume stage.
 */
export function boardMoves(kind: RecordKind, record: StagedRecord): Move[] {
  return resolvedMoves(kind, record.stage, record.allowedMoves, record.heldFromStage).filter(
    (m) => m.stage !== 'lost',
  );
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

/**
 * The stages a record must have passed through to stand at `stage`, read from the state machine:
 * while a stage has exactly one way in (leaving out On Hold and Lost, which only return a record to
 * where it was), that earlier stage was reached. A lead at Qualified was Contacted and New; a deal
 * at Proposal Sent had its requirement received. A stage with several ways in (Quotation Sent, Won)
 * stops the chain: which one it came through is not known.
 */
export function stagesBefore(kind: RecordKind, stage: string): string[] {
  const passed: string[] = [];
  let at = stage;
  for (;;) {
    const sources = new Set(
      table(kind)
        .filter((t) => t.to === at && t.from !== 'on_hold' && t.from !== 'lost')
        .map((t) => t.from),
    );
    const [only] = sources;
    if (sources.size !== 1 || only === undefined || passed.includes(only)) return passed;
    passed.push(only);
    at = only;
  }
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
