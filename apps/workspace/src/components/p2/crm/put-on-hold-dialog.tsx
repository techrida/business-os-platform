'use client';

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';

import styles from './crm.module.css';
import type { MoveAction, MoveState } from './types';

const REASON_REQUIRED = 'Give a reason, up to 200 characters.';
const NOTE_REQUIRED = 'Add a note for the record, up to 2,000 characters.';

const text = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

export interface PutOnHoldDialogProps {
  /** Which CRM record is being put on hold; controls the dialog wording. */
  noun: 'lead' | 'opportunity';
  /** The stage-move server action (`moveLeadStageAction` or `moveOpportunityStageAction`). */
  action: MoveAction;
  id: string;
  /** The record number, named in the dialog so the person knows which record they are pausing. */
  number: string;
  /** The version the page shows; a stale one comes back as 409 and offers a reload. */
  version: number;
}

/**
 * The Put on hold header action shared by leads and opportunities. On Hold requires a free-text
 * reason and a note; actions sit in the fixed footer (UIP-DLG-001), success closes with a toast
 * (UIP-FEED-001), and a stale page (409) toasts with Reload while keeping the typed inputs.
 */
export function PutOnHoldDialog({ noun, action, id, number, version }: PutOnHoldDialogProps) {
  const formId = useId();
  const [open, setOpenState] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [pending, startTransition] = useTransition();
  const [round, setRound] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  // Bumped on every refused submit: focus moves to the first field in error, so a screen reader
  // reads its label and error at once instead of the refusal going unannounced.
  const [refusals, setRefusals] = useState(0);

  useEffect(() => {
    if (refusals > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [refusals]);

  function setOpen(next: boolean) {
    if (next) {
      setFieldErrors({});
      setRound((r) => r + 1);
    }
    setOpenState(next);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const reason = text(data, 'reason');
    const note = text(data, 'note');
    const missing: Partial<Record<string, string>> = {};
    if (!reason || reason.length > 200) missing['reason'] = REASON_REQUIRED;
    if (!note || note.length > 2000) missing['note'] = NOTE_REQUIRED;
    setFieldErrors(missing);
    if (missing['reason'] || missing['note']) {
      setRefusals((n) => n + 1);
      return;
    }
    data.set('reason', reason);
    data.set('note', note);

    startTransition(async () => {
      const result: MoveState = await action({}, data);
      if (result.ok) {
        setOpenState(false);
        toast.success(`Moved to ${result.movedTo ?? 'On Hold'}.`);
        return;
      }
      setFieldErrors(result.fieldErrors ?? {});
      if (result.fieldErrors) setRefusals((n) => n + 1);
      toast.error(
        result.error ??
          result.fieldErrors?.['stage'] ??
          (result.fieldErrors
            ? 'Check the highlighted fields.'
            : `The ${noun} could not be put on hold.`),
        result.reload
          ? { action: { label: 'Reload', onClick: () => window.location.reload() } }
          : undefined,
      );
    });
  }

  return (
    <Dialog
      trigger={<Button variant="secondary">Put on hold</Button>}
      open={open}
      onOpenChange={setOpen}
      title={noun === 'lead' ? 'Put this lead on hold?' : 'Put this opportunity on hold?'}
      description={`${number} will move to On Hold. You can resume it later.`}
      locked={pending}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form={formId} disabled={pending} aria-busy={pending || undefined}>
            {pending ? 'Saving' : 'Put on hold'}
          </Button>
        </>
      }
    >
      <form
        ref={formRef}
        key={round}
        id={formId}
        noValidate
        onSubmit={onSubmit}
        className={styles.moveForm}
      >
        <input type="hidden" name="recordId" value={id} />
        <input type="hidden" name="expectedVersion" value={version} />
        <input type="hidden" name="stage" value="on_hold" />
        <Field label="Reason" error={fieldErrors['reason']}>
          {(control) => <Input name="reason" maxLength={200} required {...control} />}
        </Field>
        <Field label="Note" error={fieldErrors['note']}>
          {(control) => <Textarea name="note" rows={4} maxLength={2000} required {...control} />}
        </Field>
      </form>
    </Dialog>
  );
}
