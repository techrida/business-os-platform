'use client';
// Step 1 of the convert wizard: the organisation. "Link to an existing organisation" is one live-search combobox
// (UIP-FORM-009); "Create a new organisation" searches as the legal name is typed and shows a customer with the same
// PAN up front, so the user links it instead of making a duplicate.
import { useMemo, useState } from 'react';

import styles from '@/app/(app)/leads/leads.module.css';
import { AddressFields } from '@/components/ui/address-fields';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import type { ComboboxOption } from '@/components/ui/combobox-model';
import { Field, Input } from '@/components/ui/field';
import { FactList, Panel } from '@/components/ui/panel';
import { PanInput } from '@/components/ui/pan-input';

import type { ConvertLead } from './convert-dialog';
import { customerDescription, panToLookUp } from './convert-model';
import { OptionalLabel } from './convert-parts';
import type { ChosenCustomer, OrganisationState, StepContext } from './convert-types';
import convert from './convert-dialog.module.css';
import type { ConversionCustomer } from './record-lookups';
import { useCustomerSearch } from './use-customer-search';

const optionOf = (c: ConversionCustomer): ComboboxOption => ({
  id: c.id,
  label: c.name,
  description: customerDescription(c),
});

export function OrganisationStep({
  lead,
  ctx,
  org,
  dupes,
}: {
  lead: ConvertLead;
  ctx: StepContext;
  org: OrganisationState;
  dupes: readonly { kind: string; id: string; label: string }[];
}) {
  const { values, set } = ctx;
  const existing = values['customerMode'] === 'existing';
  return (
    <>
      <Panel title="Carried over from the lead" headingLevel={3} className={styles.dialogPanel}>
        <FactList
          className={styles.conversionFacts ?? ''}
          facts={[
            { key: 'organization', label: 'Organisation', value: lead.companyName },
            { key: 'contact', label: 'Contact person', value: lead.contactName },
          ]}
        />
      </Panel>
      <fieldset className={styles.conversionSection}>
        <legend className={styles.legend}>Organisation</legend>
        <label className={styles.choice}>
          <input
            type="radio"
            name="customerMode"
            value="create"
            checked={!existing}
            onChange={set('customerMode')}
          />
          Create a new organisation
        </label>
        <label className={styles.choice}>
          <input
            type="radio"
            name="customerMode"
            value="existing"
            checked={existing}
            onChange={set('customerMode')}
          />
          Link to an existing organisation
        </label>
        {existing ? (
          <LinkExisting lead={lead} ctx={ctx} org={org} dupes={dupes} />
        ) : (
          <CreateOrganisation ctx={ctx} org={org} />
        )}
      </fieldset>
    </>
  );
}

function LinkExisting({
  lead,
  ctx,
  org,
  dupes,
}: {
  lead: ConvertLead;
  ctx: StepContext;
  org: OrganisationState;
  dupes: readonly { kind: string; id: string; label: string }[];
}) {
  const { values, patch, err } = ctx;
  const customerId = values['customerId'] ?? '';
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const { customers } = useCustomerSearch(text, undefined, {
    delayMs: ctx.searchDelayMs,
    onError: ctx.onLookupError,
  });
  const options = useMemo<ComboboxOption[]>(() => {
    const found = customers.map(optionOf);
    // The chosen customer stays in the list so the closed box can read its name and PAN/number.
    const chosen: ChosenCustomer | null =
      customerId === ''
        ? null
        : org.chosen?.id === customerId
          ? org.chosen
          : {
              id: customerId,
              name:
                dupes.find((d) => d.kind === 'customer' && d.id === customerId)?.label ??
                (customerId === lead.customerId ? lead.companyName : 'Selected organisation'),
            };
    // Only while nothing is typed: a search in progress lists its own results.
    if (chosen === null || text.trim() !== '' || found.some((o) => o.id === chosen.id)) {
      return found;
    }
    const description = customerDescription({
      id: chosen.id,
      name: chosen.name,
      number: chosen.number ?? '',
      pan: chosen.pan ?? null,
    });
    return [{ id: chosen.id, label: chosen.name, description }, ...found];
  }, [customers, customerId, org.chosen, dupes, lead.customerId, lead.companyName, text]);
  return (
    <Field
      label="Organisation"
      error={err['customerId']}
      hint={
        customerId !== '' && customerId === lead.customerId
          ? 'The customer picked on the lead.'
          : undefined
      }
    >
      {(c) => (
        <Combobox
          id={c.id}
          name="customerId"
          maxLength={100}
          labelledBy={c['aria-labelledby']}
          describedBy={c['aria-describedby']}
          invalid={c['aria-invalid'] === true}
          required
          searchIcon
          keepOrder
          serverFiltered
          showDescriptionWhenClosed
          groupThreshold={Number.POSITIVE_INFINITY}
          options={options}
          value={customerId}
          onInputChange={setText}
          onChange={(id) => {
            if (id === '') {
              org.setChosen(null);
              patch({ customerId: '', contactId: '' });
              return;
            }
            const found = customers.find((m) => m.id === id);
            if (found) org.setChosen(found);
            setText('');
            patch({ customerId: id, contactId: '' });
          }}
          open={open}
          onOpenChange={setOpen}
          addOption={{
            always: true,
            label: (typed) => `Create "${typed}"`,
            // Create "<typed>" switches to the create form with the typed name filled in.
            onAdd: (typed) => {
              org.setChosen(null);
              setText('');
              patch({
                customerMode: 'create',
                customerId: '',
                contactId: '',
                contactMode: 'create',
                legalName: typed,
              });
            },
          }}
          emptyText="Type a name, PAN/VAT or customer number."
          noMatchText="No matching organisation."
          placeholder="Search an organisation"
        />
      )}
    </Field>
  );
}

