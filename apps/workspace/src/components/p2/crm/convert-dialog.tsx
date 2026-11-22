'use client';

import { MAX_PARTY_PHONES, type CountryCode, type PartyPhoneInput } from '@bos/contracts';
import { useActionState, useEffect, useId, useRef, useState } from 'react';

import styles from '@/app/(app)/leads/leads.module.css';
import { AddressFields } from '@/components/ui/address-fields';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CountrySelect } from '@/components/ui/country-select';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { PanInput } from '@/components/ui/pan-input';
import { PhoneListInput } from '@/components/ui/phone-list-input';

import { FactList, Panel } from '@/components/ui/panel';
import { toast } from '@/components/ui/toast';

import { loadConversionContacts, searchConversionCustomers } from './record-lookups';
import type { ConvertAction, ConvertState } from './types';

export interface ConvertLead {
  id: string;
  version: number;
  number: string;
  title: string;
  companyName: string;
  contactName: string;
  email: string;
  /** The lead person's country: the new customer and contact start in it. */
  country: CountryCode;
  /** The lead person's numbers (the DTO's `phones`, primary first): the new contact starts with them. */
  phones: readonly PartyPhoneInput[];
  requirement?: string | null;
  value?: string | null;
  probability?: number | null;
  expectedClose?: string | null;
}

function initialValues(lead: ConvertLead): Record<string, string> {
  return {
    customerMode: 'create',
    customerId: '',
    legalName: lead.companyName,
    panVatNo: '',
    line: '',
    city: '',
    country: lead.country,
    contactMode: 'create',
    contactId: '',
    contactName: lead.contactName,
    contactEmail: lead.email,
    contactCountry: lead.country,
    opportunityName: lead.title,
    createAnyway: '',
    overrideReason: '',
  };
}

/**
 * Convert a qualified lead into a customer, a contact and an opportunity. The contact is required
 * and needs an email (a new one types it; an existing one without an address cannot be chosen), so
 * the opportunity's quotations can be sent. When the server finds
 * duplicates, the dialog lists the candidates. The user can link a matching record or provide
 * a reason to create new records. Typed values survive every refusal.
 */
