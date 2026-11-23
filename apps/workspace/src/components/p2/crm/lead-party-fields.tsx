'use client';
// The Company and Contact person fields of New lead (BOS-UI-002): search-and-create comboboxes over the shared
// Combobox. Typing searches what the user may read; the LAST row is always Create "<typed text>" and it is the
// highlighted default, so Enter (or saving without picking) keeps the typed text as a new name, exactly as a plain
// input did. A lead stays quick to create: nothing is linked or verified unless the user picks a record.
// - Company: groups "Customers" (picking one links it, fills the company and its country) and "Already a lead" (opens
//   that lead, fills nothing). Editing the text after a pick unlinks it.
// - Contact person: the linked customer's contacts, then Create "<text>"; without a linked customer it is a plain input.
import { CountryCodeSchema, countryName, type CountryCode } from '@bos/contracts';
import { useEffect, useMemo, useState } from 'react';

import { type CompanySearcher, useCompanySearch } from '@/app/(app)/leads/_lib/use-company-search';
import type { ContactLoader, LeadContactOption } from '@/app/(app)/leads/_lib/customer-contacts';
import { Combobox } from '@/components/ui/combobox';
import type { ComboboxOption } from '@/components/ui/combobox-model';
import { Input, type FieldControlProps } from '@/components/ui/field';

const CUSTOMER_PREFIX = 'c:';
const LEAD_PREFIX = 'l:';
export const CUSTOMERS_GROUP = 'Customers';
export const LEADS_GROUP = 'Already a lead';

/** What picking a customer hands the form. */
export interface PickedCustomer {
  id: string;
  name: string;
  country: CountryCode | null;
}

const createLabel = (text: string) => `Create "${text}"`;

export function CompanyField({
  control,
  text,
  onTextChange,
  linkedCustomerId,
  onPick,
  onUnlink,
  search,
  delayMs,
  onOpenLead,
}: {
  control: FieldControlProps;
  text: string;
  onTextChange: (text: string) => void;
  linkedCustomerId: string | null;
  onPick: (customer: PickedCustomer) => void;
  /** The text was edited or cleared after a pick: the customer is no longer the one named. */
  onUnlink: () => void;
  /** Where the suggestions come from; without it the field is a plain input with only Create. */
  search?: CompanySearcher | undefined;
  delayMs?: number | undefined;
  /** Opens a lead of the "Already a lead" group. */
  onOpenLead?: ((leadId: string) => void) | undefined;
}) {
  const matches = useCompanySearch(text, search, delayMs);
  const [open, setOpen] = useState(false);
  const options = useMemo<ComboboxOption[]>(() => {
    // Customers first, then leads; the API's own order (strongest match first) holds inside each group.
    const customers = matches.filter((m) => m.kind === 'customer');
    const leads = matches.filter((m) => m.kind === 'lead');
    return [
      ...customers.map((m) => ({
        id: `${CUSTOMER_PREFIX}${m.id}`,
        label: m.label,
        description: countryLabel(m.country),
        group: CUSTOMERS_GROUP,
      })),
      ...leads.map((m) => ({
        id: `${LEAD_PREFIX}${m.id}`,
        label: m.label,
        group: LEADS_GROUP,
      })),
    ];
  }, [matches]);

  return (
    <>
      <Combobox
        id={control.id}
        name="companyName"
        labelledBy={control['aria-labelledby']}
        describedBy={control['aria-describedby']}
        invalid={control['aria-invalid'] === true}
        required
        keepOrder
        serverFiltered
        defaultActive="add"
        groupThreshold={0}
        ungroupedLabel=""
        options={options}
        inputValue={text}
        onInputChange={(next) => {
          onTextChange(next);
          if (linkedCustomerId !== null) onUnlink();
        }}
        value={linkedCustomerId === null ? '' : `${CUSTOMER_PREFIX}${linkedCustomerId}`}
        onChange={(id) => {
          if (id === '') {
            if (linkedCustomerId !== null) onUnlink();
          } else if (id.startsWith(LEAD_PREFIX)) {
            onOpenLead?.(id.slice(LEAD_PREFIX.length));
          } else if (id.startsWith(CUSTOMER_PREFIX)) {
            const customerId = id.slice(CUSTOMER_PREFIX.length);
            const found = matches.find((m) => m.kind === 'customer' && m.id === customerId);
            if (found !== undefined) {
              const country = CountryCodeSchema.safeParse(found.country);
              onPick({
                id: found.id,
                name: found.label,
                country: country.success ? country.data : null,
              });
            }
          }
        }}
        open={open}
        onOpenChange={setOpen}
        addOption={{ always: true, label: createLabel, onAdd: () => undefined }}
        emptyText="Type at least 3 letters to search customers and leads."
        noMatchText="No matching customer or lead."
        placeholder="Search a customer, or type a new company"
      />
      {linkedCustomerId !== null ? (
        <input type="hidden" name="customerId" value={linkedCustomerId} />
      ) : null}
    </>
  );
}

