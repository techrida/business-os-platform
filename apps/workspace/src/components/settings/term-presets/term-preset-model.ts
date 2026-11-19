import {
  TERM_PRESET_KINDS,
  TERM_PRESET_KIND_LABELS,
  type TermPreset,
  type TermPresetKind,
} from '@bos/contracts';

// Pure helpers for the Saved terms screen and its server actions. No React, no server imports.

export const TERM_NAME_LIMIT = 80;

/**
 * The longest text each kind may hold. The contract caps every preset body at 10,000; the quotation's
 * delivery timeline field is 2,000, so a longer saved option could never be filled into it. The
 * contract has no per-kind limit to import, so this is the one local copy.
 */
export const TERM_BODY_LIMITS: Record<TermPresetKind, number> = {
  scope: 10_000,
  assumptions: 10_000,
  exclusions: 10_000,
  delivery_timeline: 2_000,
  terms_conditions: 10_000,
  payment_terms: 10_000,
};

/** Tab order: the four fields a quotation has today, then the two still to come. */
export const TERM_TAB_ORDER: readonly TermPresetKind[] = [
  'scope',
  'assumptions',
  'exclusions',
  'delivery_timeline',
  'terms_conditions',
  'payment_terms',
];

export const TERM_KIND_HINTS: Record<TermPresetKind, string> = {
  scope: 'Offered above the Scope field of a quotation: what is included.',
  assumptions: 'Offered above the Assumptions field of a quotation.',
  exclusions: 'Offered above the Exclusions field of a quotation: what is not included.',
  delivery_timeline: 'Offered above the Delivery timeline field of a quotation.',
  terms_conditions: 'Offered above the Terms and conditions field of a quotation.',
  payment_terms:
    'Free wording such as "50% advance, balance on delivery". The structured payment term on a quotation is chosen from its own list.',
};

export const termKindLabel = (kind: TermPresetKind): string => TERM_PRESET_KIND_LABELS[kind];

export function isTermKind(value: unknown): value is TermPresetKind {
  return typeof value === 'string' && (TERM_PRESET_KINDS as readonly string[]).includes(value);
}

/** One kind's presets by name, ignoring case, as the API lists them. */
export function presetsOfKind(list: readonly TermPreset[], kind: TermPresetKind): TermPreset[] {
  return list
    .filter((preset) => preset.kind === kind)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** The first non-empty line of a text, cut to `max` characters with an ellipsis. */
export function firstLine(body: string, max = 140): string {
  const line = body.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

export interface PresetInput {
  name: string;
  body: string;
}

export type PresetValidation =
  | { ok: true; value: PresetInput }
  | { ok: false; fieldErrors: Partial<Record<keyof PresetInput, string>> };

/** The rules the API applies (trimmed, 1 to the limit characters), said at the field before the call. */
export function validatePreset(kind: TermPresetKind, input: PresetInput): PresetValidation {
  const name = input.name.trim();
  const body = input.body.trim();
  const limit = TERM_BODY_LIMITS[kind];
  const fieldErrors: Partial<Record<keyof PresetInput, string>> = {};
  if (name === '') fieldErrors.name = 'Give this option a name, so you can find it in the list.';
  else if (name.length > TERM_NAME_LIMIT) {
    fieldErrors.name = `Keep the name to ${TERM_NAME_LIMIT} characters or fewer.`;
  }
  if (body === '') fieldErrors.body = 'Write the text this option fills in.';
  else if (body.length > limit) {
    fieldErrors.body = `Keep the text to ${limit.toLocaleString('en-US')} characters or fewer.`;
  }
  return Object.keys(fieldErrors).length > 0
    ? { ok: false, fieldErrors }
    : { ok: true, value: { name, body } };
}
