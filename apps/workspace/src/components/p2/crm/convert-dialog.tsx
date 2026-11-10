'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';

import styles from './crm.module.css';
import type { ConvertAction, ConvertState } from './types';
import { loadConversionContacts, searchConversionCustomers } from './record-lookups';

export interface ConvertLead {
  id: string;
  version: number;
  number: string;
  title: string;
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
}

function initialValues(lead: ConvertLead): Record<string, string> {
  return {
    customerMode: 'create',
    customerId: '',
    legalName: lead.companyName,
    panVatNo: '',
    line1: '',
    city: '',
    country: 'NP',
    contactMode: 'create',
    contactId: '',
    contactName: lead.contactName,
    contactEmail: lead.email,
    contactPhone: lead.phone,
    opportunityName: lead.title,
    createAnyway: '',
    overrideReason: '',
  };
}

/**
 * Convert a qualified lead into a customer, a contact and an opportunity, in a native dialog (focus
 * is held inside while it is open, Escape closes it, focus returns to the button). The server
 * checks for duplicates. When it finds one, the dialog lists the candidates: "Use existing" links
 * to that record, or "Create anyway" with a reason. Typed values survive every refusal.
 */
export function ConvertDialog({ lead, action }: { lead: ConvertLead; action: ConvertAction }) {
  const [state, formAction, pending] = useActionState<ConvertState, FormData>(action, {
    values: initialValues(lead),
    fieldErrors: {},
  });
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(lead));
  const [key, setKey] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const err = state.fieldErrors;
  const dupes = state.duplicates ?? [];

  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState<{ id: string; label: string }[]>([]);
  const [lookupError, setLookupError] = useState('');
  const [searching, setSearching] = useState(false);
  const [contacts, setContacts] = useState<{
    customerId: string;
    options: { id: string; label: string }[];
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
      setLookupError(result.error || (result.options.length === 0 ? 'No matching customers.' : ''));
    } catch {
      setLookupError('Customers could not be loaded. Try again.');
    } finally {
      setSearching(false);
    }
  }

  const set = (name: string) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [name]: e.target.value }));
  const patch = (p: Record<string, string>) => setValues((v) => ({ ...v, ...p }));

  // One key per decision, made when the dialog opens. A definite refusal makes the next try a new
  // decision, so it gets a new key; a timeout keeps the key, so a retry is the same request.
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    if (state.definite) setKey(crypto.randomUUID());
  }
  const needsAttention = state.error !== undefined || dupes.length > 0;
  useEffect(() => {
    if (needsAttention) summary.current?.focus();
  }, [state, needsAttention]);

  const customerExisting = values['customerMode'] === 'existing';
  const contactMode = values['contactMode'];

  return (
    <>
      <Button
        type="button"
        onClick={() => {
          setKey((k) => k || crypto.randomUUID());
          dialog.current?.showModal();
        }}
      >
        Convert to opportunity
      </Button>
      <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId}>
        <form action={formAction} noValidate>
          <input type="hidden" name="leadId" value={lead.id} />
          <input type="hidden" name="expectedVersion" value={lead.version} />
          <input type="hidden" name="idempotencyKey" value={key} />

          <div className={styles.dialogHead}>
            <div>
              <h2 id={titleId}>Convert lead to opportunity</h2>
              <p className={styles.quiet}>
                {lead.number}
                {' · '}
                <span className={styles.long}>{lead.title}</span>
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="small"
              onClick={() => dialog.current?.close()}
            >
              Close
            </Button>
          </div>

          <div className={styles.dialogBody}>
            {state.error ? (
              <Alert ref={summary} tabIndex={-1} tone="error" role="alert">
                {state.error}
                {state.reload ? (
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

            <fieldset className={styles.section}>
              <legend className={styles.legend}>Customer</legend>
              <label className={styles.choice}>
                <input
                  type="radio"
                  name="customerMode"
                  value="create"
                  checked={!customerExisting}
                  onChange={set('customerMode')}
                />
                Create a new customer
              </label>
              <label className={styles.choice}>
                <input
                  type="radio"
                  name="customerMode"
                  value="existing"
                  checked={customerExisting}
                  onChange={set('customerMode')}
                />
                Link to an existing customer
              </label>

              {customerExisting ? (
                <>
                  <Field label="Find a customer" hint="Search by name, customer number or PAN/VAT.">
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
                    {searching ? 'Searching' : 'Search customers'}
                  </Button>
                  {lookupError ? <p role="status">{lookupError}</p> : null}
                  <Field label="Customer" error={err['customerId']}>
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
                            {dupes.find((d) => d.kind === 'customer' && d.id === customerId)
                              ?.label ?? 'Selected customer'}
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
                <div className={styles.formGrid}>
                  <Field label="Legal name" error={err['legalName']}>
                    {(c) => (
                      <Input
                        name="legalName"
                        value={values['legalName']}
                        onChange={set('legalName')}
                        maxLength={200}
                        {...c}
                      />
                    )}
                  </Field>
                  <Field label="PAN or VAT number" hint="Optional." error={err['panVatNo']}>
                    {(c) => (
                      <Input
                        name="panVatNo"
                        value={values['panVatNo']}
                        onChange={set('panVatNo')}
                        autoComplete="off"
                        {...c}
                      />
                    )}
                  </Field>
                  <Field label="Address" error={err['line1']}>
                    {(c) => (
                      <Input
                        name="line1"
                        value={values['line1']}
                        onChange={set('line1')}
                        maxLength={200}
                        {...c}
                      />
                    )}
                  </Field>
                  <Field label="City" error={err['city']}>
                    {(c) => (
                      <Input
                        name="city"
                        value={values['city']}
                        onChange={set('city')}
                        maxLength={100}
                        {...c}
                      />
                    )}
                  </Field>
                  <Field
                    label="Country code"
                    hint="Two letters, for example NP."
                    error={err['country']}
                  >
                    {(c) => (
                      <Input
                        name="country"
                        value={values['country']}
                        onChange={set('country')}
                        maxLength={2}
                        {...c}
                      />
                    )}
                  </Field>
                </div>
              )}
            </fieldset>

            <fieldset className={styles.section}>
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
              <label className={styles.choice}>
                <input
                  type="radio"
                  name="contactMode"
                  value="none"
                  checked={contactMode === 'none'}
                  onChange={set('contactMode')}
                />
                No contact
              </label>

              {contactMode === 'create' ? (
                <div className={styles.formGrid}>
                  <Field label="Contact name" error={err['contactName']}>
                    {(c) => (
                      <Input
                        name="contactName"
                        value={values['contactName']}
                        onChange={set('contactName')}
                        maxLength={200}
                        {...c}
                      />
                    )}
                  </Field>
                  <Field label="Email" hint="Optional." error={err['contactEmail']}>
                    {(c) => (
                      <Input
                        name="contactEmail"
                        type="email"
                        value={values['contactEmail']}
                        onChange={set('contactEmail')}
                        autoComplete="off"
                        {...c}
                      />
                    )}
                  </Field>
                  <Field
                    label="Phone"
                    hint="Optional. With country code."
                    error={err['contactPhone']}
                  >
                    {(c) => (
                      <Input
                        name="contactPhone"
                        type="tel"
                        value={values['contactPhone']}
                        onChange={set('contactPhone')}
                        autoComplete="off"
                        {...c}
                      />
                    )}
                  </Field>
                </div>
              ) : null}
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
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : null}
            </fieldset>

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

            {dupes.length > 0 ? (
              <fieldset className={styles.section}>
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
                  <Field
                    label="Reason"
                    hint="Kept in the audit trail."
                    error={err['overrideReason']}
                  >
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
          </div>

          <div className={styles.dialogFoot}>
            <Button type="button" variant="secondary" onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Converting' : 'Convert'}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
