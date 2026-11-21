'use client';

import type { Currency } from '@bos/locale';
import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import styles from '@/app/(app)/leads/leads.module.css';
import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { MoneyInput, PercentInput } from '@/components/ui/number-input';
import { PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { toast } from '@/components/ui/toast';
import { currencyChoices } from '@/lib/enabled-currencies';

import { ActivityTypeButtons } from './activity-type-buttons';
import { SCHEDULE_ACTIVITY_KINDS } from './forms';
import type { FormAction, FormState } from './types';

type FollowUpKind = (typeof SCHEDULE_ACTIVITY_KINDS)[number];

/** A person who may own the lead (or do its follow-up), from `GET /v1/leads/owners`. */
export interface OwnerOption {
  value: string;
  label: string;
}

const EMPTY: Record<string, string> = {
  title: '',
  source: '',
  campaign: '',
  companyName: '',
  contactName: '',
  email: '',
  phone: '',
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

/**
 * The people picker for the owner and the follow-up assignee. With one option (a caller who may
 * only assign to themselves) it is shown read-only and a hidden input posts the value, since a
 * disabled field is not submitted. With none (the list did not load) nothing is posted and the
 * API applies its default.
 */
function PersonSelect({
  name,
  label,
  hint,
  error,
  options,
  value,
  onChange,
  emptyLabel,
}: {
  name: string;
  label: string;
  /** A first choice that posts nothing, so the API applies its default (the caller, the owner). */
  emptyLabel?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  options: readonly OwnerOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const only = options.length === 1 ? options[0] : undefined;
  return (
    <Field label={label} hint={hint} error={error}>
      {(c) =>
        only ? (
          <>
            <Select value={only.value} disabled {...c}>
              <option value={only.value}>{only.label}</option>
            </Select>
            <input type="hidden" name={name} value={only.value} />
          </>
        ) : (
          <Select name={name} value={value} onChange={(e) => onChange(e.target.value)} {...c}>
            {emptyLabel ? <option value="">{emptyLabel}</option> : null}
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        )
      }
    </Field>
  );
}

/** The new-lead form. Inputs are controlled so a refusal does not wipe what was typed. */
export function LeadForm({
  action,
  sources,
  owners,
  enabledCurrencies,
  defaultOwnerId,
  callerUnplaced = false,
  idempotencyKey,
}: {
  action: FormAction;
  sources: { value: string; label: string }[];
  /** The company's switched-on currencies (`currency.enabled`), read once by the page. */
  enabledCurrencies: readonly string[];
  /** Who the lead can go to. Empty when the list did not load: the API then makes it the caller's. */
  owners: readonly OwnerOption[];
  /** The signed-in user when they are in `owners`; the select starts there. */
  defaultOwnerId?: string | undefined;
  /**
   * The signed-in user is known and not in `owners` (Finance, Accountant or PMO entering a lead for Sales): leaving
   * the owner empty gives the lead to the entity's default lead owner, not to them. False when who they are did
   * not load, so the empty choice keeps saying the API makes it theirs.
   */
  callerUnplaced?: boolean | undefined;
  /** Made once per page render on the server; the action hands back the key the next try uses. */
  idempotencyKey: string;
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
    ownerUserId: defaultOwnerId ?? (owners.length === 1 ? (owners[0]?.value ?? '') : ''),
  }));
  const [followUpKind, setFollowUpKind] = useState<FollowUpKind>('call');
  const summary = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  function update(name: string, value: string) {
    setValues((values) => ({ ...values, [name]: value }));
  }
  const set = (name: string) => (e: { target: { value: string } }) => update(name, e.target.value);
  const formId = useId();
  const err = state.fieldErrors;
  const assignee = values['followUpAssigneeUserId'] || values['ownerUserId'] || '';
  const unplaced = defaultOwnerId === undefined;
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
              <PersonSelect
                name="ownerUserId"
                label="Lead owner"
                hint={owners.length === 1 ? 'You can create leads for yourself only.' : undefined}
                error={err['ownerUserId']}
                options={owners}
                emptyLabel={unplaced ? (callerUnplaced ? 'Default owner' : 'You') : undefined}
                value={values['ownerUserId'] ?? ''}
                onChange={(value) => update('ownerUserId', value)}
              />
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
                <Input
                  name="companyName"
                  value={values['companyName']}
                  onChange={set('companyName')}
                  maxLength={200}
                  required
                  {...c}
                />
              )}
            </Field>
            <Field label="Contact person" error={err['contactName']}>
              {(c) => (
                <Input
                  name="contactName"
                  value={values['contactName']}
                  onChange={set('contactName')}
                  maxLength={200}
                  required
                  {...c}
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
            <Field
              label="Phone"
              hint="Optional. With the country code, for example +9779812345678."
              error={err['phone']}
            >
              {(c) => (
                <Input
                  name="phone"
                  type="tel"
                  autoComplete="off"
                  value={values['phone']}
                  onChange={set('phone')}
                  {...c}
                />
              )}
            </Field>
          </div>

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
              <PersonSelect
                name="followUpAssigneeUserId"
                label="Assignee"
                hint="Starts as the lead owner."
                error={err['followUpAssigneeUserId']}
                options={owners}
                emptyLabel={unplaced ? 'The lead owner' : undefined}
                value={assignee}
                onChange={(value) => update('followUpAssigneeUserId', value)}
              />
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
    </>
  );
}
