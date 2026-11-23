'use client';

import { TERM_PRESET_KIND_LABELS, type TermPreset, type TermPresetKind } from '@bos/contracts';
import { useState } from 'react';

import { ConfirmDialog } from '@/components/ui/dialog';
// The one place the dropdown control is chosen: the shared Select.
import { Select } from '@/components/ui/field';

import { offeredPresets, pickOutcome, pickerState } from './saved-options';
import styles from './saved-options.module.css';

/** The value of the "Add more" entry. Never a set id, so it cannot be mistaken for one. */
const ADD_MORE = '__add_more__';

/**
 * The saved-options picker above a rich text field (UIP-FORM-012). Choosing one fills the field with
 * the saved text; the field stays editable and keeps no link to the option (the quotation stores the
 * text, so editing a set later never changes it). The picker shows what the field holds: the name of
 * the option whose words it holds, "Custom" for other words, a "Choose ..." prompt when empty. Choosing
 * any option, the one shown included, puts its text in the field. If the words in the field were
 * changed since the last fill, choosing asks "Replace the text you typed?" first.
 *
 * - `presets` null (not loaded, or not readable): renders nothing, so a person without access, or a
 *   failed load, sees no dropdown and no error.
 * - Nothing of this kind saved: a disabled "No saved terms" select, or, when `onAddMore` is given,
 *   a select that offers only "Add more".
 * - `onAddMore` is passed for the Founder only. It adds an "Add more" entry at the end of the list
 *   that opens Settings > Saved terms.
 *
 * Generic by `kind`: any quotation text field with a matching preset kind can use it.
 */
export function SavedOptionsSelect({
  kind,
  presets,
  value,
  maxLength,
  onFill,
  onAddMore,
}: {
  kind: TermPresetKind;
  presets: readonly TermPreset[] | null | undefined;
  /** The field's current text (HTML or plain). */
  value: string;
  /** The field's character limit, counted on words; options longer than this are not offered. */
  maxLength: number;
  onFill: (text: string) => void;
  /** Present only for a person who may edit saved terms. */
  onAddMore?: (() => void) | undefined;
}) {
  const offered = offeredPresets(presets, kind, maxLength);
  const [lastFilled, setLastFilled] = useState<string | null>(null);
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [asking, setAsking] = useState<TermPreset | null>(null);

  if (presets === null || presets === undefined) return null;

  function fill(preset: TermPreset) {
    setLastFilled(preset.body);
    setAppliedId(preset.id);
    onFill(preset.body);
  }

  const label = `Saved options for ${TERM_PRESET_KIND_LABELS[kind]}`;
  if (offered.length === 0 && !onAddMore) {
    return (
      <div className={styles.wrap}>
        <Select
          name={`saved-${kind}`}
          aria-label={label}
          value=""
          disabled
          options={[{ value: '', label: 'No saved terms' }]}
        />
      </div>
    );
  }

  const shown = pickerState(value, offered, appliedId);
  const kindLabel = TERM_PRESET_KIND_LABELS[kind];
  const options = [
    ...offered.map((preset) => ({ value: preset.id, label: preset.name })),
    ...(onAddMore
      ? [{ value: ADD_MORE, label: 'Add more', icon: 'plus' as const, separatorBefore: true }]
      : []),
  ];

  return (
    <div className={styles.wrap}>
      {/* No option is ever "selected": the name, "Custom" or the prompt is the control's placeholder, so choosing any option, the one shown included, fires a change. The name and "Custom" are styled as a value, the prompt stays muted. */}
      <Select
        name={`saved-${kind}`}
        aria-label={label}
        className={shown.state === 'empty' ? undefined : styles.shown}
        value=""
        placeholder={
          shown.state === 'preset'
            ? shown.preset.name
            : shown.state === 'custom'
              ? 'Custom'
              : `Choose ${kindLabel.toLowerCase()}`
        }
        options={options}
        onChange={(event) => {
          if (event.target.value === ADD_MORE) {
            onAddMore?.();
            return;
          }
          const outcome = pickOutcome(event.target.value, offered, value, lastFilled);
          if (outcome.action === 'fill') fill(outcome.preset);
          else if (outcome.action === 'confirm') setAsking(outcome.preset);
        }}
      />
      {asking ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setAsking(null);
          }}
          title="Replace the text you typed?"
          description={`Choosing "${asking.name}" replaces what is in ${TERM_PRESET_KIND_LABELS[kind]} now.`}
          confirmLabel="Replace text"
          cancelLabel="Keep my text"
          onConfirm={() => {
            fill(asking);
          }}
        />
      ) : null}
    </div>
  );
}
