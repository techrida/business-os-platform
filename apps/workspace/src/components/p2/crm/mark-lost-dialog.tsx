'use client';

import { LEAD_LOST_REASON_LABEL_MAX, type LeadLostReason } from '@bos/contracts';
import { useId, useMemo, useState, useTransition, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';

import styles from './crm.module.css';
import type { MoveAction, MoveState } from './types';

/** The same wording the stage-move parser uses, so the client and the server never disagree. */
const REASON_REQUIRED = 'Choose a reason from the list, or add a new one.';
const REASON_REFUSED =
  /already on the list of lost reasons|no longer offered as a lost reason|Unknown lost reason/;
const REASON_TOO_LONG = `Keep a new reason to ${LEAD_LOST_REASON_LABEL_MAX} characters or fewer.`;
const NOTE_REQUIRED = 'Add a note for the record, up to 2,000 characters.';

const text = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

export interface MarkLostDialogProps {
  /** Which CRM record is being marked lost; controls the dialog wording. */
  noun: 'lead' | 'opportunity';
  /** The stage-move server action (`moveLeadStageAction` or `moveOpportunityStageAction`). */
  action: MoveAction;
  id: string;
  /** The record number, named in the dialog so the person knows which record they are closing. */
  number: string;
  /** The version the page shows; a stale one comes back as 409 and offers a reload. */
  version: number;
  /** The tenant's lost reasons the person may pick (D49), in the list's order, retired ones left out. */
  reasons: readonly LeadLostReason[];
}

/** The id the combobox gives a reason typed and added in this dialog; it exists only until the form is sent. */
const NEW_ID = '__new__';
type Pick = { kind: 'id'; id: string } | { kind: 'new'; text: string } | null;

/**
 * The Mark lost header action shared by leads and opportunities (D41, D49, D54-3). Lost needs a
 * reason and a note (the stage rules and the database both insist), so the dialog refuses an empty
 * one before any request. The reason is chosen from the tenant's list: typing filters it, and text
 * that matches nothing offers Add "<text>", which is saved as a new option together with the lost
 * move. Actions sit in the fixed footer (UIP-DLG-001); a success closes the dialog with a toast
 * (UIP-FEED-001); a stale page (409) toasts with Reload and keeps what was typed.
 */
export function MarkLostDialog({
  noun,
  action,
  id,
  number,
  version,
  reasons,
}: MarkLostDialogProps) {
  const formId = useId();
  const [open, setOpenState] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [pending, startTransition] = useTransition();
  // Bumped on every open, so the form remounts empty instead of showing the last attempt.
  const [round, setRound] = useState(0);
  const [pick, setPick] = useState<Pick>(null);
  const [listOpen, setListOpen] = useState(false);
  const options = useMemo(
    () => [
      ...reasons.map((r) => ({ id: r.id, label: r.label })),
      ...(pick?.kind === 'new' ? [{ id: NEW_ID, label: pick.text }] : []),
    ],
    [reasons, pick],
  );

  function setOpen(next: boolean) {
    if (next) {
      setFieldErrors({});
      setPick(null);
      setListOpen(false);
      setRound((r) => r + 1);
    }
    setOpenState(next);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Enter in the reason field still submits while the button is disabled; one request at a time.
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const note = text(data, 'note');
    const missing: Partial<Record<string, string>> = {};
    if (pick === null) missing['reason'] = REASON_REQUIRED;
    else if (pick.kind === 'new' && pick.text.length > LEAD_LOST_REASON_LABEL_MAX) {
      missing['reason'] = REASON_TOO_LONG;
    }
    if (!note) missing['note'] = NOTE_REQUIRED;
    setFieldErrors(missing);
    if (missing['reason'] || missing['note']) return;
    data.set('note', note);

    startTransition(async () => {
      const result: MoveState = await action({}, data);
      if (result.ok) {
        setOpenState(false);
        toast.success(`Moved to ${result.movedTo ?? 'Lost'}.`);
        return;
      }
      // The API's words for the two reason fields land under the one Reason control.
      const errors = { ...(result.fieldErrors ?? {}) };
      const reasonError = errors['lostReasonId'] ?? errors['newLostReason'];
      if (reasonError !== undefined) errors['reason'] = reasonError;
      else if (result.error !== undefined && REASON_REFUSED.test(result.error)) {
        // A duplicate added, or an option retired, since the list was read.
        errors['reason'] = result.error;
      }
      setFieldErrors(errors);
      toast.error(
        result.error ??
          result.fieldErrors?.['stage'] ??
          (result.fieldErrors
            ? 'Check the highlighted fields.'
            : `The ${noun} could not be marked lost.`),
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
      title={noun === 'lead' ? 'Mark this lead lost?' : 'Mark this opportunity lost?'}
      // No promise about reopening (U22-Q1): who may reopen is the server's call, and the record
      // carries no reopen capability before it is lost.
      description={
        noun === 'lead'
          ? `${number} will move to Lost.`
          : `${number} will move to Lost. Open quotations on this deal will be cancelled.`
      }
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
        {pick?.kind === 'id' ? <input type="hidden" name="lostReasonId" value={pick.id} /> : null}
        {pick?.kind === 'new' ? (
          <input type="hidden" name="newLostReason" value={pick.text} />
        ) : null}
        <Field label="Reason" error={fieldErrors['reason']}>
          {(control) => (
            <Combobox
              labelledBy={control['aria-labelledby']}
              describedBy={control['aria-describedby']}
              invalid={control['aria-invalid'] === true}
              required
              keepOrder
              groupThreshold={Number.POSITIVE_INFINITY}
              options={options}
              value={pick === null ? '' : pick.kind === 'id' ? pick.id : NEW_ID}
              onChange={(next) => {
                if (next === '') setPick(null);
                else if (next !== NEW_ID) setPick({ kind: 'id', id: next });
              }}
              open={listOpen}
              onOpenChange={setListOpen}
              placeholder="Choose a reason or type a new one"
              emptyText="No reasons yet. Type one to add it."
              noMatchText="No matching reason."
              addOption={{ onAdd: (typed) => setPick({ kind: 'new', text: typed }) }}
            />
          )}
        </Field>
        <Field label="Note" error={fieldErrors['note']}>
          {(control) => <Textarea name="note" rows={4} maxLength={2000} required {...control} />}
        </Field>
      </form>
    </Dialog>
  );
}