function CreateOrganisation({ ctx, org }: { ctx: StepContext; org: OrganisationState }) {
  const { values, patch, set, err } = ctx;
  const { customerCountry, panEdited, setPanEdited } = org;
  const nepalCustomer = customerCountry === 'NP';
  const legalName = values['legalName'] ?? '';
  const pan = panToLookUp(values['panVatNo'] ?? '', customerCountry);
  const { customers, panMatches } = useCustomerSearch(legalName, pan, {
    delayMs: ctx.searchDelayMs,
    onError: ctx.onLookupError,
  });
  const [open, setOpen] = useState(false);
  const options = useMemo(() => customers.map(optionOf), [customers]);

  function link(found: ConversionCustomer) {
    org.setChosen(found);
    patch({ customerMode: 'existing', customerId: found.id, contactId: '' });
  }

  return (
    <div className={styles.convertFields}>
      <div className={styles.formGrid}>
        <Field label="Legal name" error={err['legalName']}>
          {(c) => (
            <Combobox
              id={c.id}
              name="legalName"
              maxLength={200}
              labelledBy={c['aria-labelledby']}
              describedBy={c['aria-describedby']}
              invalid={c['aria-invalid'] === true}
              required
              searchIcon
              keepOrder
              serverFiltered
              defaultActive="add"
              groupThreshold={Number.POSITIVE_INFINITY}
              options={options}
              value=""
              inputValue={legalName}
              onInputChange={(text) => patch({ legalName: text })}
              onChange={(id) => {
                const found = customers.find((m) => m.id === id);
                if (found) link(found);
              }}
              open={open}
              onOpenChange={setOpen}
              addOption={{
                always: true,
                label: (typed) => `Keep "${typed}" as a new organisation`,
                onAdd: () => undefined,
              }}
              emptyText="Type at least 2 letters to look for an existing organisation."
              noMatchText="No existing organisation matches."
            />
          )}
        </Field>
        <Field label={<OptionalLabel>PAN or VAT number</OptionalLabel>} error={err['panVatNo']}>
          {(c) =>
            nepalCustomer ? (
              <PanInput
                name="panVatNo"
                value={values['panVatNo'] ?? ''}
                onValueChange={(next) => set('panVatNo')({ target: { value: next } })}
                edited={panEdited}
                onEditedChange={setPanEdited}
                hideCount
                placeholder="601234567"
                {...c}
              />
            ) : (
              <Input
                name="panVatNo"
                value={values['panVatNo'] ?? ''}
                onChange={(e) => {
                  // The same value becomes the PAN if the country turns NP.
                  setPanEdited(true);
                  set('panVatNo')(e);
                }}
                autoComplete="off"
                placeholder="GB123456789"
                {...c}
              />
            )
          }
        </Field>
      </div>
      {panMatches.length > 0 ? (
        <Alert tone="warning" role="alert" title="A customer with this PAN already exists">
          <ul className={styles.candidates}>
            {panMatches.map((m) => (
              <li key={m.id} className={styles.candidate}>
                <span className={convert.matchText}>
                  <strong>{m.name}</strong>
                  <span className={convert.matchQuiet}>{customerDescription(m)}</span>
                </span>
                <Button type="button" size="small" onClick={() => link(m)}>
                  Use this customer<span className="sr-only">: {m.name}</span>
                </Button>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {/* The customer's one country: it sits with the address and decides the PAN rules. */}
      <AddressFields
        name="address"
        required
        value={{
          line: values['line'] ?? '',
          city: values['city'] ?? '',
          country: customerCountry,
        }}
        onChange={(next) => patch({ line: next.line, city: next.city, country: next.country })}
        errors={{
          line: err['address.line'],
          city: err['address.city'],
          country: err['address.country'],
        }}
      />
    </div>
  );
}
