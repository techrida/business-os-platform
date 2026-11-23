import { richTextToPlain, type TermPreset, type TermPresetKind } from '@bos/contracts';

// Rules for the "Saved options" dropdown above a quotation text field. Pure, so they are tested
// without a browser. The quotation stores the text itself (D31): nothing here links a field to a
// preset, so editing a saved set never changes a quotation. A set body is rich text (HTML) or
// older plain text, so lengths and "was it edited" are read on the words, never on the markup.

/** Settings > Saved terms, where the Founder edits the sets (the "Add more" entry opens it in the same tab). */
export const SAVED_TERMS_HREF = '/settings/terms';

/** The words of a value, trimmed and with runs of whitespace collapsed: what two texts are compared on, so markup or spacing alone never counts as an edit. */
const words = (value: string): string => richTextToPlain(value).replace(/\s+/g, ' ').trim();

/** The kind's presets by name that fit the field (counted on words). One that is longer than the field allows is not offered, so a fill never leaves the field invalid. */
export function offeredPresets(
  presets: readonly TermPreset[] | null | undefined,
  kind: TermPresetKind,
  maxLength: number,
): TermPreset[] {
  return (presets ?? [])
    .filter((p) => p.kind === kind && richTextToPlain(p.body).length <= maxLength)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * True when filling over the current text loses nothing the person typed: the field is empty, still
 * holds the words the last fill put there, or holds the words of a saved option (so it can be had
 * again). Words are compared, not markup, so the editor rewriting a set's HTML does not make an
 * untouched field look edited. Anything else, including text that arrived with a saved draft,
 * counts as typed.
 */
export function canFillSilently(
  value: string,
  lastFilled: string | null,
  offered: readonly TermPreset[],
): boolean {
  const current = words(value);
  if (current === '') return true;
  if (lastFilled !== null && current === words(lastFilled)) return true;
  return offered.some((p) => words(p.body) === current);
}

export type PickOutcome =
  | { action: 'ignore' }
  | { action: 'fill'; preset: TermPreset }
  | { action: 'confirm'; preset: TermPreset };

/** What choosing `presetId` does: nothing for the empty choice or an unknown id, a fill, or a "Replace the text you typed?" question. */
export function pickOutcome(
  presetId: string,
  offered: readonly TermPreset[],
  value: string,
  lastFilled: string | null,
): PickOutcome {
  const preset = offered.find((p) => p.id === presetId);
  if (preset === undefined) return { action: 'ignore' };
  return canFillSilently(value, lastFilled, offered)
    ? { action: 'fill', preset }
    : { action: 'confirm', preset };
}

export type PickerState =
  | { state: 'empty' }
  | { state: 'preset'; preset: TermPreset }
  | { state: 'custom' };

/**
 * What the picker shows (UIP-FORM-012): the name of the preset whose words the field holds, "Custom"
 * when it holds other words, nothing (a prompt) when it is empty. Read from the text each time, so a
 * stored quotation names its preset on open and any edit flips the label to "Custom". When two
 * presets hold the same words the one last applied wins.
 */
export function pickerState(
  value: string,
  offered: readonly TermPreset[],
  appliedId: string | null,
): PickerState {
  const current = words(value);
  if (current === '') return { state: 'empty' };
  const matches = offered.filter((p) => words(p.body) === current);
  const preset = matches.find((p) => p.id === appliedId) ?? matches[0];
  return preset ? { state: 'preset', preset } : { state: 'custom' };
}

/** The kind's default preset that fits the field, if one is set. */
export function defaultPreset(
  presets: readonly TermPreset[] | null | undefined,
  kind: TermPresetKind,
  maxLength: number,
): TermPreset | undefined {
  return offeredPresets(presets, kind, maxLength).find((p) => p.isDefault === true);
}