export function ConvertDialog({ lead, action }: { lead: ConvertLead; action: ConvertAction }) {
  const [state, formAction, pending] = useActionState<ConvertState, FormData>(action, {
    values: initialValues(lead),
    fieldErrors: {},
  });
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(lead));
  const [key, setKey] = useState('');
  const [open, setOpen] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const formId = useId();
  const err = state.fieldErrors;
  const dupes = state.duplicates ?? [];

  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState<{ id: string; label: string }[]>([]);
  const [lookupError, setLookupError] = useState('');
  const [searching, setSearching] = useState(false);
  const [contacts, setContacts] = useState<{
    customerId: string;
    options: { id: string; label: string; disabled?: boolean }[];
    error: string;
  } | null>(null);
  const customerId = values['customerId'] ?? '';
  useEffect(() => {
    if (!customerId) return;
    let active = true;
    void loadConversionContacts(customerId)
      .then((result) => {
        if (active) setContacts({ customerId, ...result });
      })
      .catch(() => {
        if (active)
          setContacts({
            customerId,
            options: [],
            error: 'Contacts could not be loaded. Try again.',
          });
      });
    return () => {
      active = false;
    };
  }, [customerId]);

  async function searchCustomers() {
    setSearching(true);
    try {
      const result = await searchConversionCustomers(query);
      setCustomers(result.options);
      setLookupError(
        !result.error && result.options.length === 0 ? 'No matching organizations.' : '',
      );
      if (result.error) toast.error(result.error);
    } catch {
      setLookupError('');
      toast.error('Organizations could not be loaded. Try again.');
    } finally {
      setSearching(false);
    }
  }

  const set = (name: string) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [name]: e.target.value }));
  // The contract also takes the tax ids of customers abroad, so only a Nepal customer gets the
  // digits-only PAN box.
  const customerCountry = (values['country'] ?? lead.country) as CountryCode;
  const contactCountry = (values['contactCountry'] ?? lead.country) as CountryCode;
  const nepalCustomer = customerCountry === 'NP';
  // The PAN edit flag lives here, above the box that remounts on a country switch, so a short value
  // the user typed is still stopped at submit when its box comes back.
  const [panEdited, setPanEdited] = useState(false);
  // The phone list is not fully controlled: React resets the form after every action, and the list
  // then starts over from `defaultValue`. Holding its saved numbers here keeps what the user typed
  // through a refusal; incomplete rows never get that far, their boxes stop the submit.
  const [phones, setPhones] = useState<readonly PartyPhoneInput[]>(lead.phones);
  const patch = (p: Record<string, string>) => setValues((v) => ({ ...v, ...p }));

  // Keep one key per decision, even when the dialog is closed and reopened. Only a definite
  // refusal rotates it. A timeout keeps the key so a retry is the same request.
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    if (state.definite) setKey(crypto.randomUUID());
  }
  useEffect(() => {
    if (!open || pending) return;
    if (summary.current) summary.current.focus();
    else form.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not(:disabled)')?.focus();
  }, [open, pending, state]);

  useEffect(() => {
    if (Object.keys(state.fieldErrors).length) toast.error('Check the highlighted fields.');
  }, [state]);

  const customerExisting = values['customerMode'] === 'existing';
  const contactMode = values['contactMode'];

  return (
    <Dialog
      trigger={<Button>Convert to opportunity</Button>}
      open={open}
      onOpenChange={(next) => {
        if (next && !key) setKey(crypto.randomUUID());
        setOpen(next);
      }}
      title="Convert lead to opportunity"
      description={`${lead.number} · ${lead.title}`}
      closeOnOutsideClick={false}
      locked={pending}
      size="large"
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form={formId} disabled={pending} aria-busy={pending || undefined}>
            {pending ? 'Converting' : 'Convert'}
          </Button>
        </>
      }
    >
      <form id={formId} ref={form} action={formAction} noValidate>
        <input type="hidden" name="leadId" value={lead.id} />
        <input type="hidden" name="expectedVersion" value={lead.version} />
        <input type="hidden" name="idempotencyKey" value={key} />

        <fieldset className={styles.convertFields} disabled={pending}>
          {state.error ? (
            <Alert ref={summary} tabIndex={-1} tone="error" role="alert">
              {state.error}
              {state.reload && !pending ? (
                <>
                  {' '}
                  <a href="">Reload this page</a>
                </>
              ) : null}
            </Alert>
          ) : null}

          {dupes.length > 0 ? (
            <Alert
              ref={summary}
              tabIndex={-1}
              tone="warning"
              role="alert"
              title="A matching record already exists"
            >
              <ul className={styles.candidates}>
                {dupes.map((d) => (
                  <li key={`${d.kind}-${d.id}`} className={styles.candidate}>
                    <span className={styles.candidateText}>
                      <strong>{d.label}</strong>
                      <span className={styles.quiet}>
                        {d.kind === 'customer' ? 'Customer' : 'Contact'}, same {d.matchedOn}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="secondary"
                      size="small"
                      onClick={() =>
                        d.kind === 'customer'
                          ? patch({
                              customerMode: 'existing',
                              customerId: d.id,
                              contactId: '',
                              createAnyway: '',
                            })
                          : patch({
                              customerMode: 'existing',
                              customerId: d.customerId ?? values['customerId'] ?? '',
                              contactMode: 'existing',
                              contactId: d.id,
                              createAnyway: '',
                            })
                      }
                    >
                      Use existing<span className="sr-only"> {d.label}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}

          <Panel title="Carried over from the lead" headingLevel={3} className={styles.dialogPanel}>
            <FactList
              className={styles.conversionFacts ?? ''}
              facts={[
                { key: 'organization', label: 'Organization', value: lead.companyName },
                { key: 'contact', label: 'Contact person', value: lead.contactName },
              ]}
            />
            {lead.requirement ? (
              <Alert tone="info">
                <span className={styles.longText}>{lead.requirement}</span>
              </Alert>
            ) : null}
          </Panel>

          <fieldset className={styles.conversionSection}>
            <legend className={styles.legend}>Organization</legend>
            <label className={styles.choice}>
              <input
                type="radio"
                name="customerMode"
                value="create"
                checked={!customerExisting}
                onChange={set('customerMode')}
              />
              Create a new organization
            </label>
            <label className={styles.choice}>
              <input
                type="radio"
                name="customerMode"
                value="existing"
                checked={customerExisting}
                onChange={set('customerMode')}
              />
              Link to an existing organization
            </label>

            {customerExisting ? (
              <>
                <div className={styles.customerSearch}>
                  <Field
                    label="Find an organization"
                    hint="Search by name, customer number or PAN/VAT."
                  >
                    {(c) => (
                      <Input
                        {...c}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        maxLength={100}
                      />
                    )}
                  </Field>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={searching}
                    onClick={() => {
                      void searchCustomers();
                    }}
                  >
                    {searching ? 'Searching' : 'Search'}
                  </Button>
                </div>
                {lookupError ? <p role="status">{lookupError}</p> : null}
                <Field label="Organization" error={err['customerId']}>
                  {(c) => (
                    <Select
                      {...c}
                      name="customerId"
                      value={customerId}
                      onChange={(e) => patch({ customerId: e.target.value, contactId: '' })}
                    >
                      <option value="">Choose a customer</option>
                      {customerId && !customers.some((c) => c.id === customerId) ? (
                        <option value={customerId}>
                          {dupes.find((d) => d.kind === 'customer' && d.id === customerId)?.label ??
                            'Selected customer'}
                        </option>
                      ) : null}
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </>
            ) : (
              <div className={styles.convertFields}>
                <div className={styles.formGrid}>
                  <Field label="Legal name" error={err['legalName']}>
                    {(c) => (
                      <Input
                        name="legalName"
                        value={values['legalName']}
                        onChange={set('legalName')}
                        required
                        maxLength={200}
                        {...c}
                      />
                    )}
                  </Field>
                  <Field
                    label="PAN or VAT number"
                    hint={nepalCustomer ? 'Optional. Nine digits.' : 'Optional.'}
                    error={err['panVatNo']}
                  >
                    {(c) =>
                      nepalCustomer ? (
                        <PanInput
                          name="panVatNo"
                          value={values['panVatNo']}
                          onValueChange={(pan) => set('panVatNo')({ target: { value: pan } })}
                          edited={panEdited}
                          onEditedChange={setPanEdited}
                          {...c}
                        />
                      ) : (
                        <Input
                          name="panVatNo"
                          value={values['panVatNo']}
                          onChange={(e) => {
                            // The same value becomes the PAN if the country turns NP.
                            setPanEdited(true);
                            set('panVatNo')(e);
                          }}
                          autoComplete="off"
                          {...c}
                        />
                      )
                    }
                  </Field>
                </div>
                {/* The customer's one country: it sits with the address and decides the PAN rules. */}
                <AddressFields
                  name="address"
                  required
                  value={{
                    line: values['line'] ?? '',
                    city: values['city'] ?? '',
                    country: customerCountry,
                  }}
                  onChange={(next) =>
                    patch({ line: next.line, city: next.city, country: next.country })
                  }
                  errors={{
                    line: err['address.line'],
                    city: err['address.city'],
                    country: err['address.country'],
                  }}
                />
              </div>
            )}
          </fieldset>

          <fieldset className={styles.conversionSection}>
            <legend className={styles.legend}>Contact</legend>
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

            {/* Kept mounted while an existing contact is chosen, so the typed numbers and their checks
                come back with it; disabled, nothing in it posts or stops the submit. */}
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
                  <Field
                    label="Email"
                    hint="Required: quotations are sent to it."
                    error={err['contactEmail']}
                  >
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
                <Field
                  label="Phone"
                  hint="Optional. Pick each number's country, or type + and its code."
                >
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
              <Field
                label="Contact"
                hint={
                  contacts?.customerId === customerId
                    ? contacts.error || undefined
                    : 'Choose a customer to load contacts.'
                }
                error={err['contactId']}
              >
                {(c) => (
                  <Select
                    {...c}
                    name="contactId"
                    value={values['contactId'] ?? ''}
                    onChange={set('contactId')}
                  >
                    <option value="">Choose a contact</option>
                    {values['contactId'] &&
                    !(
                      contacts?.customerId === customerId &&
                      contacts.options.some((c) => c.id === values['contactId'])
                    ) ? (
                      <option value={values['contactId']}>
                        {dupes.find((d) => d.kind === 'contact' && d.id === values['contactId'])
                          ?.label ?? 'Selected contact'}
                      </option>
                    ) : null}
                    {(contacts?.customerId === customerId ? contacts.options : []).map((c) => (
                      <option key={c.id} value={c.id} disabled={c.disabled}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
          </fieldset>

          <Panel title="Opportunity details" headingLevel={3} className={styles.dialogPanel}>
            <Field label="Opportunity name" error={err['opportunityName']}>
              {(c) => (
                <Input
                  name="opportunityName"
                  value={values['opportunityName']}
                  onChange={set('opportunityName')}
                  maxLength={200}
                  required
                  {...c}
                />
              )}
            </Field>
            <FactList
              className={styles.conversionFacts ?? ''}
              facts={[
                { key: 'stage', label: 'Pipeline stage', value: 'Qualified' },
                { key: 'value', label: 'Estimated value', value: lead.value ?? 'Not set' },
                {
                  key: 'probability',
                  label: 'Probability',
                  value: lead.probability == null ? 'Not set' : `${lead.probability}%`,
                },
                {
                  key: 'close',
                  label: 'Expected closing date',
                  value: lead.expectedClose ?? 'Not set',
                },
              ]}
            />
          </Panel>

          {dupes.length > 0 ? (
            <fieldset className={styles.conversionSection}>
              <legend className={styles.legend}>Or create anyway</legend>
              <label className={styles.choice}>
                <input
                  type="checkbox"
                  name="createAnyway"
                  checked={values['createAnyway'] !== ''}
                  onChange={(e) => patch({ createAnyway: e.target.checked ? 'on' : '' })}
                />
                Create new records even though a match exists
              </label>
              {values['createAnyway'] !== '' ? (
                <Field label="Reason" hint="Kept in the audit trail." error={err['overrideReason']}>
                  {(c) => (
                    <Input
                      name="overrideReason"
                      value={values['overrideReason']}
                      onChange={set('overrideReason')}
                      maxLength={500}
                      {...c}
                    />
                  )}
                </Field>
              ) : null}
            </fieldset>
          ) : null}
        </fieldset>
        <span className="sr-only" role="status">
          {pending ? 'Converting' : ''}
        </span>
      </form>
    </Dialog>
  );
}
