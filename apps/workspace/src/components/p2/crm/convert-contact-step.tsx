'use client';
// Step 2 of the convert wizard: the contact. A new contact starts from the lead's person; with an organisation chosen
// in step 1 the contact can instead be one of its people, found in one combobox whose last row is Create "<typed>".
import { MAX_PARTY_PHONES, type CountryCode, type PartyPhoneInput } from '@bos/contracts';
import { useEffect, useMemo, useState } from 'react';

import styles from '@/app/(app)/leads/leads.module.css';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import type { ComboboxOption } from '@/components/ui/combobox-model';
import { CountrySelect } from '@/components/ui/country-select';
import { Field, Input } from '@/components/ui/field';
import { PhoneListInput } from '@/components/ui/phone-list-input';

import type { ConvertLead } from './convert-dialog';
import { OptionalLabel } from './convert-parts';
import type { ContactLookup, StepContext } from './convert-types';
import { loadConversionContacts } from './record-lookups';

type Loaded = {
  customerId: string;
  options: { id: string; label: string; disabled?: boolean }[];
  error: string;
};

export function ContactStep({
  lead,
  ctx,
  phones,
  setPhones,
  dupes,
  onLookup,
}: {
  lead: ConvertLead;
  ctx: StepContext;
  phones: readonly PartyPhoneInput[];
  setPhones: (phones: readonly PartyPhoneInput[]) => void;
  dupes: readonly { kind: string; id: string; label: string }[];
  /** Tells the dialog what this customer's contacts look like (unreadable, or without an email). */
  onLookup: (lookup: ContactLookup) => void;
}) {
  const { values, patch, set, err } = ctx;
  const customerId = values['customerId'] ?? '';
  // A contact of an existing organisation can be linked; a new organisation has no contacts yet.
  const canLink = values['customerMode'] === 'existing' && customerId !== '';
  const contactMode = canLink ? values['contactMode'] : 'create';
  const contactCountry = (values['contactCountry'] ?? lead.country) as CountryCode;
  const [contacts, setContacts] = useState<Loaded | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!canLink) return;
    let active = true;
    void loadConversionContacts(customerId)
      .then((result) => {
        if (!active) return;
        setContacts({ customerId, ...result });
        onLookup({
          customerId,
          unreadable: result.unreadable,
          noEmailIds: result.options.filter((o) => o.disabled).map((o) => o.id),
        });
      })
      .catch(() => {
        if (active) {
          setContacts({
            customerId,
            options: [],
            error: 'Contacts could not be loaded. Try again.',
          });
        }
      });
    return () => {
      active = false;
    };
    // onLookup is a state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, canLink]);

  const loaded = contacts?.customerId === customerId ? contacts : null;
  const contactId = values['contactId'] ?? '';
  const options = useMemo<ComboboxOption[]>(() => {
    const list = (loaded?.options ?? []).map((o) => ({
      id: o.id,
      label: o.label,
      disabled: o.disabled,
    }));
    if (contactId !== '' && !list.some((o) => o.id === contactId)) {
      const label = dupes.find((d) => d.kind === 'contact' && d.id === contactId)?.label;
      list.unshift({ id: contactId, label: label ?? 'Selected contact', disabled: undefined });
    }
    return list;
  }, [loaded, contactId, dupes]);

  return (
    <fieldset className={styles.conversionSection}>
      <legend className={styles.legend}>Contact</legend>
      {canLink ? (
        <>
          <label className={styles.choice}>
            <input
              type="radio"
              name="contactMode"
              value="create"
              checked={contactMode === 'create'}
              onChange={set('contactMode')}
            />
            Create a contact from the lead
          </label>
          <label className={styles.choice}>
            <input
              type="radio"
              name="contactMode"
              value="existing"
              checked={contactMode === 'existing'}
              onChange={set('contactMode')}
            />
            Link to an existing contact
          </label>
        </>
      ) : (
        <input type="hidden" name="contactMode" value="create" />
      )}

      {/* Kept mounted while an existing contact is chosen, so the typed numbers and their checks come back with
          it; disabled, nothing in it posts or stops the submit. */}
      <div hidden={contactMode !== 'create'}>
        <fieldset className={styles.convertFields} disabled={contactMode !== 'create'}>
          <div className={styles.formGrid}>
            <Field label="Contact name" error={err['contactName']}>
              {(c) => (
                <Input
                  name="contactName"
                  value={values['contactName']}
                  onChange={set('contactName')}
                  required
                  maxLength={200}
                  {...c}
                />
              )}
            </Field>
            <Field label="Email" hint="Quotations are sent to it." error={err['contactEmail']}>
              {(c) => (
                <Input
                  name="contactEmail"
                  type="email"
                  value={values['contactEmail']}
                  onChange={set('contactEmail')}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={254}
                  required
                  {...c}
                />
              )}
            </Field>
            <Field label="Contact country" error={err['contactCountry']}>
              {(c) => (
                <CountrySelect
                  id={c.id}
                  aria-labelledby={c['aria-labelledby']}
                  aria-describedby={c['aria-describedby']}
                  aria-invalid={c['aria-invalid']}
                  name="contactCountry"
                  required
                  value={contactCountry}
                  onChange={(country) => patch({ contactCountry: country })}
                />
              )}
            </Field>
          </div>
          <Field label={<OptionalLabel>Phone</OptionalLabel>}>
            {(c) => (
              <PhoneListInput
                key={`${lead.id}-${lead.version}`}
                name="contactPhones"
                aria-labelledby={c['aria-labelledby']}
                aria-describedby={c['aria-describedby']}
                defaultValue={phones}
                defaultCountry={contactCountry}
                onChange={setPhones}
                rowErrors={Array.from(
                  { length: MAX_PARTY_PHONES },
                  (_, row) => err[`contactPhones.${row}`],
                )}
                error={err['contactPhones']}
                disabled={contactMode !== 'create'}
              />
            )}
          </Field>
        </fieldset>
      </div>

      {contactMode === 'existing' ? (
        <>
          <Field label="Contact" hint={loaded?.error || undefined} error={err['contactId']}>
            {(c) => (
              <Combobox
                id={c.id}
                name="contactId"
                maxLength={200}
                labelledBy={c['aria-labelledby']}
                describedBy={c['aria-describedby']}
                invalid={c['aria-invalid'] === true}
                required
                keepOrder
                groupThreshold={Number.POSITIVE_INFINITY}
                options={options}
                value={contactId}
                onChange={(id) => patch({ contactId: id })}
                open={open}
                onOpenChange={setOpen}
                addOption={{
                  always: true,
                  label: (typed) => `Create "${typed}"`,
                  onAdd: (typed) => {
                    patch({ contactMode: 'create', contactId: '', contactName: typed });
                  },
                }}
                emptyText="This organisation has no contacts yet. Type a new name."
                noMatchText="No matching contact."
                placeholder="Search this organisation's contacts"
              />
            )}
          </Field>
          {err['contactId'] &&
          contactId !== '' &&
          loaded?.options.some((o) => o.id === contactId && o.disabled) ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => patch({ contactMode: 'create', contactId: '' })}
              >
                Create a contact from the lead instead
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </fieldset>
  );
}
