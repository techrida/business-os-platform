// The pure rules of lead conversion, so they are unit-testable without a database: which lead may convert, and how
// the duplicate candidates are shaped for the wire. Serves the NFR "the pipeline is auditable": a lead converts only
// along LEAD_TRANSITIONS (qualified to converted), at the version the caller saw.
import { findTransition, type LeadStage } from '@bos/contracts';

export type ConvertRefusal =
  /** The row changed since the caller read it. */
  | 'stale'
  /** The lead table has no edge from the current stage to converted. */
  | 'not_convertible';

export type ConvertPlan = { ok: true } | { ok: false; kind: ConvertRefusal; message: string };

/**
 * The version is checked first, as in planLeadStageChange: someone who saw an older stage is told the record
 * changed, not that the move is invalid. The row lock and updateVersioned stay the guard against a race.
 */
export function planConvert(input: {
  stage: LeadStage;
  version: number;
  expectedVersion: number;
}): ConvertPlan {
  if (input.expectedVersion !== input.version) {
    return {
      ok: false,
      kind: 'stale',
      message: 'This lead was changed by someone else; reload it and try again',
    };
  }
  if (findTransition('lead', input.stage, 'converted') === undefined) {
    return {
      ok: false,
      kind: 'not_convertible',
      message:
        input.stage === 'converted'
          ? 'This lead is already converted'
          : `A lead in stage ${input.stage} cannot be converted; only a qualified lead can`,
    };
  }
  return { ok: true };
}

/** One possible duplicate, as the workspace parses it (DuplicateCandidateSchema in the error filter). */
export interface Candidate {
  kind: 'customer' | 'contact';
  id: string;
  label: string;
  matchedOn: string;
  customerId?: string;
}

/** The wire limit of `label` (DuplicateCandidateSchema); a longer one would drop the whole list. */
const LABEL_MAX = 300;

/**
 * One entry per (kind, id), in first-seen order: the workspace keys its list on kind and id, so a contact that
 * matched on both e-mail and phone is one entry saying `email, phone`.
 */
export function mergeCandidates(found: readonly Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const c of found) {
    const key = `${c.kind}:${c.id}`;
    const seen = byKey.get(key);
    if (seen === undefined) {
      byKey.set(key, { ...c, label: c.label.slice(0, LABEL_MAX) });
    } else if (!seen.matchedOn.split(', ').includes(c.matchedOn)) {
      seen.matchedOn = `${seen.matchedOn}, ${c.matchedOn}`;
    }
  }
  return [...byKey.values()];
}
