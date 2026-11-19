'use client';

import type { TermPreset, TermPresetKind } from '@bos/contracts';
import { useState, type FormEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
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
 * Add or edit one saved option: name and text, with the kind's character limit. Actions sit in the
 * dialog's fixed footer (UIP-DLG-001). Mount it only while open (the parent keys it), so each opening
 * starts from the saved values. A click outside does not close it, so typed text is not lost.
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
        name,
        body,
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
      title={preset ? `Edit option` : `Add option`}
      description={`Saved option for the ${label} field.`}
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
            {preset ? 'Save changes' : 'Add option'}
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
        <Field label="Name" hint="Shown in the Saved options list." error={errors.name}>
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
        <Field
          label="Text"
          hint={`${body.length.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} characters`}
          error={errors.body}
        >
          {(control) => (
            <Textarea
              className={styles.bodyText}
              rows={8}
              value={body}
              maxLength={limit}
              onChange={(e) => setBody(e.target.value)}
              {...control}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
