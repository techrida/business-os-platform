'use client';

import type { TermPreset, TermPresetKind } from '@bos/contracts';

import type { FieldControlProps } from '@/components/ui/field';
import { RichTextEditor } from '@/components/ui/rich-text-editor';

import { SAVED_TERMS_HREF } from './saved-options';
import { SavedOptionsSelect } from './saved-options-select';

/**
 * One terms field of the quotation (D31): the saved-sets dropdown above a rich text editor. Put it
 * inside `Field`'s render function and pass the control it hands you. The value is the editor's
 * HTML ('' when empty); a set fills it and it stays editable.
 *
 * `canAddTerms` is decided on the server (the person may edit saved terms, the Founder) and only
 * adds the "Add more" entry; the API still enforces who may edit a set.
 */
export function TermsField({
  kind,
  presets,
  canAddTerms = false,
  value,
  onChange,
  maxChars,
  control,
  minHeight,
  disabled = false,
}: {
  kind: TermPresetKind;
  presets: readonly TermPreset[] | null | undefined;
  canAddTerms?: boolean | undefined;
  value: string;
  onChange: (html: string) => void;
  maxChars: number;
  control: FieldControlProps;
  /** Height of the typing area before it grows; a number is pixels. */
  minHeight?: string | number | undefined;
  /** The form is busy: a disabled fieldset does not reach a contenteditable, so the editor is told. */
  disabled?: boolean | undefined;
}) {
  return (
    <>
      <SavedOptionsSelect
        kind={kind}
        presets={presets}
        value={value}
        maxLength={maxChars}
        onFill={onChange}
        onAddMore={canAddTerms ? () => window.open(SAVED_TERMS_HREF, '_blank', 'noopener') : undefined}
      />
      <RichTextEditor
        id={control.id}
        aria-labelledby={control['aria-labelledby']}
        aria-describedby={control['aria-describedby']}
        invalid={control['aria-invalid'] === true}
        value={value}
        onChange={onChange}
        maxChars={maxChars}
        minHeight={minHeight}
        disabled={disabled}
      />
    </>
  );
}
