'use client';

import {
  countryCallingCode,
  DEFAULT_COUNTRY,
  MAX_PARTY_PHONES,
  PHONE_LABELS,
  phoneCountryFromE164,
  phoneProblem,
  type CountryCode,
  type PartyPhoneInput,
  type PhoneLabel,
} from '@bos/contracts';
import {
  parsePhoneNumberFromString,
  type CountryCode as LibCountryCode,
} from 'libphonenumber-js/min';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from './button';
import { CountrySelect } from './country-select';
import { DigitBox, type DigitRules } from './digit-box';
import { Icon } from './icon';
import { fitsNepalBox, INTERNATIONAL_RULES, NEPAL_PREFIX, NEPAL_RULES } from './phone-input';
import { Select } from './select';
import { useFormReset } from './use-form-reset';
import styles from './phone-list-input.module.css';

/** One phone row as the list holds it, complete or not. */
export interface PhoneRowState {
  /** Stable for the row's life; a new row always gets a new one, never an index. */
  key: string;
  country: CountryCode;
  /**
   * `national`: the box shows the country's code as a fixed prefix and takes the national digits (Nepal keeps FX8's
   * rules). `international`: the user started with `+`, so the box takes the whole number, country code first, and
   * the country follows what is typed.
   */
  mode: 'national' | 'international';
  /** What the row's box posts: E.164 once typed (complete or not), `''` while empty. */
  e164: string;
  label: PhoneLabel | null;
  isPrimary: boolean;
  /** Whether the user has edited the number; handed back to the box when it remounts. */
  edited: boolean;
  /** What the box mounts with, and `mount` remounts it (country or mode changed). */
  seed: string;
  mount: number;
}

/** A row the form must not submit: typed but not a valid number for its country, or listed twice. */
export interface PhoneRowProblem {
  index: number;
  key: string;
  message: string;
}

export interface PhoneListInputProps {
  /** The numbers the list starts with (and a form reset restores). Empty starts with one blank row. */
  defaultValue?: readonly PartyPhoneInput[] | undefined;
  /** Complete, valid numbers only, in order, as E.164, with exactly one primary when any. */
  onChange?: ((phones: PartyPhoneInput[]) => void) | undefined;
  /** Every row as held, complete or not, for a caller that needs the drafts. */
  onRowsChange?: ((rows: PhoneRowState[]) => void) | undefined;
  /** Rows the form must not submit; an empty list means the phones are ready to save. */
  onValidityChange?: ((problems: PhoneRowProblem[]) => void) | undefined;
  /** The primary number as E.164 once it is complete and valid, else null. For the lead form's duplicate lookup. */
  onPrimaryChange?: ((e164: string | null) => void) | undefined;
  /**
   * Names the posted fields `<name>.<i>.number`, `.country`, `.label` and `.isPrimary`, by row position. Without a
   * name nothing is posted; the caller uses `onChange`.
   */
  name?: string | undefined;
  /** The country a new row starts in. */
  defaultCountry?: CountryCode | undefined;
  /** Errors from the server, by row position (`phones.1.e164`), shown under that row. */
  rowErrors?: readonly (ReactNode | undefined)[] | undefined;
  /** An error about the whole list ("mark one number as primary"). */
  error?: ReactNode | undefined;
  /** Shows the Primary control on each row. Off for a list whose order is its meaning (the company's printed numbers): the first row is still the primary one in what is posted. Default true. */
  showPrimary?: boolean | undefined;
  /** The most rows the list takes (at most MAX_PARTY_PHONES). Default MAX_PARTY_PHONES. */
  maxRows?: number | undefined;
  /** Shows the optional label select (Mobile, Work, Home, Landline) on each row. */
  showLabels?: boolean | undefined;
  /** Names the rows in accessible names: "Phone 1 number". */
  noun?: string | undefined;
  disabled?: boolean | undefined;
  /** The list's visible label element, so the group is named by it. */
  'aria-labelledby'?: string | undefined;
  className?: string | undefined;
}

const NOISE = /[\s\p{Pd}().]/gu;
const ALL_DIGITS = /^\d*$/;
const E164_MAX = 15;

