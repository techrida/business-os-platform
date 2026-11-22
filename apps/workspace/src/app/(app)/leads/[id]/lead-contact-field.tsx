'use client';

import {
  formatPartyPhoneForPrint,
  MAX_PARTY_PHONES,
  type CountryCode,
  type PartyPhoneInput,
} from '@bos/contracts';
import { useEffect, useRef, useState, useTransition, type FormEvent } from 'react';

import { formPhones, type FieldErrors } from '@/components/p2/crm/forms';
import { Button } from '@/components/ui/button';
import { CountrySelect } from '@/components/ui/country-select';
import { Field } from '@/components/ui/field';
import { PhoneListInput, type PhoneRowProblem } from '@/components/ui/phone-list-input';
import { Stack } from '@/components/ui/stack';
import { toast } from '@/components/ui/toast';

import { updateLeadContactAction } from '../actions';
import styles from '../leads.module.css';

import own from './lead-contact-field.module.css';

export interface LeadContactFieldProps {
  leadId: string;
  /** The lead's version as the page showed it; sent so a stale page gets a 409, not an overwrite. */
  version: number;
  /** The lead's saved country. */
  country: CountryCode;
  /** The person's saved numbers, primary first (as the API returns them). */
  phones: readonly PartyPhoneInput[];
  /** Whether the caller may change them: an editor on a lead that is not converted. */
  editable: boolean;
}

/** The number a person is reached on first: the one marked primary, else the first. */
export function primaryPhone(phones: readonly PartyPhoneInput[]): PartyPhoneInput | undefined {
  return phones.find((phone) => phone.isPrimary) ?? phones[0];
}

const signature = (phones: readonly PartyPhoneInput[]) =>
  phones
    .map((p) => [p.country, p.e164, p.label ?? '', p.isPrimary ? 'primary' : ''].join('|'))
    .join(',');

/**
 * The value of the lead page's "Phone" fact: the primary number, formatted. For an editor, an
 * "Edit country and phones" button opens the lead's Country and its phone list under it; Save
 * sends only what changed (the country, the whole list, or both) with the version the page showed.
 */
export function LeadContactField(props: LeadContactFieldProps) {
  const primary = primaryPhone(props.phones);
  const display = primary ? (
    <span>{formatPartyPhoneForPrint(primary.e164)}</span>
  ) : (
    <span className={styles.quiet}>Not set</span>
  );
  if (!props.editable) return display;
  return (
    <Stack gap="small">
      {display}
      {/* A new version (after a save or another change) starts the editor from the page again. */}
      <ContactEditor key={props.version} {...props} />
    </Stack>
  );
}

function ContactEditor({
  leadId,
  version,
  country: savedCountry,
  phones: savedPhones,
}: LeadContactFieldProps) {
  const [open, setOpen] = useState(false);
  const [country, setCountry] = useState<CountryCode>(savedCountry);
  const [problems, setProblems] = useState<PhoneRowProblem[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, startTransition] = useTransition();
  const form = useRef<HTMLFormElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  // Where focus goes after the editor opens or closes; nothing moves on the first render.
  const focusNext = useRef<'form' | 'toggle' | null>(null);

  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === 'form') {
      form.current?.querySelector<HTMLInputElement>('input:not([type="hidden"])')?.focus();
    }
    if (target === 'toggle') toggle.current?.focus();
  }, [open]);

  function close() {
    focusNext.current = 'toggle';
    setOpen(false);
    setCountry(savedCountry);
    setProblems([]);
    setErrors({});
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    // A phone box that cannot be saved has already stopped the submit and kept focus.
    const stopped = event.defaultPrevented;
    event.preventDefault();
    if (stopped || pending) return;
    const problem = problems[0];
    if (problem !== undefined) {
      form.current
        ?.querySelector<HTMLInputElement>(`input[aria-label="Phone ${problem.index + 1} number"]`)
        ?.focus();
      return;
    }
    const data = new FormData(event.currentTarget);
    // A box holding digits that do not make a number yet posts nothing: never save (or close) past it.
    const unfinished = [
      ...event.currentTarget.querySelectorAll<HTMLInputElement>(
        'input[aria-label^="Phone "][aria-label$=" number"]',
      ),
    ].find((box, row) => box.value.trim() !== '' && !data.get(`phones.${row}.number`));
    if (unfinished) {
      unfinished.focus();
      return;
    }
    // Only what changed goes to the server: an untouched list is not re-sent.
    if (data.get('country') === savedCountry) data.delete('country');
    if (signature(formPhones(data, 'phones').phones) === signature(savedPhones)) {
      for (const key of [...data.keys()]) if (key.startsWith('phones.')) data.delete(key);
    }
    if (!data.has('country') && !data.has('phones.0.number')) {
      close();
      return;
    }
    startTransition(async () => {
      const result = await updateLeadContactAction({}, data);
      if (result.ok) {
        toast.success('Country and phones saved.');
        close();
        return;
      }
      const message =
        result.error ?? 'The country and phones could not be saved. Check the marked fields.';
      if (result.reload) {
        toast.error(message, {
          action: { label: 'Reload', onClick: () => window.location.reload() },
        });
        return;
      }
      // A refusal the person can act on stays next to the control (UIP-FEED-001), and toasts too.
      setErrors({ ...result.fieldErrors, ...(result.error ? { form: result.error } : {}) });
      toast.error(message);
    });
  }

  if (!open) {
    return (
      <div>
        <Button
          ref={toggle}
          type="button"
          variant="secondary"
          size="small"
          aria-expanded={false}
          onClick={() => {
            focusNext.current = 'form';
            setOpen(true);
          }}
        >
          Edit country and phones
        </Button>
      </div>
    );
  }

  return (
    <form ref={form} noValidate onSubmit={onSubmit} aria-busy={pending || undefined}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <Stack gap="small">
        <Field label="Country" error={errors['country']}>
          {(c) => (
            <CountrySelect
              name="country"
              value={country}
              onChange={(code) => {
                setCountry(code);
                setErrors((current) => ({ ...current, country: undefined }));
              }}
              disabled={pending}
              {...c}
            />
          )}
        </Field>
        <Field label="Phone" hint="Pick each number's country, or type + and its code.">
          {(c) => (
            <PhoneListInput
              name="phones"
              aria-labelledby={c['aria-labelledby']}
              defaultValue={savedPhones}
              disabled={pending}
              rowErrors={Array.from(
                { length: MAX_PARTY_PHONES },
                (_, row) => errors[`phones.${row}`],
              )}
              error={errors['phones'] ?? errors['form']}
              onChange={() =>
                setErrors((current) =>
                  current['form'] || current['phones']
                    ? { ...current, form: undefined, phones: undefined }
                    : current,
                )
              }
              onValidityChange={setProblems}
            />
          )}
        </Field>
        <div className={own.actions}>
          <Button
            type="submit"
            variant="secondary"
            size="small"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? 'Saving' : 'Save'}
          </Button>
          <Button type="button" variant="ghost" size="small" disabled={pending} onClick={close}>
            Cancel
          </Button>
        </div>
      </Stack>
    </form>
  );
}
