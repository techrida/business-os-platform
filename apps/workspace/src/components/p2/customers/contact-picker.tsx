'use client';

import type { CountryCode } from '@bos/contracts';
import { useMemo, useState } from 'react';

import { Combobox } from '@/components/ui/combobox';
import type { ComboboxOption } from '@/components/ui/combobox-model';
import type { FieldControlProps } from '@/components/ui/field';

import { ContactForm } from './contact-form';
import type { ContactFormState } from './form-state';

/** One contact of the customer, as a picker lists it. */
export interface ContactPickerOption {
  id: string;
  name: string;
  /** What else a search can match and the list shows beside the name: the job title and the email. */
  detail?: string | undefined;
  /** Listed but not choosable, with the reason shown in the row (for example no email address). */
  disabledReason?: string | undefined;
}

/**
 * What a picker needs to add a contact without leaving the form: the page's add-contact server action and the
 * customer it adds to.
 */
export interface ContactCreate {
  action: (prev: ContactFormState, form: FormData) => Promise<ContactFormState>;
  customerId: string;
  customerCountry?: CountryCode;
  /** The customer has no contact with an email yet, or the caller needs one (a quotation is sent to it). */
  requireEmail?: boolean;
}

/**
 * Search-and-pick for one of a customer's contacts (UIP-FORM-009): one box that filters as you type, each row
 * showing the name and what else matched (title, email). When the page lets the person add contacts, the last row
 * is `Create "<typed>"`: it opens the existing add-contact dialog with that name filled in, and the saved contact
 * becomes the choice. The chosen id posts under `name` (a hidden input), as the old select did.
 */
export function ContactPicker({
  control,
  name,
  options,
  value,
  onChange,
  create,
  placeholder,
  disabled,
  required,
}: {
  control: FieldControlProps;
  name?: string | undefined;
  options: readonly ContactPickerOption[];
  value: string;
  onChange: (id: string) => void;
  create?: ContactCreate | null | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState<{ name: string; key: string } | null>(null);
  const items = useMemo<ComboboxOption[]>(
    () =>
      options.map((o) => ({
        id: o.id,
        label: o.name,
        description: o.detail,
        disabled: o.disabledReason !== undefined,
        disabledReason: o.disabledReason,
      })),
    [options],
  );
  return (
    <>
      <Combobox
        id={control.id}
        labelledBy={control['aria-labelledby']}
        describedBy={control['aria-describedby']}
        invalid={control['aria-invalid'] === true}
        options={items}
        value={value}
        onChange={onChange}
        open={open}
        onOpenChange={setOpen}
        {...(name === undefined ? {} : { name })}
        {...(placeholder === undefined ? {} : { placeholder })}
        {...(disabled === undefined ? {} : { disabled })}
        {...(required === undefined ? {} : { required })}
        showDescriptionWhenClosed
        searchIcon
        keepOrder
        // A list of any length is one flat list: its options carry no group, so a header would only say "Unassigned".
        groupThreshold={Number.POSITIVE_INFINITY}
        noMatchText={create ? 'No matching contact.' : 'No matching contact for this customer.'}
        emptyText={create ? 'Type a name to add a contact.' : 'This customer has no contacts.'}
        {...(create
          ? {
              addOption: {
                always: true,
                label: (text: string) => `Create "${text}"`,
                onAdd: (text: string) => setCreating({ name: text, key: crypto.randomUUID() }),
              },
            }
          : {})}
      />
      {create && creating ? (
        <ContactForm
          key={creating.key}
          action={create.action}
          customerId={create.customerId}
          // One request key per opening; the add-contact action hands back the next one itself.
          idempotencyKey={creating.key}
          hasPrimary
          hidePrimary
          requireEmail={create.requireEmail ?? false}
          {...(create.customerCountry ? { customerCountry: create.customerCountry } : {})}
          initialName={creating.name}
          inDialog
          open
          onOpenChange={(next) => {
            if (!next) setCreating(null);
          }}
          onSaved={(id) => {
            setCreating(null);
            if (id) onChange(id);
          }}
        />
      ) : null}
    </>
  );
}