const dialOf = (country: CountryCode) => countryCallingCode(country) ?? '';
/** A contract problem ("not a valid United States number") as a sentence. */
const sentence = (problem: string) => `${problem.charAt(0).toUpperCase()}${problem.slice(1)}.`;
const labelText = (label: PhoneLabel) => `${label.charAt(0).toUpperCase()}${label.slice(1)}`;

/**
 * Why `e164` is not a number the list may save for `country`, as a sentence, or null. Stricter than the contracts'
 * `phoneProblem` in two places, so the box never calls a number fine that FX8 or E.164 would not: a Nepal number
 * starting with 9 is a ten-digit mobile (the contract also passes `+9779812345` as a landline), and the number must be
 * written the one E.164 way (libphonenumber reads `+4407911…` as valid by dropping the trunk 0, which E.164 leaves out).
 */
function problemOf(country: CountryCode, e164: string): string | null {
  if (e164 === '') return null;
  if (country === 'NP' && e164.startsWith(NEPAL_PREFIX)) {
    const own = NEPAL_RULES.problem(NEPAL_RULES.parse(e164));
    if (own !== null) return own;
  }
  const prefix = `+${dialOf(country)}`;
  const found = phoneProblem(country, e164);
  if (found !== null) {
    const withoutZero = `${prefix}${e164.slice(prefix.length + 1)}`;
    if (e164.startsWith(`${prefix}0`) && phoneProblem(country, withoutZero) === null) {
      return `Leave out the leading 0. ${prefix} is already there.`;
    }
    return sentence(found);
  }
  const parsed = parsePhoneNumberFromString(e164);
  if (parsed !== undefined && parsed.number !== e164) {
    return e164.startsWith(`+${parsed.countryCallingCode}0`)
      ? `Leave out the leading 0. +${parsed.countryCallingCode} is already there.`
      : `Write it as ${parsed.number}.`;
  }
  return null;
}

const nationalCache = new Map<CountryCode, DigitRules>();

/**
 * The box for a country other than Nepal: `+<code>` is the fixed prefix and the national digits are checked by
 * libphonenumber through the contracts' `phoneProblem`, so the box and the save agree.
 */
function nationalRules(country: CountryCode): DigitRules {
  const cached = nationalCache.get(country);
  if (cached) return cached;
  const dial = dialOf(country);
  const prefix = `+${dial}`;
  const max = E164_MAX - dial.length;
  const rules: DigitRules = {
    noun: 'phone number',
    parse: (posted) => {
      if (!posted.startsWith(prefix)) return posted;
      const national = posted.slice(prefix.length);
      return ALL_DIGITS.test(national) ? national : posted;
    },
    post: (digits) => (digits === '' ? '' : `${prefix}${digits}`),
    maxFor: () => max,
    cleanPaste: (pasted, whole) => {
      const bare = pasted.replace(NOISE, '');
      if (!whole) return bare;
      // A whole national number in its local spelling (`020 7946 0958`): drop the trunk prefix the way the country does.
      const parsed = parsePhoneNumberFromString(pasted, country as LibCountryCode);
      return parsed !== undefined && parsed.countryCallingCode === dial
        ? parsed.nationalNumber
        : bare;
    },
    tooLong: () => `A phone number has at most ${max} digits after ${prefix}.`,
    problem: (digits) => {
      if (digits === '') return null;
      if (!ALL_DIGITS.test(digits)) return `Type the digits after ${prefix} only.`;
      return problemOf(country, `${prefix}${digits}`);
    },
    count: () => '',
  };
  nationalCache.set(country, rules);
  return rules;
}

/** The box after a typed `+`: the whole number, judged against the country its calling code names. */
function internationalRules(fallback: CountryCode): DigitRules {
  return {
    ...INTERNATIONAL_RULES,
    problem: (digits) => {
      const base = INTERNATIONAL_RULES.problem(digits);
      if (base !== null || digits === '') return base;
      const e164 = `+${digits}`;
      return problemOf(phoneCountryFromE164(e164) ?? fallback, e164);
    },
  };
}

function rulesOf(row: PhoneRowState): { rules: DigitRules; prefix: string } {
  if (row.mode === 'international') return { rules: internationalRules(row.country), prefix: '+' };
  if (row.country === 'NP') return { rules: NEPAL_RULES, prefix: NEPAL_PREFIX };
  return { rules: nationalRules(row.country), prefix: `+${dialOf(row.country)}` };
}

