'use client';

import type { CountryCode, PartyPhoneInput } from '@bos/contracts';
import { useActionState, useEffect, useId, useRef, useState, type FormEvent } from 'react';

import styles from '@/app/(app)/leads/leads.module.css';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

import { ContactStep } from './convert-contact-step';
import { DetailsStep } from './convert-details-step';
import { errorsOfStep, firstStepWithError, LAST_STEP, type ConvertStep } from './convert-model';
import { OrganisationStep } from './convert-organisation-step';
import { StepIndicator } from './convert-parts';
import type { ChosenCustomer, StepContext } from './convert-types';
import { parseConvert } from './forms';
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
  /** The lead's address, when it has one (D9): the new customer's Address and City start from it, editable. */
  address?: { line: string; city: string } | null;
  /** The lead person's numbers (the DTO's `phones`, primary first): the new contact starts with them. */
  phones: readonly PartyPhoneInput[];
  /**
   * R6O: the customer (and contact) picked in the lead's company field. The dialog starts on converting INTO them, so
   * there is no duplicate warning to answer; the API refuses a second customer for a linked lead.
   */
  customerId?: string | null;
  contactId?: string | null;
  requirement?: string | null;
  value?: string | null;
  probability?: number | null;
  expectedClose?: string | null;
}

function initialValues(lead: ConvertLead): Record<string, string> {
  return {
    customerMode: lead.customerId ? 'existing' : 'create',
    customerId: lead.customerId ?? '',
    legalName: lead.companyName,
    panVatNo: '',
    line: lead.address?.line ?? '',
    city: lead.address?.city ?? '',
    country: lead.country,
    contactMode: lead.customerId && lead.contactId ? 'existing' : 'create',
    contactId: lead.customerId ? (lead.contactId ?? '') : '',
    contactName: lead.contactName,
    contactEmail: lead.email,
    contactCountry: lead.country,
    opportunityName: lead.title,
    createAnyway: '',
    overrideReason: '',
  };
}

/**
 * Convert a qualified lead into a customer, a contact and an opportunity, in three steps: the organisation, the
 * contact, the deal (R6T). One form holds all three, so nothing typed is lost going back; a step that is not showing
 * stays mounted but hidden. A lead without a link starts on "Create" with its company and person filled in; a lead
 * whose company was picked from the customer list starts on that customer. The contact needs an email (a new one
 * types it; an existing one without an address cannot be chosen), so the opportunity's quotations can be sent. When
 * the server finds duplicates, the dialog lists the candidates: link a matching record, or give a reason to create
 * new ones. Typed values survive every refusal, and a refusal on an earlier step takes the user back to it.
 */
