'use client';

import { useId, useState, useTransition, type FormEvent } from 'react';

import styles from '@/components/p2/crm/crm.module.css';
import type { MoveState } from '@/components/p2/crm/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';

import { moveLeadStageAction } from '../actions';

/** The same wording the stage-move parser uses, so the client and the server never disagree. */
const REASON_REQUIRED = 'Give a reason, up to 200 characters.';
const NOTE_REQUIRED = 'Add a note for the record, up to 2,000 characters.';

const text = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

export interface MarkLostDialogProps {
  id: string;
  /** The lead number, named in the dialog so the person knows which lead they are closing. */
  number: string;
  /** The version the page shows; a stale one comes back as 409 and offers a reload. */
  version: number;
}

/**
 * The Mark lost header action (D41). Lost needs a reason and a note (the stage rules and the
 * database both insist), so the dialog refuses an empty one before any request. Actions sit in the
 * fixed footer (UIP-DLG-001); a success closes the dialog with a toast (UIP-FEED-001); a stale
 * page (409) toasts with Reload and keeps what was typed.
 */
export function MarkLostDialog({ id, number, version }: MarkLostDialogProps) {
  const formId = useId();
  const [open, setOpenState] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [pending, startTransition] = useTransition();
  // Bumped on every open, so the form remounts empty instead of showing the last attempt.
  const [round, setRound] = useState(0);

  function setOpen(next: boolean) {
    if (next) {
      setFieldErrors({});
      setRound((r) => r + 1);
    }
    setOpenState(next);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Enter in the reason field still submits while the button is disabled; one request at a time.
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const reason = text(data, 'reason');
    const note = text(data, 'note');
    const missing: Partial<Record<string, string>> = {};
    if (!reason) missing['reason'] = REASON_REQUIRED;
    if (!note) missing['note'] = NOTE_REQUIRED;
    setFieldErrors(missing);
    if (missing['reason'] || missing['note']) return;
    data.set('reason', reason);
    data.set('note', note);

    startTransition(async () => {
      const result: MoveState = await moveLeadStageAction({}, data);
      if (result.ok) {
        setOpenState(false);
        toast.success(`Moved to ${result.movedTo ?? 'Lost'}.`);
        return;
      }
      setFieldErrors(result.fieldErrors ?? {});
      toast.error(
        result.error ??
          result.fieldErrors?.['stage'] ??
          (result.fieldErrors
            ? 'Check the highlighted fields.'
            : 'The lead could not be marked lost.'),
        result.reload
          ? { action: { label: 'Reload', onClick: () => window.location.reload() } }
          : undefined,
      );
    });
  }

  return (
    <Dialog
      trigger={<Button variant="secondary">Mark lost</Button>}
      open={open}
      onOpenChange={setOpen}
      title="Mark this lead lost?"
      description={`${number} will move to Lost. A manager can reopen it later.`}
      tone="destructive"
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
            {pending ? 'Saving' : 'Mark lost'}
          </Button>
        </>
      }
    >
      <form key={round} id={formId} noValidate onSubmit={onSubmit} className={styles.moveForm}>
        <input type="hidden" name="recordId" value={id} />
        <input type="hidden" name="expectedVersion" value={version} />
        <input type="hidden" name="stage" value="lost" />
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