/** Whether `e164` can open in the national box of `country` (its own code, digits that box would let a user type). */
function fitsNational(country: CountryCode, e164: string): boolean {
  if (country === 'NP') return fitsNepalBox(e164);
  const prefix = `+${dialOf(country)}`;
  const national = e164.slice(prefix.length);
  return (
    dialOf(country) !== '' &&
    e164.startsWith(prefix) &&
    ALL_DIGITS.test(national) &&
    national.length <= E164_MAX - dialOf(country).length
  );
}

/** The problem with a row as a save would see it, or null for an empty or valid row. */
function rowProblem(row: PhoneRowState): string | null {
  return problemOf(row.country, row.e164);
}

function makeBlankRow(key: string, country: CountryCode, isPrimary: boolean): PhoneRowState {
  return {
    key,
    country,
    mode: 'national',
    e164: '',
    label: null,
    isPrimary,
    edited: false,
    seed: '',
    mount: 0,
  };
}

/** The rows a list opens with: the given numbers (one primary), or one blank primary row. */
function startRows(
  given: readonly PartyPhoneInput[] | undefined,
  country: CountryCode,
  keyOf: (index: number) => string,
  limit: number = MAX_PARTY_PHONES,
): PhoneRowState[] {
  const phones = (given ?? []).slice(0, limit);
  if (phones.length === 0) return [makeBlankRow(keyOf(0), country, true)];
  const primary = Math.max(
    0,
    phones.findIndex((phone) => phone.isPrimary),
  );
  return phones.map((phone, index) => ({
    key: keyOf(index),
    country: phone.country,
    mode: 'national',
    e164: phone.e164,
    label: phone.label ?? null,
    isPrimary: index === primary,
    edited: false,
    seed: phone.e164,
    mount: 0,
  }));
}

/**
 * A person's phone numbers: up to five rows, each with its own country (flag, ISO code and calling code), an optional
 * label, and one marked primary. Rows can be added, removed and moved up or down. Each row's box follows FX8's
 * DigitBox: Nepal takes the national digits after a fixed `+977` (a mobile is ten digits starting with 9, a landline
 * 7 to 9 with no leading 0); another country takes the digits after its own code and is checked by libphonenumber.
 * Typing `+` starts the whole international number and the country follows the code, as Stripe's phone field does:
 * `+1 4155552671` in a Nepal row switches it to the United States and saves `+14155552671`.
 *
 * `onChange` reports only complete, valid numbers; `onValidityChange` reports the rows that would stop a save, and
 * each row's box also stops a submit while its edited number is incomplete.
 *
 *   <PhoneListInput name="phones" defaultValue={contact.phones} onChange={setPhones} onPrimaryChange={lookUp} />
 */
