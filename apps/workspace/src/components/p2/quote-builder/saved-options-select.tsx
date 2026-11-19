'use client';

import { TERM_PRESET_KIND_LABELS, type TermPreset, type TermPresetKind } from '@bos/contracts';
import { useState } from 'react';

import { ConfirmDialog } from '@/components/ui/dialog';
// The one place the dropdown control is chosen: the shared Select.
import { Select } from '@/components/ui/field';

import { offeredPresets, pickOutcome } from './saved-options';
import styles from './saved-options.module.css';

/**
 * "Saved options" above a text field. Choosing one fills the field with the saved text; the field
 * stays editable and keeps no link to the option. If the field was typed in since the last fill,
 * choosing another asks "Replace the text you typed?" first. Renders nothing when the kind has no
 * option that fits, so a person without access, or a failed load, sees no dropdown and no error.
 *
 * Generic by `kind`: any quotation text field with a matching preset kind can use it.
 */
export function SavedOptionsSelect({
  kind,
  presets,
  value,
  maxLength,
  onFill,
}: {
  kind: TermPresetKind;
  presets: readonly TermPreset[] | null | undefined;
  /** The field's current text. */
  value: string;
  /** The field's character limit; options longer than this are not offered. */
  maxLength: number;
  onFill: (text: string) => void;
}) {
  const offered = offeredPresets(presets, kind, maxLength);
  const [lastFilled, setLastFilled] = useState<string | null>(null);
  const [asking, setAsking] = useState<TermPreset | null>(null);

  if (offered.length === 0) return null;

  function fill(preset: TermPreset) {
    setLastFilled(preset.body);
    onFill(preset.body);
  }

  return (
    <div className={styles.wrap}>
      {/* Always shows "Saved options": the field holds plain text, not a chosen option. */}
      <Select
        name={`saved-${kind}`}
        aria-label={`Saved options for ${TERM_PRESET_KIND_LABELS[kind]}`}
        value=""
        onChange={(event) => {
          const outcome = pickOutcome(event.target.value, offered, value, lastFilled);
          if (outcome.action === 'fill') fill(outcome.preset);
          else if (outcome.action === 'confirm') setAsking(outcome.preset);
        }}
      >
        <option value="">Saved options</option>
        {offered.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.name}
          </option>
        ))}
      </Select>
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
