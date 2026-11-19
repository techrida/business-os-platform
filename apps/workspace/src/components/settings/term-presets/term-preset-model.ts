import {
  DEFAULT_TERM_PRESETS,
  TERM_PRESET_KINDS,
  TERM_PRESET_KIND_LABELS,
  isRichText,
  richTextSchema,
  richTextToPlain,
  sanitizeRichText,
  type TermPreset,
  type TermPresetKind,
} from '@bos/contracts';

// Pure helpers for the Saved terms screen and its server actions. No React, no server imports.

export const TERM_NAME_LIMIT = 80;

/**
 * The longest text each kind may hold, counted in words and not markup (D31). The contract caps every
 * term set body at 10,000; the quotation's delivery timeline field is 2,000, so a longer set could
 * never be filled into it. The contract has no per-kind limit to import, so this is the one local copy.
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

/** The ids of the sets the app ships with. They are editable like any other set; this is only a label. */
const APP_DEFAULT_IDS: ReadonlySet<string> = new Set(DEFAULT_TERM_PRESETS.map((p) => p.id));

export const isAppDefaultSet = (id: string): boolean => APP_DEFAULT_IDS.has(id);

/** True when the saved list is exactly the app's default sets (same ids, kinds, names and text), in any order. */
export function termSetsAreDefault(list: readonly TermPreset[]): boolean {
  if (list.length !== DEFAULT_TERM_PRESETS.length) return false;
  const byId = new Map(list.map((p) => [p.id, p]));
  return DEFAULT_TERM_PRESETS.every((d) => {
    const saved = byId.get(d.id);
    return (
      saved !== undefined && saved.kind === d.kind && saved.name === d.name && saved.body === d.body
    );
  });
}

/**
 * One line of plain words for the list: the text without markup, list items without their markers,
 * lines joined by " · ", cut to `max` characters with an ellipsis. Works for rich text and for text
 * saved before D31.
 */
export function previewLine(body: string, max = 160): string {
  const line = richTextToPlain(body)
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^(?:-|\d+\.)\s+/, ''))
    .filter((l) => l !== '')
    .join(' · ');
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** What gets stored: rich text rebuilt from the allow-list, plain text trimmed. The contract's own rule. */
export const normalizeBody = (body: string): string =>
  isRichText(body) ? sanitizeRichText(body) : body.trim();

export interface PresetInput {
  name: string;
  body: string;
}

export type PresetValidation =
  | { ok: true; value: PresetInput }
  | { ok: false; fieldErrors: Partial<Record<keyof PresetInput, string>> };

/**
 * The rules the API applies (name trimmed, 1 to 80 characters; text sanitised by the contract's
 * `richTextSchema`, 1 to the kind's limit in words), said at the field before the call. The value
 * returned is what the API will store, so a script or attribute typed anywhere is already gone.
 */
export function validatePreset(kind: TermPresetKind, input: PresetInput): PresetValidation {
  const name = input.name.trim();
  const limit = TERM_BODY_LIMITS[kind];
  const fieldErrors: Partial<Record<keyof PresetInput, string>> = {};
  if (name === '') fieldErrors.name = 'Give this term set a name, so you can find it in the list.';
  else if (name.length > TERM_NAME_LIMIT) {
    fieldErrors.name = `Keep the name to ${TERM_NAME_LIMIT} characters or fewer.`;
  }
  const parsed = richTextSchema(limit).safeParse(input.body);
  if (parsed.success) {
    // Nothing but whitespace is also empty: the schema counts it as text.
    if (richTextToPlain(parsed.data).trim() === '') {
      fieldErrors.body = 'Write the text this term set fills in.';
    }
  } else if (input.body.trim() === '' || parsed.error.issues.some((i) => /empty/.test(i.message))) {
    fieldErrors.body = 'Write the text this term set fills in.';
  } else {
    fieldErrors.body = `Keep the text to ${limit.toLocaleString('en-US')} characters or fewer.`;
  }
  return Object.keys(fieldErrors).length > 0 || !parsed.success
    ? { ok: false, fieldErrors }
    : { ok: true, value: { name, body: parsed.data } };
}
