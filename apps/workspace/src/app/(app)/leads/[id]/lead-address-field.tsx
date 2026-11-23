'use client';

import { type AddressLines } from '@bos/contracts';
import { useEffect, useRef, useState, useTransition, type FormEvent } from 'react';

import type { FieldErrors } from '@/components/p2/crm/forms';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Stack } from '@/components/ui/stack';
import { toast } from '@/components/ui/toast';

import { updateLeadAddressAction } from '../actions';
import styles from '../leads.module.css';

import own from './lead-contact-field.module.css';

export interface LeadAddressFieldProps {
  leadId: string;
  /** The lead's version as the page showed it; sent so a stale page gets a 409, not an overwrite. */
  version: number;
  /** The saved street lines and city, or null when the lead has no address. */
  address: AddressLines | null;
  /** Whether the caller may change it: an editor on a lead that is not converted. */
  editable: boolean;
}

/**
 * The value of the lead page's "Address" fact (D9): the street lines and city, or "Not set". An editor gets an
 * "Edit address" button that opens Address and City; both blank clears the address. The country is the lead's own,
 * changed in the Phone editor, and is not asked again here. A new version starts the editor from the page again.
 */
export function LeadAddressField(props: LeadAddressFieldProps) {
  const { address } = props;
  const display = address ? (
    <span>
      {address.line}, {address.city}
    </span>
  ) : (
    <span className={styles.quiet}>Not set</span>
  );
  if (!props.editable) return display;
  return (
    <Stack gap="small">
      {display}
      <AddressEditor key={props.version} {...props} />
    </Stack>
  );
}

function AddressEditor({ leadId, version, address }: LeadAddressFieldProps) {
  const [open, setOpen] = useState(false);
  const [line, setLine] = useState(address?.line ?? '');
  const [city, setCity] = useState(address?.city ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, startTransition] = useTransition();
  const form = useRef<HTMLFormElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<'form' | 'toggle' | null>(null);

  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === 'form') form.current?.querySelector<HTMLElement>('textarea')?.focus();
    if (target === 'toggle') toggle.current?.focus();
  }, [open]);

  function close() {
    focusNext.current = 'toggle';
    setOpen(false);
    setLine(address?.line ?? '');
    setCity(address?.city ?? '');
    setErrors({});
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (line.trim() === (address?.line ?? '') && city.trim() === (address?.city ?? '')) {
      close();
      return;
    }
    const data = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await updateLeadAddressAction({}, data);
      if (result.ok) {
        toast.success('Address saved.');
        close();
        return;
      }
      const message = result.error ?? 'The address could not be saved. Check the marked fields.';
      if (result.reload) {
        toast.error(message, {
          action: { label: 'Reload', onClick: () => window.location.reload() },
        });
        return;
      }
      setErrors({ ...result.fieldErrors, ...(result.error ? { form: result.error } : {}) });
      toast.error(message);
    });
  }

  if (!open) {
    return (
      <div>
        <Button
          ref={toggle}
          type="button"
          variant="secondary"
          size="small"
          aria-expanded={false}
          onClick={() => {
            focusNext.current = 'form';
            setOpen(true);
          }}
        >
          {address ? 'Edit address' : 'Add address'}
        </Button>
      </div>
    );
  }

  return (
    <form ref={form} noValidate onSubmit={onSubmit} aria-busy={pending || undefined}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <Stack gap="small">
        <Field
          label="Address (optional)"
          hint="Street lines. Leave Address and City both empty to remove the address."
          error={errors['address.line'] ?? errors['form']}
        >
          {(c) => (
            <Textarea
              {...c}
              name="address.line"
              rows={2}
              maxLength={500}
              autoComplete="street-address"
              value={line}
              disabled={pending}
              onChange={(e) => setLine(e.target.value)}
            />
          )}
        </Field>
        <Field label="City (optional)" error={errors['address.city']}>
          {(c) => (
            <Input
              {...c}
              name="address.city"
              maxLength={100}
              autoComplete="address-level2"
              value={city}
              disabled={pending}
              onChange={(e) => setCity(e.target.value)}
            />
          )}
        </Field>
        <div className={own.actions}>
          <Button
            type="submit"
            variant="secondary"
            size="small"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? 'Saving' : 'Save'}
          </Button>
          <Button type="button" variant="ghost" size="small" disabled={pending} onClick={close}>
            Cancel
          </Button>
        </div>
      </Stack>
    </form>
  );
}
