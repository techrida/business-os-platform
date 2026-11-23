'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type ComponentProps,
  type FormEvent,
} from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';

import { ActivityTypeButtons } from './activity-type-buttons';
import styles from './crm.module.css';
import type { MoveAction, MoveState } from './types';

const CONTACT_KINDS = ['call', 'email', 'meeting'] as const;
type ContactKind = (typeof CONTACT_KINDS)[number];

const BODY_REQUIRED = 'Add a note about the call, email or meeting, up to 10,000 characters.';
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
  /** The trigger's text. Defaults to "Mark contacted". */
  triggerLabel?: string | undefined;
  /** The trigger's button look. Defaults to primary. */
  triggerVariant?: ComponentProps<typeof Button>['variant'];
  /** The stage the lead moves from, named in the description. Defaults to "New". */
  fromLabel?: string | undefined;
  /** The dialog heading. Defaults to "Mark this lead contacted?". */
  title?: string | undefined;
  /** The submit button's text. Defaults to "Mark contacted". */
  confirmLabel?: string | undefined;
  /** Controlled open state. When given, no trigger renders: the caller opens the dialog. */
  open?: boolean | undefined;
  /** Called whenever the dialog opens or closes, including the close after a successful move. */
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** Called after a successful move with the stage label moved to. */
  onMoved?: ((movedTo: string) => void) | undefined;
}

/**
 * The Mark contacted action for a lead (D48): logs the initial call, email or meeting and moves
 * the lead to Contacted in one request. Actions sit in the fixed footer (UIP-DLG-001); success
 * closes with a toast (UIP-FEED-001); a stale page (409) toasts with Reload and keeps what was typed.
 * Pass `open` and `onOpenChange` to open it from elsewhere (a board drop) without its own trigger.
 */
export function MarkContactedDialog({
  action,
  id,
  number,
  version,
  triggerLabel = 'Mark contacted',
  triggerVariant = 'primary',
  fromLabel = 'New',
  title = 'Mark this lead contacted?',
  confirmLabel = 'Mark contacted',
  open: openProp,
  onOpenChange,
  onMoved,
}: MarkContactedDialogProps) {
  const formId = useId();
  const controlled = openProp !== undefined;
  const [innerOpen, setInnerOpen] = useState(false);
  const open = controlled ? openProp : innerOpen;
  const [kind, setKind] = useState<ContactKind>('call');
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

  // Every close clears the form (whoever closed it), so the next open, by trigger or by the
  // caller's `open`, starts on Call with nothing typed and no errors. Adjusted during render when
  // `open` changes, as React recommends over an effect.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setKind('call');
      setFieldErrors({});
      setRound((r) => r + 1);
    }
  }

  function setOpen(next: boolean) {
    if (!controlled) setInnerOpen(next);
    onOpenChange?.(next);
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
    if (missing['contactSubject'] || missing['contactBody']) {
      setRefusals((n) => n + 1);
      return;
    }
    data.set('contactBody', body);
    if (subject) data.set('contactSubject', subject);
    else data.delete('contactSubject');

    startTransition(async () => {
      const result: MoveState = await action({}, data);
      if (result.ok) {
        const movedTo = result.movedTo ?? 'Contacted';
        setOpen(false);
        toast.success(`Moved to ${movedTo}.`);
        onMoved?.(movedTo);
        return;
      }
      setFieldErrors(result.fieldErrors ?? {});
      if (result.fieldErrors) setRefusals((n) => n + 1);
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
      trigger={controlled ? undefined : <Button variant={triggerVariant}>{triggerLabel}</Button>}
      open={open}
      onOpenChange={setOpen}
      title={title}
      description={`${number} will move from ${fromLabel} to Contacted after you log your call, email or meeting.`}
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
            {pending ? 'Saving' : confirmLabel}
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
        <Field label="Subject" optional error={fieldErrors['contactSubject']}>
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
