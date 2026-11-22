'use client';

import { useActionState, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import shell from '@/app/(app)/settings/_components/settings.module.css';
import { IDLE, type ActionState } from '@/app/(app)/settings/action-state';
import { FormStatus } from '@/app/(app)/settings/form-status';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { PanInput } from '@/components/ui/pan-input';
import { PhoneInput } from '@/components/ui/phone-input';
import { Panel } from '@/components/ui/panel';

import {
  addPhone,
  canAddPhone,
  companyLogo,
  countryOptions,
  draftsFromSettings,
  isCardEmpty,
  logoSource,
  removePhone,
  sameDraft,
  setPhone,
  versionFieldName,
  versionFieldValue,
  CARD_WRITES,
  MAX_PHONES,
  RESET_KEY,
  type CompanyCard,
  type CompanyDrafts,
  type CompanyKey,
  type CompanySettings,
  type CompanyVersions,
  type FieldErrors,
  type ResettableCard,
} from './company-profile';
import styles from './company-editor.module.css';
import { isStaleState, StaleNotice, useStaleVersion } from './format-card-foot';
import { LetterheadPreview } from './letterhead-preview';
import { LogoCard } from './logo-card';
import { ResetToDefaultButton, type ResetConfirm } from './reset-to-default';

type Action = (previous: ActionState, formData: FormData) => Promise<ActionState>;
type ResetCard = (card: ResettableCard, expectedVersion: number | null) => Promise<ActionState>;

const UNDO: Record<ResettableCard, { label: string; confirm: ResetConfirm }> = {
  address: {
    label: 'Address',
    confirm: {
      title: 'Clear the address?',
      body: 'The address is removed from the company profile. Quotations and invoices cannot be made into PDFs until an address is saved again.',
      confirmLabel: 'Clear address',
    },
  },
  contact: {
    label: 'Contact details',
    confirm: {
      title: 'Clear the contact details?',
      body: 'The phone numbers, email and website are removed from the company profile. The logo, name and signatory stay.',
      confirmLabel: 'Clear contact details',
    },
  },
  signatory: {
    label: 'Authorised signatory',
    confirm: {
      title: 'Clear the authorised signatory?',
      body: 'The name and title are removed from the signature line. The logo, name and contact details stay.',
      confirmLabel: 'Clear signatory',
    },
  },
};

const ADDRESS_HELP = 'Quotations and invoices cannot be made into PDFs until an address is saved.';

/** One string for the loaded versions of every setting a card writes (`useStaleVersion` compares it). */
const loadedKey = (card: CompanyCard, version: (key: CompanyKey) => string): string =>
  CARD_WRITES[card].map(version).join('|');

/**
 * One card, one decision, one Save. Dirty means "the draft differs from what is saved": Save is
 * disabled otherwise. A refused field keeps its input and shows its message at the field. When a
 * save goes through, `onSaved` hands the card back to the saved values. A refused save (a stale
 * one included) leaves the typed values where they are. The form carries the version the page
 * loaded for each setting the card writes, so the save can be refused when it is out of date.
 */
function CardForm({
  card,
  title,
  description,
  actions,
  action,
  versions,
  dirty,
  onSaved,
  children,
}: {
  card: CompanyCard;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  action: Action;
  versions: CompanyVersions;
  dirty: boolean;
  onSaved: () => void;
  children: (errors: FieldErrors) => ReactNode;
}) {
  // The stale notice belongs to the versions the card's form carried; it clears itself once the
  // page reloads with newer ones (as on the Formats cards).
  const loaded = loadedKey(card, (key) => versionFieldValue(versions[key]));
  const { stale, staleMessage, markStale, clearStale } = useStaleVersion(loaded);
  const [state, formAction, pending] = useActionState(
    async (previous: ActionState, formData: FormData): Promise<ActionState> => {
      const result = await action(previous, formData);
      if (isStaleState(result)) {
        const sent = loadedKey(card, (key) => {
          const value = formData.get(versionFieldName(key));
          return typeof value === 'string' ? value : '';
        });
        markStale(sent, result.message);
      } else if (result.status === 'ok') clearStale();
      return result;
    },
    IDLE,
  );
  const saved = useRef(onSaved);
  useEffect(() => {
    saved.current = onSaved;
  });
  useEffect(() => {
    if (state.status === 'ok') saved.current();
  }, [state]);
  const errors: FieldErrors = state.status === 'error' ? (state.fieldErrors ?? {}) : {};

  return (
    <Panel title={title} description={description} actions={actions}>
      <form action={formAction} className={shell.form} noValidate>
        <input type="hidden" name="card" value={card} />
        {CARD_WRITES[card].map((key) => (
          <input
            key={key}
            type="hidden"
            name={versionFieldName(key)}
            value={versionFieldValue(versions[key])}
          />
        ))}
        {children(errors)}
        {stale ? <StaleNotice message={staleMessage} /> : null}
        <div className={shell.foot}>
          <div className={shell.status}>
            <FormStatus state={state} pending={pending} inline={!isStaleState(state)} />
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
 * The Company profile screen: five cards and the live letterhead preview. Every card but the logo
 * edits its own draft; only the fields a person has touched are held here, so saving one card never
 * discards what is half typed in another. The logo uploads at once and the page refreshes. The
 * preview reads all drafts and the saved logo.
 */
export function CompanyEditor({
  organisationId,
  settings,
  versions,
  action,
  resetCard,
}: {
  /** The signed-in organisation: the owner of the logo picture. */
  organisationId: string;
  settings: CompanySettings;
  /** The version of each setting as the page loaded it. Every save sends it back. */
  versions: CompanyVersions;
  action: Action;
  /** The undo icon's Server Action: one card back to empty, guarded by the loaded version. */
  resetCard: ResetCard;
}) {
  const base = draftsFromSettings(settings);
  const [edits, setEdits] = useState<Partial<CompanyDrafts>>({});
  const draft: CompanyDrafts = {
    identity: edits.identity ?? base.identity,
    address: edits.address ?? base.address,
    contact: edits.contact ?? base.contact,
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
  // The phone rows are keyed by position; a removal bumps this so the rows below it do not inherit the removed row's box.
  const [phoneGeneration, setPhoneGeneration] = useState(0);
  const dirty = (card: keyof CompanyDrafts) =>
    edits[card] !== undefined && !sameDraft(edits[card], base[card]);

  const logo = companyLogo(settings.profile);
  const identity = draft.identity;
  const address = draft.address;
  const contact = draft.contact;
  const signatory = draft.signatory;
  const phoneRows = contact.phones.length === 0 ? [''] : contact.phones;
  const setContact = (patch: Partial<typeof contact>) => edit('contact', { ...contact, ...patch });

  // The undo icon is drawn only while what is SAVED for the card differs from empty. A reset that
  // goes through also drops the card's unsaved draft, so the inputs show the empty values.
  const undo = (card: ResettableCard) => (
    <ResetToDefaultButton
      section="company"
      settingKey={RESET_KEY[card]}
      label={UNDO[card].label}
      isDefault={isCardEmpty(card, settings)}
      defaultText="none"
      confirm={UNDO[card].confirm}
      action={async () => {
        const state = await resetCard(card, versions[RESET_KEY[card]]);
        if (state.status === 'ok') clear(card);
        return state;
      }}
    />
  );

  return (
    <div className={styles.layout}>
      <div className={styles.cards}>
        <CardForm
          card="identity"
          title="Identity"
          action={action}
          versions={versions}
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
                label="PAN number"
                hint="Your company's PAN: exactly 9 digits."
                error={errors['panVatNo']}
              >
                {(control) => (
                  <PanInput
                    name="panVatNo"
                    value={identity.panVatNo}
                    onValueChange={(panVatNo) => edit('identity', { ...identity, panVatNo })}
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
          actions={undo('address')}
          action={action}
          versions={versions}
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
          actions={undo('contact')}
          action={action}
          versions={versions}
          dirty={dirty('contact')}
          onSaved={() => clear('contact')}
        >
          {(errors) => (
            <>
              <fieldset className={styles.phones}>
                <legend className={styles.legend}>Phone numbers</legend>
                {phoneRows.map((phone, index) => (
                  <div key={`${phoneGeneration}-${index}`} className={styles.phoneRow}>
                    <PhoneInput
                      name="phone"
                      aria-label={`Phone number ${index + 1}`}
                      value={phone}
                      onValueChange={(posted) =>
                        setContact({ phones: setPhone(phoneRows, index, posted) })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="small"
                      aria-label={`Remove phone number ${index + 1}`}
                      onClick={() => {
                        setPhoneGeneration((g) => g + 1);
                        setContact({ phones: removePhone(phoneRows, index) });
                      }}
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
          organisationId={organisationId}
          name={settings.profile.displayName?.trim() || 'your company'}
          logo={logo}
        />

        <CardForm
          card="signatory"
          title="Authorised signatory"
          description="The name and title printed at the signature line."
          actions={undo('signatory')}
          action={action}
          versions={versions}
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
          logo: logoSource(logo),
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
