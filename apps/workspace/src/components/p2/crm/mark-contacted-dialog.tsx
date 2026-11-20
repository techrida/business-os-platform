'use client';

import { useId, useState, useTransition, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';

import { ActivityTypeButtons } from './activity-type-buttons';
import styles from './crm.module.css';
import type { MoveAction, MoveState } from './types';

const CONTACT_KINDS = ['call', 'email'] as const;
type ContactKind = (typeof CONTACT_KINDS)[number];

const BODY_REQUIRED = 'Add a note about the call or email, up to 10,000 characters.';
const SUBJECT_TOO_LONG = 'Say what the contact was about, up to 200 characters.';

const text = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

export interface MarkContactedDialogProps {
  /** The lead stage-move server action (`moveLeadStageAction`). */
  action: MoveAction;
  id: string;
  /** The lead number, named in the dialog so the person knows which lead they are updating. */
  number: string;
  /** The version the page shows; a stale one comes back as 409 and offers a reload. */
  version: number;
}

/**
 * The Mark contacted header action for a New lead (D48): logs the initial call or email and moves
 * the lead to Contacted in one request. Actions sit in the fixed footer (UIP-DLG-001); success
 * closes with a toast (UIP-FEED-001); a stale page (409) toasts with Reload and keeps what was typed.
 */
export function MarkContactedDialog({ action, id, number, version }: MarkContactedDialogProps) {
  const formId = useId();
  const [open, setOpenState] = useState(false);
  const [kind, setKind] = useState<ContactKind>('call');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [pending, startTransition] = useTransition();
  const [round, setRound] = useState(0);

  function setOpen(next: boolean) {
    if (next) {
      setKind('call');
      setFieldErrors({});
      setRound((r) => r + 1);
    }
    setOpenState(next);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const subject = text(data, 'contactSubject');
    const body = text(data, 'contactBody');
    const missing: Partial<Record<string, string>> = {};
    if (subject.length > 200) missing['contactSubject'] = SUBJECT_TOO_LONG;
    if (!body || body.length > 10000) missing['contactBody'] = BODY_REQUIRED;
    setFieldErrors(missing);
    if (missing['contactSubject'] || missing['contactBody']) return;
    data.set('contactBody', body);
    if (subject) data.set('contactSubject', subject);
    else data.delete('contactSubject');

    startTransition(async () => {
      const result: MoveState = await action({}, data);
      if (result.ok) {
        setOpenState(false);
        toast.success(`Moved to ${result.movedTo ?? 'Contacted'}.`);
        return;
      }
      setFieldErrors(result.fieldErrors ?? {});
      toast.error(
        result.error ??
          result.fieldErrors?.['stage'] ??
          (result.fieldErrors
            ? 'Check the highlighted fields.'
            : 'The lead could not be marked contacted.'),
        result.reload
          ? { action: { label: 'Reload', onClick: () => window.location.reload() } }
          : undefined,
      );
    });
  }

  return (
    <Dialog
      trigger={<Button variant="primary">Mark contacted</Button>}
      open={open}
      onOpenChange={setOpen}
      title="Mark this lead contacted?"
      description={`${number} will move from New to Contacted after you log your call or email.`}
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
            {pending ? 'Saving' : 'Mark contacted'}
          </Button>
        </>
      }
    >
      <form key={round} id={formId} noValidate onSubmit={onSubmit} className={styles.moveForm}>
        <input type="hidden" name="recordId" value={id} />
        <input type="hidden" name="expectedVersion" value={version} />
        <input type="hidden" name="stage" value="contacted" />
        <ActivityTypeButtons
          kinds={CONTACT_KINDS}
          value={kind}
          onChange={setKind}
          name="contactKind"
          label="Contact type"
          {...(fieldErrors['contactKind'] !== undefined
            ? { error: fieldErrors['contactKind'] }
            : {})}
          disabled={pending}
        />
        <Field
          label="Subject"
          hint="Optional. Defaults to Initial call or Initial email."
          error={fieldErrors['contactSubject']}
        >
          {(control) => <Input name="contactSubject" maxLength={200} {...control} />}
        </Field>
        <Field label="Note" error={fieldErrors['contactBody']}>
          {(control) => (
            <Textarea name="contactBody" rows={4} maxLength={10000} required {...control} />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
