'use client';

import type { TermPreset, TermPresetKind } from '@bos/contracts';
import { useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { RichTextEditor } from '@/components/ui/rich-text-editor';
import { toast } from '@/components/ui/toast';
import { savePresetAction } from '@/app/(app)/settings/terms/actions';

import {
  TERM_BODY_LIMITS,
  TERM_NAME_LIMIT,
  termKindLabel,
  validatePreset,
} from './term-preset-model';
import styles from './term-presets.module.css';

const FORM_ID = 'term-preset-form';

/**
 * Add or edit one term set: a name and rich text (lists, bold, italic; D31) with the kind's character
 * limit and counter. The editor reports sanitised HTML, and the server action sanitises it again.
 * Actions sit in the dialog's fixed footer (UIP-DLG-001). Mount it only while open (the parent keys
 * it), so each opening starts from the saved values. A click outside does not close it, so typed
 * text is not lost.
 */
export function TermPresetDialog({
  kind,
  preset,
  onClose,
}: {
  kind: TermPresetKind;
  /** Absent when adding. */
  preset?: TermPreset | undefined;
  onClose: () => void;
}) {
  const [name, setName] = useState(preset?.name ?? '');
  const [body, setBody] = useState(preset?.body ?? '');
  const [errors, setErrors] = useState<Partial<Record<'name' | 'body', string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const limit = TERM_BODY_LIMITS[kind];
  const label = termKindLabel(kind);
  const dirty = preset === undefined || name !== preset.name || body !== preset.body;
  const title = preset ? 'Edit term set' : 'Add term set';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const checked = validatePreset(kind, { name, body });
    if (!checked.ok) {
      setErrors(checked.fieldErrors);
      setFailure(null);
      return;
    }
    setErrors({});
    setFailure(null);
    setPending(true);
    try {
      const result = await savePresetAction({
        id: preset?.id,
        kind,
        // What the contract will store: the name trimmed, the text rebuilt from the allow-list.
        name: checked.value.name,
        body: checked.value.body,
        initialName: preset?.name,
        initialBody: preset?.body,
      });
      if (result.status === 'ok') {
        toast.success(result.message);
        onClose();
        return;
      }
      setErrors(result.fieldErrors ?? {});
      setFailure(result.fieldErrors ? null : result.message);
    } catch {
      setFailure('The platform did not answer. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      description={`Term set for the ${label} field.`}
      size="large"
      className={styles.dialog ?? ''}
      locked={pending}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="submit"
            form={FORM_ID}
            disabled={pending || !dirty}
            aria-busy={pending || undefined}
          >
            {preset ? 'Save changes' : 'Add term set'}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className={styles.dialogForm} onSubmit={(e) => void submit(e)} noValidate>
        {failure ? (
          <Alert tone="error" role="alert">
            {failure}
          </Alert>
        ) : null}
        <Field label="Name" hint="Shown in the term sets list." error={errors.name}>
          {(control) => (
            <Input
              value={name}
              maxLength={TERM_NAME_LIMIT}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              {...control}
            />
          )}
        </Field>
        <Field label="Text" error={errors.body}>
          {(control) => (
            <RichTextEditor
              id={control.id}
              aria-labelledby={control['aria-labelledby']}
              aria-describedby={control['aria-describedby']}
              invalid={Boolean(control['aria-invalid'])}
              value={body}
              onChange={setBody}
              maxChars={limit}
              disabled={pending}
              minHeight={200}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