function countryLabel(code: string | undefined): string | undefined {
  const parsed = CountryCodeSchema.safeParse(code);
  return parsed.success ? countryName(parsed.data) : undefined;
}

export function ContactField({
  control,
  text,
  onTextChange,
  customerId,
  linkedContactId,
  onPick,
  onUnlink,
  loadContacts,
  required = true,
}: {
  control: FieldControlProps;
  text: string;
  onTextChange: (text: string) => void;
  /** The linked customer; null makes this a plain input. */
  customerId: string | null;
  linkedContactId: string | null;
  onPick: (contact: { id: string; name: string }) => void;
  onUnlink: () => void;
  loadContacts?: ContactLoader | undefined;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<{
    customerId: string;
    contacts: LeadContactOption[];
  } | null>(null);
  useEffect(() => {
    if (customerId === null || loadContacts === undefined) return;
    const controller = new AbortController();
    loadContacts(customerId, controller.signal).then(
      (contacts) => {
        if (!controller.signal.aborted) setLoaded({ customerId, contacts });
      },
      () => {
        // A failed list leaves only Create "<text>": the lead can still be saved with a typed name.
        if (!controller.signal.aborted) setLoaded({ customerId, contacts: [] });
      },
    );
    return () => controller.abort();
  }, [customerId, loadContacts]);

  const contacts = loaded?.customerId === customerId ? loaded.contacts : null;
  const options = useMemo<ComboboxOption[]>(
    () =>
      (contacts ?? []).map((c) => ({
        id: c.id,
        label: c.name,
        description: c.detail ?? undefined,
      })),
    [contacts],
  );

  if (customerId === null) {
    return (
      <Input
        name="contactName"
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        maxLength={200}
        required={required}
        {...control}
      />
    );
  }
  return (
    <>
      <Combobox
        id={control.id}
        name="contactName"
        labelledBy={control['aria-labelledby']}
        describedBy={control['aria-describedby']}
        invalid={control['aria-invalid'] === true}
        required={required}
        keepOrder
        defaultActive="add"
        groupThreshold={Number.POSITIVE_INFINITY}
        options={options}
        inputValue={text}
        onInputChange={(next) => {
          onTextChange(next);
          if (linkedContactId !== null) onUnlink();
        }}
        value={linkedContactId ?? ''}
        onChange={(id) => {
          if (id === '') {
            if (linkedContactId !== null) onUnlink();
            return;
          }
          const found = contacts?.find((c) => c.id === id);
          if (found !== undefined) onPick({ id: found.id, name: found.name });
        }}
        open={open}
        onOpenChange={setOpen}
        addOption={{ always: true, label: createLabel, onAdd: () => undefined }}
        emptyText="This customer has no contacts yet. Type a new name."
        noMatchText="No matching contact."
        placeholder="Search this customer's contacts, or type a new name"
      />
      {linkedContactId !== null ? (
        <input type="hidden" name="contactId" value={linkedContactId} />
      ) : null}
    </>
  );
}
