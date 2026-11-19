'use client';

import { useActionState, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import shell from '@/app/(app)/settings/_components/settings.module.css';
import { IDLE, type ActionState } from '@/app/(app)/settings/action-state';
import { FormStatus } from '@/app/(app)/settings/form-status';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { Panel } from '@/components/ui/panel';

import {
  addPhone,
  canAddPhone,
  countryOptions,
  draftsFromSettings,
  removePhone,
  sameDraft,
  setPhone,
  MAX_PHONES,
  type CompanyCard,
  type CompanyDrafts,
  type CompanySettings,
  type FieldErrors,
} from './company-profile';
import styles from './company-editor.module.css';
import { LetterheadPreview } from './letterhead-preview';
import { LogoCard } from './logo-card';

type Action = (previous: ActionState, formData: FormData) => Promise<ActionState>;

const ADDRESS_HELP = 'Quotations and invoices cannot be made into PDFs until an address is saved.';

/**
 * One card, one decision, one Save. Dirty means "the draft differs from what is saved": Save is
 * disabled otherwise. A refused field keeps its input and shows its message at the field. When a
 * save goes through, `onSaved` hands the card back to the saved values.
 */
function CardForm({
  card,
  title,
  description,
  action,
  dirty,
  onSaved,
  children,
}: {
  card: CompanyCard;
  title: string;
  description?: ReactNode;
  action: Action;
  dirty: boolean;
  onSaved: () => void;
  children: (errors: FieldErrors) => ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const saved = useRef(onSaved);
  useEffect(() => {
    saved.current = onSaved;
  });
  useEffect(() => {
    if (state.status === 'ok') saved.current();
  }, [state]);
  const errors: FieldErrors = state.status === 'error' ? (state.fieldErrors ?? {}) : {};

  return (
    <Panel title={title} description={description}>
      <form action={formAction} className={shell.form} noValidate>
        <input type="hidden" name="card" value={card} />
        {children(errors)}
        <div className={shell.foot}>
          <div className={shell.status}>
            <FormStatus state={state} pending={pending} />
          </div>
          <Button type="submit" disabled={!dirty || pending}>
            Save
          </Button>
        </div>
      </form>
    </Panel>
  );
}

/**
 * The Company profile screen: five cards and the live letterhead preview. Every card edits its own
 * draft; only the fields a person has touched are held here, so saving one card never discards what
 * is half typed in another. The preview reads all drafts.
 */
export function CompanyEditor({ settings, action }: { settings: CompanySettings; action: Action }) {
  const base = draftsFromSettings(settings);
  const [edits, setEdits] = useState<Partial<CompanyDrafts>>({});
  const draft: CompanyDrafts = {
    identity: edits.identity ?? base.identity,
    address: edits.address ?? base.address,
    contact: edits.contact ?? base.contact,
    logo: edits.logo === undefined ? base.logo : edits.logo,
    signatory: edits.signatory ?? base.signatory,
  };

  const edit = <K extends keyof CompanyDrafts>(card: K, value: CompanyDrafts[K]) =>
    setEdits((current) => ({ ...current, [card]: value }));
  const clear = useCallback(
    (card: keyof CompanyDrafts) =>
      setEdits((current) => {
        if (!(card in current)) return current;
        const next = { ...current };
        delete next[card];
        return next;
      }),
    [],
  );
  const dirty = (card: Exclude<keyof CompanyDrafts, 'logo'>) =>
    edits[card] !== undefined && !sameDraft(edits[card], base[card]);

  const identity = draft.identity;
  const address = draft.address;
  const contact = draft.contact;
  const signatory = draft.signatory;
  const phoneRows = contact.phones.length === 0 ? [''] : contact.phones;
  const setContact = (patch: Partial<typeof contact>) => edit('contact', { ...contact, ...patch });

  return (
    <div className={styles.layout}>
      <div className={styles.cards}>
        <CardForm
          card="identity"
          title="Identity"
          action={action}
          dirty={dirty('identity')}
          onSaved={() => clear('identity')}
        >
          {(errors) => (
            <div className={shell.fields}>
              <Field
                label="Display name"
                hint="The name printed on your documents."
                error={errors['displayName']}
              >
                {(control) => (
                  <Input
                    name="displayName"
                    autoComplete="organization"
                    value={identity.displayName}
                    onChange={(e) => edit('identity', { ...identity, displayName: e.target.value })}
                    {...control}
                  />
                )}
              </Field>
              <Field
                label="PAN or VAT number"
                hint="5 to 20 letters, digits or hyphens."
                error={errors['panVatNo']}
              >
                {(control) => (
                  <Input
                    name="panVatNo"
                    autoComplete="off"
                    value={identity.panVatNo}
                    onChange={(e) => edit('identity', { ...identity, panVatNo: e.target.value })}
                    {...control}
                  />
                )}
              </Field>
            </div>
          )}
        </CardForm>

        <CardForm
          card="address"
          title="Address"
          description={settings.address === null ? ADDRESS_HELP : undefined}
          action={action}
          dirty={dirty('address')}
          onSaved={() => clear('address')}
        >
          {(errors) => (
            <div className={shell.fields}>
              <div className={shell.wide}>
                <Field label="Address line 1" error={errors['line1']}>
                  {(control) => (
                    <Input
                      name="line1"
                      autoComplete="address-line1"
                      value={address.line1}
                      onChange={(e) => edit('address', { ...address, line1: e.target.value })}
                      {...control}
                    />
                  )}
                </Field>
              </div>
              <div className={shell.wide}>
                <Field label="Address line 2 (optional)" error={errors['line2']}>
                  {(control) => (
                    <Input
                      name="line2"
                      autoComplete="address-line2"
                      value={address.line2}
                      onChange={(e) => edit('address', { ...address, line2: e.target.value })}
                      {...control}
                    />
                  )}
                </Field>
              </div>
              <Field label="City" error={errors['city']}>
                {(control) => (
                  <Input
                    name="city"
                    autoComplete="address-level2"
                    value={address.city}
                    onChange={(e) => edit('address', { ...address, city: e.target.value })}
                    {...control}
                  />
                )}
              </Field>
              <Field label="District (optional)" error={errors['district']}>
                {(control) => (
                  <Input
                    name="district"
                    value={address.district}
                    onChange={(e) => edit('address', { ...address, district: e.target.value })}
                    {...control}
                  />
                )}
              </Field>
              <Field label="Province (optional)" error={errors['province']}>
                {(control) => (
                  <Input
                    name="province"
                    autoComplete="address-level1"
                    value={address.province}
                    onChange={(e) => edit('address', { ...address, province: e.target.value })}
                    {...control}
                  />
                )}
              </Field>
              <Field label="Postal code (optional)" error={errors['postalCode']}>
                {(control) => (
                  <Input
                    name="postalCode"
                    autoComplete="postal-code"
                    value={address.postalCode}
                    onChange={(e) => edit('address', { ...address, postalCode: e.target.value })}
                    {...control}
                  />
                )}
              </Field>
              <Field label="Country" error={errors['country']}>
                {(control) => (
                  <Select
                    name="country"
                    autoComplete="country"
                    value={address.country}
                    onChange={(e) => edit('address', { ...address, country: e.target.value })}
                    {...control}
                  >
                    {countryOptions(address.country).map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          )}
        </CardForm>

        <CardForm
          card="contact"
          title="Contact"
          description="Where customers reach you. Printed under the address."
          action={action}
          dirty={dirty('contact')}
          onSaved={() => clear('contact')}
        >
          {(errors) => (
            <>
              <fieldset className={styles.phones}>
                <legend className={styles.legend}>Phone numbers</legend>
                {phoneRows.map((phone, index) => (
                  <div key={index} className={styles.phoneRow}>
                    <Input
                      name="phone"
                      type="tel"
                      autoComplete="tel"
                      aria-label={`Phone number ${index + 1}`}
                      value={phone}
                      onChange={(e) =>
                        setContact({ phones: setPhone(phoneRows, index, e.target.value) })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="small"
                      aria-label={`Remove phone number ${index + 1}`}
                      onClick={() => setContact({ phones: removePhone(phoneRows, index) })}
                    >
                      <Icon name="x" size={16} />
                    </Button>
                  </div>
                ))}
                {errors['phones'] ? (
                  <span className={styles.error} role="alert">
                    {errors['phones']}
                  </span>
                ) : null}
                <Button
                  variant="secondary"
                  size="small"
                  className={styles.addPhone}
                  disabled={!canAddPhone(phoneRows)}
                  onClick={() => setContact({ phones: addPhone(phoneRows) })}
                >
                  Add phone number
                </Button>
                <span className={styles.help}>Up to {MAX_PHONES} numbers.</span>
              </fieldset>
              <div className={shell.fields}>
                <Field label="Email" error={errors['email']}>
                  {(control) => (
                    <Input
                      name="email"
                      type="email"
                      autoComplete="off"
                      value={contact.email}
                      onChange={(e) => setContact({ email: e.target.value })}
                      {...control}
                    />
                  )}
                </Field>
                <Field label="Website" error={errors['website']}>
                  {(control) => (
                    <Input
                      name="website"
                      inputMode="url"
                      autoComplete="off"
                      value={contact.website}
                      onChange={(e) => setContact({ website: e.target.value })}
                      {...control}
                    />
                  )}
                </Field>
              </div>
            </>
          )}
        </CardForm>

        <LogoCard
          draft={draft.logo}
          onDraft={(next) => (next === undefined ? clear('logo') : edit('logo', next))}
          action={action}
        />

        <CardForm
          card="signatory"
          title="Authorised signatory"
          description="The name and title printed at the signature line."
          action={action}
          dirty={dirty('signatory')}
          onSaved={() => clear('signatory')}
        >
          {(errors) => (
            <div className={shell.fields}>
              <Field label="Name" error={errors['name']}>
                {(control) => (
                  <Input
                    name="name"
                    autoComplete="off"
                    value={signatory.name}
                    onChange={(e) => edit('signatory', { ...signatory, name: e.target.value })}
                    {...control}
                  />
                )}
              </Field>
              <Field label="Title" error={errors['title']}>
                {(control) => (
                  <Input
                    name="title"
                    autoComplete="off"
                    value={signatory.title}
                    onChange={(e) => edit('signatory', { ...signatory, title: e.target.value })}
                    {...control}
                  />
                )}
              </Field>
            </div>
          )}
        </CardForm>
      </div>

      <LetterheadPreview
        model={{
          logo: draft.logo,
          displayName: identity.displayName,
          address,
          phones: contact.phones,
          email: contact.email,
          website: contact.website,
          panVatNo: identity.panVatNo,
        }}
      />
    </div>
  );
}
