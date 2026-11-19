import type { TermPreset, TermPresetKind } from '@bos/contracts';

// Rules for the "Saved options" dropdown above a quotation text field. Pure, so they are tested
// without a browser. The quotation stores plain text: nothing here links a field to a preset.

/** The kind's presets by name that fit the field. One that is longer than the field allows is not offered, so a fill never leaves the field invalid. */
export function offeredPresets(
  presets: readonly TermPreset[] | null | undefined,
  kind: TermPresetKind,
  maxLength: number,
): TermPreset[] {
  return (presets ?? [])
    .filter((p) => p.kind === kind && p.body.length <= maxLength)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * True when filling over the current text loses nothing the person typed: the field is empty, still
 * holds exactly what the last fill put there, or holds the text of a saved option (so it can be had
 * again). Anything else, including text that arrived with a saved draft, counts as typed.
 */
export function canFillSilently(
  value: string,
  lastFilled: string | null,
  offered: readonly TermPreset[],
): boolean {
  if (value.trim() === '') return true;
  if (lastFilled !== null && value === lastFilled) return true;
  return offered.some((p) => p.body === value);
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
