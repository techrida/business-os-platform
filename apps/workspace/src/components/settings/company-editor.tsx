'use client';

import {
  useActionState,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import shell from '@/app/(app)/settings/_components/settings.module.css';
import { IDLE, type ActionState } from '@/app/(app)/settings/action-state';
import { FormStatus } from '@/app/(app)/settings/form-status';
import { AddressFields } from '@/components/ui/address-fields';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { PanInput } from '@/components/ui/pan-input';
import { Panel } from '@/components/ui/panel';
import { PhoneListInput } from '@/components/ui/phone-list-input';

import {
  companyLogo,
  draftsFromSettings,
  isCardEmpty,
  logoSource,
  phoneListDefault,
  profilePhones,
  sameDraft,
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

/** The server's error for each phone row (`phones.<row>`), by row position, for the phone list. */
const phoneRowErrors = (errors: FieldErrors): (string | undefined)[] =>
  Array.from({ length: 20 }, (_, row) => errors[`phones.${row}`]);

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
  // How many rows the phone list would not save (typed but not a valid number, or listed twice). It belongs to the
  // list of one profile version: a list remounted for a newer version starts with none.
  const phonesLegendId = useId();
  const phoneListKey = `phones-${versionFieldValue(versions['entity.profile'])}`;
  const [phoneCheck, setPhoneCheck] = useState({ list: phoneListKey, problems: 0 });
  const phoneProblems = phoneCheck.list === phoneListKey ? phoneCheck.problems : 0;
  const dirty = (card: keyof CompanyDrafts) =>
    edits[card] !== undefined && !sameDraft(edits[card], base[card]);

  const logo = companyLogo(settings.profile);
  const identity = draft.identity;
  const address = draft.address;
  const contact = draft.contact;
  const signatory = draft.signatory;
  const tooManyPhones = contact.phones.length > MAX_PHONES;
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
            <AddressFields
              name="address"
              required
              value={address}
              onChange={(next) => edit('address', next)}
              errors={{ line: errors['line'], city: errors['city'], country: errors['country'] }}
            />
          )}
        </CardForm>

        <CardForm
          card="contact"
          title="Contact"
          description="Where customers reach you. Printed under the address."
          actions={undo('contact')}
          action={action}
          versions={versions}
          dirty={dirty('contact') && phoneProblems === 0 && !tooManyPhones}
          onSaved={() => clear('contact')}
        >
          {(errors) => (
            <>
              <fieldset className={styles.phones}>
                <legend id={phonesLegendId} className={styles.legend}>
                  Phone numbers
                </legend>
                {/* Not fully controlled: it opens with the draft (which a form reset after a refused save restores)
                    and starts over when a save or reset brings a new profile version. */}
                <PhoneListInput
                  key={phoneListKey}
                  name="phones"
                  aria-labelledby={phonesLegendId}
                  defaultValue={phoneListDefault(contact.phones)}
                  onChange={(phones) => setContact({ phones: profilePhones(phones) })}
                  onValidityChange={(problems) =>
                    setPhoneCheck({ list: phoneListKey, problems: problems.length })
                  }
                  rowErrors={phoneRowErrors(errors)}
                  error={
                    tooManyPhones
                      ? `The documents print up to ${MAX_PHONES} numbers. Remove one to save.`
                      : errors['phones']
                  }
                />
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
          phones: contact.phones.map((phone) => phone.e164),
          email: contact.email,
          website: contact.website,
          panVatNo: identity.panVatNo,
        }}
      />
    </div>
  );
}