export function PhoneListInput({
  defaultValue,
  onChange,
  onRowsChange,
  onValidityChange,
  onPrimaryChange,
  name,
  defaultCountry = DEFAULT_COUNTRY,
  rowErrors,
  error,
  showPrimary = true,
  maxRows = MAX_PARTY_PHONES,
  showLabels = true,
  noun = 'Phone',
  disabled,
  'aria-labelledby': labelledBy,
  className,
}: PhoneListInputProps) {
  const base = useId();
  const limit = Math.min(maxRows, MAX_PARTY_PHONES);
  const rootRef = useRef<HTMLDivElement>(null);
  // The first rows are keyed by position under this list's id; every row made later (add, clear, reset) takes the
  // next number from the counter, so a key is never reused and a removed row's box state can never come back.
  const counter = useRef(0);
  const nextKey = () => {
    counter.current += 1;
    return `${base}-row${counter.current}`;
  };
  const blankRow = (isPrimary: boolean) => makeBlankRow(nextKey(), defaultCountry, isPrimary);
  const [rows, setRows] = useState<PhoneRowState[]>(() =>
    startRows(defaultValue, defaultCountry, (index) => `${base}-start${index}`, limit),
  );

  // Where focus goes once the rows have re-rendered: the moved row's button, the new or switched row's box.
  const pendingFocus = useRef<{ key: string; target: 'number' | 'up' | 'down' } | null>(null);
  useLayoutEffect(() => {
    const want = pendingFocus.current;
    const root = rootRef.current;
    if (want === null || !root) return;
    pendingFocus.current = null;
    const row = root.querySelector(`[data-row="${CSS.escape(want.key)}"]`);
    if (!row) return;
    if (want.target === 'number') {
      row.querySelector<HTMLInputElement>('[data-part="number"] input[inputmode]')?.focus();
      return;
    }
    const wanted = row.querySelector<HTMLButtonElement>(`[data-action="${want.target}"]`);
    const other = row.querySelector<HTMLButtonElement>(
      `[data-action="${want.target === 'up' ? 'down' : 'up'}"]`,
    );
    (wanted && !wanted.disabled ? wanted : other)?.focus();
  });

  const update = (key: string, patch: (row: PhoneRowState) => Partial<PhoneRowState>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch(row) } : row)));

  function onNumber(row: PhoneRowState, posted: string) {
    update(row.key, (current) => {
      if (current.mode !== 'international') return { e164: posted };
      // The country follows the typed calling code: `+1 4…` is the United States, `+977 98…` Nepal.
      const detected = posted === '' ? null : phoneCountryFromE164(posted);
      return { e164: posted, country: detected ?? current.country };
    });
  }

  function onPlus(row: PhoneRowState, digits: string) {
    const e164 = digits === '' ? '' : `+${digits}`;
    const detected = e164 === '' ? null : phoneCountryFromE164(e164);
    // A whole number pasted or autofilled with its code opens in that country's own box; a typed `+` starts the
    // international box, where the country follows as the code is typed.
    const national = detected !== null && fitsNational(detected, e164);
    pendingFocus.current = { key: row.key, target: 'number' };
    update(row.key, (current) => ({
      mode: national ? 'national' : 'international',
      country: detected ?? current.country,
      e164,
      seed: e164,
      edited: true,
      mount: current.mount + 1,
    }));
  }

  function onCountry(row: PhoneRowState, country: CountryCode) {
    if (country === row.country && row.mode === 'national') return;
    update(row.key, (current) => {
      // The digits after the old code carry over to the new one, so picking the wrong country and back loses nothing.
      const prefix = `+${dialOf(current.country)}`;
      const national =
        current.e164.startsWith(prefix) && ALL_DIGITS.test(current.e164.slice(prefix.length))
          ? current.e164.slice(prefix.length)
          : null;
      const seed =
        current.e164 === ''
          ? ''
          : national === null
            ? current.e164
            : `+${dialOf(country)}${national}`;
      return {
        country,
        mode: 'national',
        e164: seed,
        seed,
        edited: current.edited || current.e164 !== '',
        mount: current.mount + 1,
      };
    });
  }

  function setPrimary(key: string) {
    setRows((current) => current.map((row) => ({ ...row, isPrimary: row.key === key })));
  }

  function move(key: string, step: -1 | 1) {
    pendingFocus.current = { key, target: step === -1 ? 'up' : 'down' };
    setRows((current) => {
      const from = current.findIndex((row) => row.key === key);
      const to = from + step;
      if (from === -1 || to < 0 || to >= current.length) return current;
      const next = [...current];
      [next[from], next[to]] = [next[to]!, next[from]!];
      return next;
    });
  }

  function remove(key: string) {
    const index = rows.findIndex((row) => row.key === key);
    const left = rows.filter((row) => row.key !== key);
    if (left.length === 0) {
      // The last row is cleared rather than removed: a fresh row with a fresh key, so no stale box state survives.
      const fresh = blankRow(true);
      pendingFocus.current = { key: fresh.key, target: 'number' };
      setRows([fresh]);
      return;
    }
    const next = left.some((row) => row.isPrimary)
      ? left
      : left.map((row, at) => ({ ...row, isPrimary: at === 0 }));
    const neighbour = next[Math.min(index, next.length - 1)]!;
    pendingFocus.current = { key: neighbour.key, target: 'number' };
    setRows(next);
  }

  function add() {
    if (rows.length >= limit) return;
    const fresh = blankRow(rows.length === 0);
    pendingFocus.current = { key: fresh.key, target: 'number' };
    setRows([...rows, fresh]);
  }

  useFormReset(rootRef, () => {
    setRows(startRows(defaultValue, defaultCountry, () => nextKey(), limit));
  });

  // What the form sees: valid numbers (each once), the rows that stop a save, and the primary number.
  const seen = new Map<string, number>();
  const problems: PhoneRowProblem[] = [];
  const valid: PhoneRowState[] = [];
  rows.forEach((row, index) => {
    const found = rowProblem(row);
    if (found !== null) {
      problems.push({ index, key: row.key, message: found });
      return;
    }
    if (row.e164 === '') return;
    if (seen.has(row.e164)) {
      problems.push({ index, key: row.key, message: 'This number is already listed.' });
      return;
    }
    seen.set(row.e164, index);
    valid.push(row);
  });
  const anyPrimary = valid.some((row) => row.isPrimary);
  const phones: PartyPhoneInput[] = valid.map((row, at) => ({
    country: row.country,
    e164: row.e164,
    label: row.label,
    isPrimary: anyPrimary ? row.isPrimary : at === 0,
  }));
  const primary = rows.find((row) => row.isPrimary);
  const primaryE164 = primary && valid.includes(primary) ? primary.e164 : null;

  const phonesJson = JSON.stringify(phones);
  const problemsJson = JSON.stringify(problems);
  const lastPhones = useRef(phonesJson);
  const lastProblems = useRef(problemsJson);
  const lastPrimary = useRef(primaryE164);
  const latest = useRef({
    onChange,
    onValidityChange,
    onPrimaryChange,
    onRowsChange,
    phones,
    problems,
    rows,
  });
  useLayoutEffect(() => {
    latest.current = {
      onChange,
      onValidityChange,
      onPrimaryChange,
      onRowsChange,
      phones,
      problems,
      rows,
    };
  });
  useEffect(() => {
    if (phonesJson === lastPhones.current) return;
    lastPhones.current = phonesJson;
    latest.current.onChange?.(latest.current.phones);
  }, [phonesJson]);
  useEffect(() => {
    if (problemsJson === lastProblems.current) return;
    lastProblems.current = problemsJson;
    latest.current.onValidityChange?.(latest.current.problems);
  }, [problemsJson]);
  useEffect(() => {
    if (primaryE164 === lastPrimary.current) return;
    lastPrimary.current = primaryE164;
    latest.current.onPrimaryChange?.(primaryE164);
  }, [primaryE164]);
  // A number listed twice (or a row the list holds back) must not be submitted: after a refusal React resets the form
  // and the list restarts from its valid rows, so a server error keyed to a row position would land on another row.
  // Stop the submit here and focus the first such row, unless a number box already stopped it and kept focus.
  useEffect(() => {
    const form = rootRef.current?.closest('form');
    if (!form) return;
    const guard = (event: Event) => {
      const problem = latest.current.problems[0];
      if (problem === undefined) return;
      const stopped = event.defaultPrevented;
      event.preventDefault();
      if (!stopped) {
        rootRef.current
          ?.querySelector<HTMLInputElement>(
            `input[aria-label="${noun} ${problem.index + 1} number"]`,
          )
          ?.focus();
      }
    };
    form.addEventListener('submit', guard);
    return () => form.removeEventListener('submit', guard);
  }, [noun]);
  const firstRows = useRef(true);
  useEffect(() => {
    if (firstRows.current) {
      firstRows.current = false;
      return;
    }
    latest.current.onRowsChange?.(latest.current.rows);
  }, [rows]);

  const full = rows.length >= limit;
  const single = rows.length === 1;
  const errorId = `${base}-error`;
  const limitId = `${base}-limit`;

  return (
    <div
      ref={rootRef}
      role="group"
      {...(labelledBy === undefined
        ? { 'aria-label': `${noun} numbers` }
        : { 'aria-labelledby': labelledBy })}
      {...(error ? { 'aria-describedby': errorId } : {})}
      className={[styles.root, className].filter(Boolean).join(' ')}
    >
      <ol className={styles.rows}>
        {rows.map((row, index) => {
          const n = index + 1;
          const { rules, prefix } = rulesOf(row);
          const duplicate = problems.find(
            (problem) =>
              problem.key === row.key && problem.message === 'This number is already listed.',
          );
          const rowError = rowErrors?.[index] ?? duplicate?.message;
          const rowErrorId = `${row.key}-error`;
          const blank = single && row.e164 === '';
          return (
            <li key={row.key} data-row={row.key} className={styles.row}>
              <div className={styles.country}>
                <CountrySelect
                  compact
                  aria-label={`${noun} ${n} country`}
                  {...(name ? { name: `${name}.${index}.country` } : {})}
                  value={row.country}
                  disabled={disabled === true}
                  onChange={(country) => onCountry(row, country)}
                />
              </div>
              <div className={styles.number} data-part="number">
                <DigitBox
                  key={`${row.mode}-${row.mode === 'national' ? row.country : ''}-${row.mount}`}
                  aria-label={`${noun} ${n} number`}
                  {...(name ? { name: `${name}.${index}.number` } : {})}
                  {...(rowError ? { 'aria-describedby': rowErrorId } : {})}
                  {...(rowError ? { 'aria-invalid': true } : {})}
                  defaultValue={row.seed}
                  onValueChange={(posted) => onNumber(row, posted)}
                  edited={row.edited}
                  onEditedChange={(edited) => update(row.key, () => ({ edited }))}
                  disabled={disabled === true}
                  rules={rules}
                  prefix={prefix}
                  onPlus={(digits) => onPlus(row, digits)}
                  inputMode="tel"
                />
                {rowError ? (
                  <p id={rowErrorId} className={styles.rowError}>
                    {rowError}
                  </p>
                ) : null}
              </div>
              <div className={styles.extras}>
                {showLabels ? (
                  <Select
                    aria-label={`${noun} ${n} label`}
                    {...(name ? { name: `${name}.${index}.label` } : {})}
                    className={styles.label}
                    value={row.label ?? ''}
                    disabled={disabled === true}
                    options={[
                      { value: '', label: 'No label' },
                      ...PHONE_LABELS.map((label) => ({ value: label, label: labelText(label) })),
                    ]}
                    onChange={(event) => {
                      const next = event.target.value;
                      update(row.key, () => ({
                        label: (PHONE_LABELS as readonly string[]).includes(next)
                          ? (next as PhoneLabel)
                          : null,
                      }));
                    }}
                  />
                ) : null}
                {showPrimary ? (
                  <label className={styles.primary}>
                    <input
                      type="radio"
                      name={`${name ?? base}.primary`}
                      value={String(index)}
                      checked={row.isPrimary}
                      disabled={disabled === true}
                      aria-label={`${noun} ${n} primary`}
                      onChange={() => setPrimary(row.key)}
                    />
                    <span aria-hidden="true">Primary</span>
                  </label>
                ) : null}
                {name ? (
                  <input
                    type="hidden"
                    name={`${name}.${index}.isPrimary`}
                    value={row.isPrimary ? 'true' : 'false'}
                    disabled={disabled === true}
                  />
                ) : null}
                <div className={styles.actions}>
                  {single ? null : (
                    <>
                      <button
                        type="button"
                        className={styles.iconButton}
                        data-action="up"
                        aria-label={`Move ${noun.toLowerCase()} ${n} up`}
                        disabled={disabled === true || index === 0}
                        onClick={() => move(row.key, -1)}
                      >
                        <span className={styles.up}>
                          <Icon name="chevron-down" size={18} />
                        </span>
                      </button>
                      <button
                        type="button"
                        className={styles.iconButton}
                        data-action="down"
                        aria-label={`Move ${noun.toLowerCase()} ${n} down`}
                        disabled={disabled === true || index === rows.length - 1}
                        onClick={() => move(row.key, 1)}
                      >
                        <Icon name="chevron-down" size={18} />
                      </button>
                    </>
                  )}
                  {blank ? null : (
                    <button
                      type="button"
                      className={styles.iconButton}
                      data-action="remove"
                      aria-label={`Remove ${noun.toLowerCase()} ${n}`}
                      disabled={disabled === true}
                      onClick={() => remove(row.key)}
                    >
                      <Icon name="x" size={18} />
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <div className={styles.footer}>
        <Button
          type="button"
          variant="ghost"
          size="small"
          data-action="add"
          disabled={disabled === true || full}
          {...(full ? { 'aria-describedby': limitId } : {})}
          onClick={add}
        >
          <Icon name="plus" size={16} />
          Add {noun.toLowerCase()} number
        </Button>
        {full ? (
          <span id={limitId} className={styles.limit}>
            Up to {limit} numbers.
          </span>
        ) : null}
      </div>
      {error ? (
        <p id={errorId} className={styles.listError}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
