'use client';

import {
  DEFAULT_COUNTRY,
  MAX_PARTY_PHONES,
  type CountryCode,
  type PartyPhoneInput,
} from '@bos/contracts';
import type { Currency } from '@bos/locale';
import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

import type { ContactLoader } from '@/app/(app)/leads/_lib/customer-contacts';
import type { CompanySearcher } from '@/app/(app)/leads/_lib/use-company-search';
import styles from '@/app/(app)/leads/leads.module.css';
import { AddressFields } from '@/components/ui/address-fields';
import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { MemberPicker } from '@/components/ui/member-picker';
import { MoneyInput, PercentInput } from '@/components/ui/number-input';
import { PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { PhoneListInput, type PhoneRowProblem } from '@/components/ui/phone-list-input';
import { toast } from '@/components/ui/toast';
import { currencyChoices } from '@/lib/enabled-currencies';

import { ActivityTypeButtons } from './activity-type-buttons';
import { EMAIL_OR_PHONE, SCHEDULE_ACTIVITY_KINDS } from './forms';
import { CompanyField, ContactField } from './lead-party-fields';
import type { FormAction, FormState } from './types';

type FollowUpKind = (typeof SCHEDULE_ACTIVITY_KINDS)[number];

/** A person who may own the lead (or do its follow-up), from `GET /v1/leads/owners`. */
export interface OwnerOption {
  value: string;
  label: string;
  /** Job title and department, muted after the name in the picker (BOS-UI-001). */
  role?: string | null | undefined;
}

const EMPTY: Record<string, string> = {
  title: '',
  source: '',
  campaign: '',
  companyName: '',
  contactName: '',
  email: '',
  // The optional address (D9); its country is the lead's country, held in its own state.
  addressLine: '',
  addressCity: '',
  requirement: '',
  expectedValue: '',
  currency: 'NPR',
  probability: '',
  expectedClose: '',
  notes: '',
  ownerUserId: '',
  followUpAt: '',
  followUpSubject: '',
  // Empty means "the lead owner": the assignee follows the owner until someone picks another.
  followUpAssigneeUserId: '',
};

/**
 * Card heading with the eyebrow Figma shows above it (D47): only the cards Figma gives one carry one ("01 · The
 * basics", "02 · The story"). The eyebrow is decoration.
 */
function SectionTitle({ eyebrow, children }: { eyebrow: string; children: ReactNode }) {
  return (
    <>
      <span className={styles.eyebrow} aria-hidden="true">
        {eyebrow}
      </span>
      {children}
    </>
  );
}

const memberPeople = (owners: readonly OwnerOption[]) =>
  owners.map((o) => ({ id: o.value, name: o.label, role: o.role ?? null }));

/** What the owner field says under itself: where a defaulted person comes from, never in place of their name. */
function ownerHint(
  count: number,
  source: 'settings' | 'sales_head' | undefined,
  chosen: string,
  defaultId: string | undefined,
  callerUnplaced: boolean,
): string | undefined {
  // Nothing chosen and the box shows the default person: the API gives the lead to them.
  if (source !== undefined && chosen === '' && defaultId !== undefined) {
    return source === 'settings'
      ? 'Default owner from Settings.'
      : 'Default owner: the Sales head.';
  }
  if (chosen === '' && defaultId === undefined && callerUnplaced) {
    return 'No default owner is set and you cannot own this lead, so choose who it goes to.';
  }
  return count === 1 ? 'You can create leads for yourself only.' : undefined;
}

/** The fields the API always needs; the email-or-phone check waits for them (see `checkBeforeSave`). */
const REQUIRED = ['title', 'source', 'companyName', 'contactName'] as const;

/** The primary of a saved list (the first when none is marked), or null for none. */
function primaryOf(phones: readonly PartyPhoneInput[] | undefined): string | null {
  return (phones?.find((phone) => phone.isPrimary) ?? phones?.[0])?.e164 ?? null;
}

/** The new-lead form. Inputs are controlled so a refusal does not wipe what was typed. */
export function LeadForm({
  action,
  sources,
  owners,
  enabledCurrencies,
  defaultOwnerId,
  defaultOwnerSource,
  callerUnplaced = false,
  idempotencyKey,
  onPrimaryPhoneChange,
  defaultPhones,
  defaultCountry,
  phonesKey,
  companySearch,
  companySearchDelayMs,
  loadContacts,
  onOpenLead,
}: {
  action: FormAction;
  sources: { value: string; label: string }[];
  /** The company's switched-on currencies (`currency.enabled`), read once by the page. */
  enabledCurrencies: readonly string[];
  /** Who the lead can go to. Empty when the list did not load: the API then makes it the caller's. */
  owners: readonly OwnerOption[];
  /**
   * Who the owner box starts on, by their real name and role: the signed-in user when they are in `owners`, else the
   * person an ownerless lead would go to (the Default lead owner from Settings, or the Sales head). Undefined when
   * there is no such person: the box then starts empty and says so.
   */
  defaultOwnerId?: string | undefined;
  /**
   * Where `defaultOwnerId` comes from when it is not the signed-in user (Finance, Accountant or PMO entering a lead for
   * Sales): the entity's Default lead owner in Settings, or the Sales head when none is set. Said under the field.
   */
  defaultOwnerSource?: 'settings' | 'sales_head' | undefined;
  /**
   * The signed-in user is known and may not own a lead they start (Finance, Accountant or PMO). False when who they
   * are did not load: the API then makes the lead theirs, so nothing is said about a missing default.
   */
  callerUnplaced?: boolean | undefined;
  /** Made once per page render on the server; the action hands back the key the next try uses. */
  idempotencyKey: string;
  /**
   * The primary number as E.164 once it is complete and valid, else null: told once with the
   * starting number and again whenever it changes. The page hands it to the duplicate hint.
   */
  onPrimaryPhoneChange?: ((e164: string | null) => void) | undefined;
  /** The saved numbers an edit starts with; a new lead starts with one blank Nepal row. */
  defaultPhones?: readonly PartyPhoneInput[] | undefined;
  /** The saved country an edit starts with; a new lead starts in Nepal. */
  defaultCountry?: CountryCode | undefined;
  /** Changes when the saved record changes (its version), so the phone list starts again from `defaultPhones`. */
  phonesKey?: string | number | undefined;
  /**
   * Where the Company field's suggestions come from (BOS-UI-002): the customers and open leads the user may read.
   * Without it the field is a plain input with only Create "<text>".
   */
  companySearch?: CompanySearcher | undefined;
  companySearchDelayMs?: number | undefined;
  /** The contacts of a linked customer, for the Contact person field. */
  loadContacts?: ContactLoader | undefined;
  /** Opens a lead picked from the Company field's "Already a lead" group. */
  onOpenLead?: ((leadId: string) => void) | undefined;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {
    values: EMPTY,
    fieldErrors: {},
  });
  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...EMPTY,
    // Never preselect someone else: when the signed-in user is not placed in the list, the empty
    // choice posts nothing and the API picks the owner (the default lead owner for a role that enters
    // leads for Sales, the caller otherwise).
    // A defaulted owner (Settings or the Sales head) stays empty: the box shows that person and the form posts
    // nothing, so the API applies the default as it does today.
    ownerUserId:
      defaultOwnerSource !== undefined
        ? ''
        : (defaultOwnerId ?? (owners.length === 1 ? (owners[0]?.value ?? '') : '')),
  }));
  const [followUpKind, setFollowUpKind] = useState<FollowUpKind>('call');
  const [country, setCountry] = useState<CountryCode>(defaultCountry ?? DEFAULT_COUNTRY);
  // BOS-UI-002: the customer (and contact) picked from the Company and Contact person fields, if any. Free text
  // when null, exactly as before; picking links, editing the text unlinks.
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  // A lead picked from "Already a lead" leaves this page: when other fields hold typed data, ask first.
  const [leaveFor, setLeaveFor] = useState<string | null>(null);
  // The complete, valid numbers as the list last reported them, and its primary. They are also what
  // the list restores when React resets the form after a refused save, so the typed numbers stay.
  const startPhones = (key: typeof phonesKey) => ({
    key,
    saved: defaultPhones ?? [],
    primary: primaryOf(defaultPhones),
    problems: [] as PhoneRowProblem[],
  });
  const [phones, setPhones] = useState(() => startPhones(phonesKey));
  if (phones.key !== phonesKey) setPhones(startPhones(phonesKey));
  // Refusals found before the action runs; cleared as soon as the field they name changes.
  const [clientErrors, setClientErrors] = useState<Partial<Record<string, string>>>({});
  const summary = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  function update(name: string, value: string) {
    setValues((values) => ({ ...values, [name]: value }));
    if (name === 'email') setClientErrors({});
  }
  const set = (name: string) => (e: { target: { value: string } }) => update(name, e.target.value);
  const formId = useId();
  const err = { ...state.fieldErrors, ...clientErrors };
  // Typed work that leaving would lose. The company text is the search itself and the defaults (currency, owner,
  // the follow-up type buttons) are not typed work, so none of them count.
  const hasTypedData =
    Object.entries(values).some(
      ([name, value]) =>
        !['companyName', 'currency', 'ownerUserId'].includes(name) && value.trim() !== '',
    ) ||
    phones.saved.length > 0 ||
    customerId !== null;
  const assignee = values['followUpAssigneeUserId'] || values['ownerUserId'] || '';
  // The chosen value stays listed even if it is not in the enabled list, so the select never blanks.
  const currencies = currencyChoices(enabledCurrencies, values['currency']);

  useEffect(() => {
    if (state.error) summary.current?.focus();
    else {
      const first = Object.keys(state.fieldErrors)[0];
      if (first) {
        const control = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
        const firstSegment = control?.querySelector<HTMLElement>('[role="spinbutton"]');
        (firstSegment ?? control)?.focus();
        toast.error('Check the highlighted fields.');
      }
    }
  }, [state]);

  // The primary number goes to the page (the duplicate hint): the starting one, then each change.
  const primaryPhone = phones.primary;
  const reportPrimary = useRef(onPrimaryPhoneChange);
  useEffect(() => {
    reportPrimary.current = onPrimaryPhoneChange;
  });
  useEffect(() => {
    reportPrimary.current?.(primaryPhone);
  }, [primaryPhone]);

  // Stopped here, before the action runs; focus stays on a phone box that has already stopped the
  // submit itself. A phone row the list says must not be saved (a number listed twice) keeps its
  // reason under the row. A lead also needs a way to reach the person: the reason goes under the
  // email. While another required field is empty that save goes on, so the server names every
  // missing field at once, this one included.
  function checkBeforeSave(event: FormEvent<HTMLFormElement>) {
    const stopped = event.defaultPrevented;
    const problem = phones.problems[0];
    if (problem !== undefined) {
      event.preventDefault();
      if (!stopped) {
        form.current
          ?.querySelector<HTMLInputElement>(`input[aria-label="Phone ${problem.index + 1} number"]`)
          ?.focus();
      }
      return;
    }
    if ((values['email'] ?? '').trim() !== '' || phones.saved.length > 0) return;
    if (REQUIRED.some((name) => (values[name] ?? '').trim() === '')) return;
    event.preventDefault();
    setClientErrors({ email: EMAIL_OR_PHONE });
    if (!stopped) form.current?.querySelector<HTMLInputElement>('input[name="email"]')?.focus();
  }

  return (
    <>
      <PageHeader
        title="Create Lead"
        description="Record an enquiry, its contact details and the next follow-up."
        actions={
          <>
            <LinkButton href="/leads" variant="secondary">
              Cancel
            </LinkButton>
            <Button type="submit" form={formId} disabled={pending} aria-busy={pending || undefined}>
              {pending ? 'Creating' : 'Create lead'}
            </Button>
          </>
        }
      />
      <form
        id={formId}
        ref={form}
        action={formAction}
        onSubmit={checkBeforeSave}
        noValidate
        className={styles.form}
        aria-busy={pending || undefined}
      >
        <input type="hidden" name="idempotencyKey" value={state.key ?? idempotencyKey} />

        {state.error ? (
          <Alert ref={summary} tabIndex={-1} tone="error" role="alert">
            {state.error}
          </Alert>
        ) : null}

        <Panel title={<SectionTitle eyebrow="01 · The basics">Lead overview</SectionTitle>}>
          <Field label="Lead title" error={err['title']}>
            {(c) => (
              <Input
                name="title"
                placeholder="e.g. Inventory and dispatch automation"
                value={values['title']}
                onChange={set('title')}
                maxLength={200}
                required
                {...c}
              />
            )}
          </Field>

          <div className={styles.formGrid}>
            <Field label="Lead source" error={err['source']}>
              {(c) => (
                <Select
                  name="source"
                  value={values['source']}
                  onChange={set('source')}
                  required
                  {...c}
                >
                  <option value="">Choose a source</option>
                  {sources.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Campaign" hint="Optional." error={err['campaign']}>
              {(c) => (
                <Input
                  name="campaign"
                  value={values['campaign']}
                  onChange={set('campaign')}
                  maxLength={100}
                  {...c}
                />
              )}
            </Field>
            {owners.length > 0 ? (
              <Field
                label="Lead owner"
                hint={ownerHint(
                  owners.length,
                  defaultOwnerSource,
                  values['ownerUserId'] ?? '',
                  defaultOwnerId,
                  callerUnplaced,
                )}
                error={err['ownerUserId']}
              >
                {(c) => (
                  <MemberPicker
                    labelledBy={c['aria-labelledby']}
                    describedBy={c['aria-describedby']}
                    invalid={c['aria-invalid'] === true}
                    name="ownerUserId"
                    people={memberPeople(owners)}
                    value={values['ownerUserId'] ?? ''}
                    onChange={(value) => update('ownerUserId', value)}
                    emptyStandsFor={defaultOwnerSource !== undefined ? defaultOwnerId : undefined}
                    placeholder="Search by name"
                  />
                )}
              </Field>
            ) : (
              <Field
                label="Lead owner"
                hint="The list of owners did not load, so the lead will be yours."
                error={err['ownerUserId']}
              >
                {(c) => <Input value="You" readOnly {...c} />}
              </Field>
            )}
          </div>
        </Panel>

        <Panel title="Prospect and company">
          <div className={styles.formGrid}>
            <Field label="Company or organization" error={err['companyName']}>
              {(c) => (
                <CompanyField
                  control={c}
                  text={values['companyName'] ?? ''}
                  onTextChange={(text) => update('companyName', text)}
                  linkedCustomerId={customerId}
                  onPick={(customer) => {
                    update('companyName', customer.name);
                    if (customer.country !== null) setCountry(customer.country);
                    setCustomerId(customer.id);
                    setContactId(null);
                  }}
                  onUnlink={() => {
                    setCustomerId(null);
                    setContactId(null);
                  }}
                  search={companySearch}
                  delayMs={companySearchDelayMs}
                  onOpenLead={
                    onOpenLead === undefined
                      ? undefined
                      : (leadId) => (hasTypedData ? setLeaveFor(leadId) : onOpenLead(leadId))
                  }
                />
              )}
            </Field>
            <Field label="Contact person" error={err['contactName']}>
              {(c) => (
                <ContactField
                  control={c}
                  text={values['contactName'] ?? ''}
                  onTextChange={(text) => update('contactName', text)}
                  customerId={customerId}
                  linkedContactId={contactId}
                  onPick={(contact) => {
                    update('contactName', contact.name);
                    setContactId(contact.id);
                  }}
                  onUnlink={() => setContactId(null)}
                  loadContacts={loadContacts}
                />
              )}
            </Field>
            <Field label="Email" hint="Optional." error={err['email']}>
              {(c) => (
                <Input
                  name="email"
                  type="email"
                  autoComplete="off"
                  value={values['email']}
                  onChange={set('email')}
                  {...c}
                />
              )}
            </Field>
          </div>

          {/* The lead's Country is the address's country, so the two sit together; the address itself is optional. */}
          <AddressFields
            name="address"
            value={{
              line: values['addressLine'] ?? '',
              city: values['addressCity'] ?? '',
              country,
            }}
            onChange={(next) => {
              update('addressLine', next.line);
              update('addressCity', next.city);
              setCountry(next.country);
            }}
            errors={{
              line: err['address.line'],
              city: err['address.city'],
              country: err['country'],
            }}
          />

          <Field label="Phone" hint="Optional. Pick each number's country, or type its code.">
            {(c) => (
              <PhoneListInput
                key={phonesKey}
                name="phones"
                aria-labelledby={c['aria-labelledby']}
                aria-describedby={c['aria-describedby']}
                defaultCountry={country}
                defaultValue={phones.saved}
                rowErrors={Array.from(
                  { length: MAX_PARTY_PHONES },
                  (_, row) => err[`phones.${row}`],
                )}
                error={err['phones']}
                onChange={(saved) => {
                  setPhones((current) => ({ ...current, saved }));
                  if (saved.length > 0) setClientErrors({});
                }}
                onPrimaryChange={(primary) => setPhones((current) => ({ ...current, primary }))}
                onValidityChange={(problems) => setPhones((current) => ({ ...current, problems }))}
              />
            )}
          </Field>

          <Field
            label="Requirement"
            hint="What they asked for. Optional."
            error={err['requirement']}
          >
            {(c) => (
              <Textarea
                name="requirement"
                rows={3}
                value={values['requirement']}
                onChange={set('requirement')}
                maxLength={5000}
                {...c}
              />
            )}
          </Field>
        </Panel>

        <Panel title={<SectionTitle eyebrow="02 · The story">Commercial details</SectionTitle>}>
          <div className={styles.formGrid}>
            <Field label="Currency" error={err['currency']}>
              {(c) => (
                <Select
                  name="currency"
                  value={values['currency']}
                  onChange={set('currency')}
                  {...c}
                >
                  {currencies.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Expected value"
              hint="Optional. For example 12,50,000."
              error={err['expectedValue']}
            >
              {(c) => (
                <MoneyInput
                  name="expectedValue"
                  currency={values['currency'] as Currency}
                  value={values['expectedValue']}
                  onValueChange={(value) => update('expectedValue', value)}
                  {...c}
                />
              )}
            </Field>
            <Field label="Probability (%)" hint="Optional. 0 to 100." error={err['probability']}>
              {(c) => (
                <PercentInput
                  name="probability"
                  scale={0}
                  value={values['probability']}
                  onValueChange={(value) => update('probability', value)}
                  {...c}
                />
              )}
            </Field>
            <Field label="Expected close" hint="Optional." error={err['expectedClose']}>
              {(c) => (
                <DatePicker
                  name="expectedClose"
                  value={values['expectedClose']}
                  onChange={(value) => update('expectedClose', value)}
                  {...c}
                />
              )}
            </Field>
          </div>

          <Field label="Notes" hint="Optional." error={err['notes']}>
            {(c) => (
              <Textarea
                name="notes"
                rows={3}
                value={values['notes']}
                onChange={set('notes')}
                maxLength={5000}
                {...c}
              />
            )}
          </Field>
        </Panel>

        <Panel
          title="Schedule a follow-up"
          description="Optional. Leave the time empty to skip it; you can plan one from the lead later."
        >
          <ActivityTypeButtons
            kinds={SCHEDULE_ACTIVITY_KINDS}
            value={followUpKind}
            onChange={setFollowUpKind}
            name="followUpKind"
            label="Type"
            {...(err['followUpKind'] ? { error: err['followUpKind'] } : {})}
          />
          <div className={styles.formGrid}>
            <Field label="When" hint="Kathmandu time." error={err['followUpAt']}>
              {(c) => (
                <Input
                  name="followUpAt"
                  type="datetime-local"
                  value={values['followUpAt']}
                  onChange={set('followUpAt')}
                  {...c}
                />
              )}
            </Field>
            {owners.length > 0 ? (
              <Field
                label="Assignee"
                hint="Starts as the lead owner."
                error={err['followUpAssigneeUserId']}
              >
                {(c) => (
                  <MemberPicker
                    labelledBy={c['aria-labelledby']}
                    describedBy={c['aria-describedby']}
                    invalid={c['aria-invalid'] === true}
                    name="followUpAssigneeUserId"
                    people={memberPeople(owners)}
                    value={assignee}
                    onChange={(value) => update('followUpAssigneeUserId', value)}
                    emptyStandsFor={defaultOwnerSource !== undefined ? defaultOwnerId : undefined}
                    placeholder="The lead owner"
                  />
                )}
              </Field>
            ) : null}
          </div>
          <Field
            label="Subject"
            hint="Optional. Without one it is named after the type, for example “Call”."
            error={err['followUpSubject']}
          >
            {(c) => (
              <Input
                name="followUpSubject"
                placeholder="e.g. Walk through the proposal"
                value={values['followUpSubject']}
                onChange={set('followUpSubject')}
                maxLength={200}
                {...c}
              />
            )}
          </Field>
        </Panel>
      </form>
      <ConfirmDialog
        open={leaveFor !== null}
        onOpenChange={(next) => {
          if (!next) setLeaveFor(null);
        }}
        title="Leave this form?"
        description="What you typed here is not saved. Open the lead and discard it, or stay and keep editing."
        confirmLabel="Discard and open lead"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          if (leaveFor !== null) onOpenLead?.(leaveFor);
        }}
      />
    </>
  );
}
