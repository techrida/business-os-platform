'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';

import { ContactPicker, type ContactCreate } from './contact-picker';
import type { PortalInviteState } from './form-state';
import styles from './customer-form.module.css';

/** One of the customer's existing contacts, as the invite may offer it. */
export interface PortalContactOption {
  id: string;
  label: string;
  /** The contact's name and what else a search matches (title, email); `label` is used when missing. */
  name?: string;
  detail?: string | undefined;
  /** A contact without an email cannot receive the invite, so it is listed but cannot be chosen. */
  hasEmail: boolean;
}

/**
 * Invite a portal admin for a customer (F1-Q31). Only the customer's existing contacts are offered: there is no
 * email field, so nobody outside the customer record can be invited. The dialog's own button sends the invite and
 * a success closes it with a toast; a refusal stays in the dialog.
 */
export function PortalInviteForm({
  action,
  customerId,
  contacts,
  createContact,
  idempotencyKey,
  first,
}: {
  action: (prev: PortalInviteState, form: FormData) => Promise<PortalInviteState>;
  customerId: string;
  contacts: PortalContactOption[];
  /** When set, the picker's last row adds a contact to this customer and chooses it. */
  createContact?: ContactCreate | null;
  /** A UUID the server made for this render. */
  idempotencyKey: string;
  /** No portal user yet: this invite makes the first portal admin. */
  first: boolean;
}) {
  const [state, formAction, pending] = useActionState<PortalInviteState, FormData>(action, {
    key: idempotencyKey,
    errors: {},
    savedCount: 0,
  });
  const formId = useId();
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [choice, setChoice] = useState({ savedCount: 0, contactId: '' });
  const contactId = choice.savedCount === state.savedCount ? choice.contactId : '';
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.saved) toast.success(state.saved);
    if (state.error) summaryRef.current?.focus();
  }, [state]);

  const title = first ? 'Invite portal admin' : 'Invite portal user';
  return (
    <Dialog
      trigger={
        <Button variant="secondary" size="small">
          {title}
        </Button>
      }
      title={title}
      open={openedAt === state.savedCount}
      onOpenChange={(open) => setOpenedAt(open ? state.savedCount : null)}
      locked={pending}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form={formId} variant="primary" disabled={pending}>
            {pending ? 'Sending' : 'Send invite'}
          </Button>
        </>
      }
    >
      <form id={formId} action={formAction} noValidate className={styles.contactForm}>
        <input type="hidden" name="customerId" value={customerId} />
        <input type="hidden" name="idempotencyKey" value={state.key} />
        {state.error ? (
          <Alert ref={summaryRef} tabIndex={-1} tone="error" role="alert" title="Invite not sent">
            {state.error}
          </Alert>
        ) : null}
        <Field
          label="Contact"
          hint="Choose one of this customer's contacts. They get an email invitation to the customer portal."
          error={state.errors.contactId}
        >
          {(c) => (
            <ContactPicker
              control={c}
              name="contactId"
              options={contacts.map((o) => ({
                id: o.id,
                name: o.name ?? o.label,
                detail: o.detail ?? undefined,
                disabledReason: o.hasEmail ? undefined : 'No email address',
              }))}
              value={contactId}
              onChange={(id) => setChoice({ savedCount: state.savedCount, contactId: id })}
              create={createContact ? { ...createContact, requireEmail: true } : null}
              placeholder="Search a contact"
              required
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