export function ConvertDialog({
  lead,
  action,
  searchDelayMs,
}: {
  lead: ConvertLead;
  action: ConvertAction;
  /** How long typing must pause before a live search; tests pass 0. */
  searchDelayMs?: number;
}) {
  const [state, formAction, pending] = useActionState<ConvertState, FormData>(action, {
    values: initialValues(lead),
    fieldErrors: {},
  });
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(lead));
  const [key, setKey] = useState('');
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<ConvertStep>(0);
  // Errors found when moving on (the same rules the server applies); a server answer replaces them.
  const [blocked, setBlocked] = useState(0);
  const [local, setLocal] = useState<Partial<Record<string, string>> | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const formId = useId();
  const err = local ?? state.fieldErrors;
  const dupes = state.duplicates ?? [];

  const [chosen, setChosen] = useState<ChosenCustomer | null>(null);
  const set = (name: string) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [name]: e.target.value }));
  const patch = (p: Record<string, string>) => setValues((v) => ({ ...v, ...p }));
  // The customer's country decides the PAN rules.
  const customerCountry = (values['country'] ?? lead.country) as CountryCode;
  // The PAN edit flag lives here, above the box that remounts on a country switch, so a short value
  // the user typed is still stopped at submit when its box comes back.
  const [panEdited, setPanEdited] = useState(false);
  // The phone list is not fully controlled: React resets the form after every action, and the list
  // then starts over from `defaultValue`. Holding its saved numbers here keeps what the user typed
  // through a refusal; incomplete rows never get that far, their boxes stop the submit.
  const [phones, setPhones] = useState<readonly PartyPhoneInput[]>(lead.phones);

  // Keep one key per decision, even when the dialog is closed and reopened. Only a definite
  // refusal rotates it. A timeout keeps the key so a retry is the same request.
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    setLocal(null);
    if (state.definite) setKey(crypto.randomUUID());
    // The step that can answer the refusal: the earliest field error, else the earliest duplicate (a customer
    // match is step 1, a contact match step 2).
    const back =
      firstStepWithError(state.fieldErrors) ??
      (lead.customerId && state.error?.includes('linked to a customer') ? 0 : null) ??
      (state.duplicates?.length
        ? (Math.min(...state.duplicates.map((d) => (d.kind === 'customer' ? 0 : 1))) as ConvertStep)
        : null);
    if (back !== null) setStep(back);
  }
  useEffect(() => {
    if (!open || pending) return;
    if (summary.current) summary.current.focus();
    else {
      form.current
        ?.querySelector<HTMLElement>(
          '[data-step-panel]:not([hidden]) [aria-invalid="true"]:not(:disabled)',
        )
        ?.focus();
    }
  }, [open, pending, state, local]);

  useEffect(() => {
    if (blocked === 0 || !form.current) return;
    const panels = [...form.current.querySelectorAll<HTMLElement>('[data-step-panel]')];
    const here = panels[step];
    if (here?.querySelector('[aria-invalid="true"]:not(:disabled)')) return;
    const other = panels.findIndex(
      (panel, index) =>
        index !== step && panel.querySelector('[aria-invalid="true"]:not(:disabled)'),
    );
    // Phones live on the Contact step: that is where an unfinished or doubled number waits.
    const target = other >= 0 ? other : step === 1 ? -1 : 1;
    if (target >= 0) setStep(target as ConvertStep);
    // Only a new blocked submit matters, not a later change of step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked]);

  useEffect(() => {
    if (Object.keys(state.fieldErrors).length) toast.error('Check the highlighted fields.');
  }, [state]);

  const ctx: StepContext = {
    values,
    patch,
    set,
    err,
    searchDelayMs,
    onLookupError: (message) => toast.error(message),
  };

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (step === LAST_STEP) return;
    // Enter and Next both submit: on the first two steps that means "go on". A box that stops a submit (a short
    // PAN, an unfinished phone) has already cancelled the event and shown its reason.
    const stopped = event.defaultPrevented;
    event.preventDefault();
    if (stopped) {
      // A box on ANOTHER step stopped the submit (a half-typed phone left behind with Back): its reason is not on
      // screen, so take the user to it once the box has shown its error.
      setBlocked((n) => n + 1);
      return;
    }
    const parsed = parseConvert(new FormData(event.currentTarget));
    const problems = parsed.ok ? {} : errorsOfStep(parsed.fieldErrors, step);
    if (Object.keys(problems).length > 0) {
      setLocal(problems);
      return;
    }
    setLocal(null);
    setStep((step + 1) as ConvertStep);
  }

  const panel = (index: ConvertStep) => ({
    hidden: step !== index,
    'data-step-panel': index,
  });

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
          {step > 0 ? (
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setLocal(null);
                setStep((step - 1) as ConvertStep);
              }}
            >
              Back
            </Button>
          ) : null}
          <Button type="submit" form={formId} disabled={pending} aria-busy={pending || undefined}>
            {step < LAST_STEP ? 'Next' : pending ? 'Converting' : 'Convert'}
          </Button>
        </>
      }
    >
      <form id={formId} ref={form} action={formAction} onSubmit={onSubmit} noValidate>
        <input type="hidden" name="leadId" value={lead.id} />
        <input type="hidden" name="expectedVersion" value={lead.version} />
        <input type="hidden" name="idempotencyKey" value={key} />

        <fieldset className={styles.convertFields} disabled={pending}>
          <StepIndicator step={step} />
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

          <div className={styles.convertFields}>
            <div {...panel(0)}>
              <OrganisationStep
                lead={lead}
                ctx={ctx}
                dupes={dupes}
                org={{ chosen, setChosen, panEdited, setPanEdited, customerCountry }}
              />
            </div>
            <div {...panel(1)}>
              <ContactStep
                lead={lead}
                ctx={ctx}
                phones={phones}
                setPhones={setPhones}
                dupes={dupes}
              />
            </div>
            <div {...panel(2)}>
              <DetailsStep lead={lead} ctx={ctx} hasDuplicates={dupes.length > 0} />
            </div>
          </div>
        </fieldset>
        <span className="sr-only" role="status">
          {pending ? 'Converting' : ''}
        </span>
      </form>
    </Dialog>
  );
}
