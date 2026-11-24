// Pure helpers for Settings > Number and date format. No React, so the worked examples can be
// tested without rendering. The examples come from the same formatters the documents use.
import {
  CURRENCIES,
  DATE_FORMAT_VALUES,
  DEFAULT_DATE_FORMAT,
  DEFAULT_NUMBER_SYSTEMS,
  DateFormatSchema,
  NUMBER_SYSTEM_VALUES,
  NumberSystemSchema,
  NumberSystemsSchema,
  type Currency,
  type DateFormatSetting,
  type NumberSystemSetting,
  type NumberSystemsSetting,
} from '@bos/contracts';
import { amountInWords, formatCustomerDate, formatMoney, kathmanduDate } from '@bos/locale';

/** One amount that reads differently in the two systems (twenty lakh vs two million). */
export const NUMBER_FORMAT_SAMPLE = '2018180';

/** How each currency is named on this screen. */
export const CURRENCY_LABELS: Record<Currency, string> = {
  NPR: 'NPR (Nepalese rupee)',
  INR: 'INR (Indian rupee)',
  USD: 'USD (US dollar)',
};

const SYSTEM_NAMES: Record<NumberSystemSetting, { name: string; hint: string }> = {
  south_asian: { name: 'South Asian', hint: 'lakh, crore' },
  international: { name: 'International', hint: 'million, billion' },
};

/** The default's name, for the undo icon's tooltip. */
export const systemName = (system: NumberSystemSetting): string => SYSTEM_NAMES[system].name;

export interface NumberSystemOption {
  value: NumberSystemSetting;
  name: string;
  /** The words the system counts with, shown beside the name. */
  hint: string;
  /** The sample amount as printed in this currency, for example `NPR 20,18,180.00`. */
  amount: string;
  /** The same amount spelled out, as it ends the totals block of a document in this currency. */
  words: string;
}

export interface CurrencyNumberRow {
  currency: Currency;
  label: string;
  options: NumberSystemOption[];
}

/** The two choices for one currency, with worked examples drawn by the formatters documents use. */
export function numberSystemOptions(currency: Currency): NumberSystemOption[] {
  return NUMBER_SYSTEM_VALUES.map((value) => ({
    value,
    name: SYSTEM_NAMES[value].name,
    hint: SYSTEM_NAMES[value].hint,
    amount: formatMoney(NUMBER_FORMAT_SAMPLE, currency, {
      numberSystems: { ...DEFAULT_NUMBER_SYSTEMS, [currency]: value },
    }),
    words: amountInWords(NUMBER_FORMAT_SAMPLE, currency, value),
  }));
}

/** One row per currency the app handles, in the order of `CURRENCIES`. */
export function numberSystemRows(): CurrencyNumberRow[] {
  return CURRENCIES.map((currency) => ({
    currency,
    label: CURRENCY_LABELS[currency],
    options: numberSystemOptions(currency),
  }));
}

/** A submitted or stored value as a number system, or null when it is neither. */
export function parseNumberSystem(raw: unknown): NumberSystemSetting | null {
  const parsed = NumberSystemSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** A stored value as the per-currency map, or null unless every currency has a valid system. */
export function parseNumberSystems(raw: unknown): NumberSystemsSetting | null {
  const parsed = NumberSystemsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The form field that carries one currency's choice. */
export const numberSystemFieldName = (currency: Currency): string => `numberSystem:${currency}`;

/**
 * The whole map from a submitted form. It is built from `CURRENCIES`, never from the keys the form
 * happens to send, so a missing or extra currency is refused (null) rather than guessed.
 */
export function numberSystemsFromForm(
  read: (field: string) => unknown,
): NumberSystemsSetting | null {
  const entries = CURRENCIES.map(
    (c) => [c, parseNumberSystem(read(numberSystemFieldName(c)))] as const,
  );
  return parseNumberSystems(Object.fromEntries(entries));
}

/** True when this currency uses the system it had before the setting existed (D30). */
export const isDefaultNumberSystem = (currency: Currency, system: NumberSystemSetting): boolean =>
  DEFAULT_NUMBER_SYSTEMS[currency] === system;

/** The map with one currency back at its default and every other currency untouched. */
export function withCurrencyDefault(
  map: NumberSystemsSetting,
  currency: Currency,
): NumberSystemsSetting {
  const next = { ...map };
  for (const c of CURRENCIES) if (c === currency) next[c] = DEFAULT_NUMBER_SYSTEMS[c];
  return next;
}

/** True when two maps choose the same system for every currency. */
export const sameNumberSystems = (a: NumberSystemsSetting, b: NumberSystemsSetting): boolean =>
  CURRENCIES.every((c) => a[c] === b[c]);

/**
 * Unsaved choices are held as overrides over the saved map, so a refresh keeps them. An override
 * that equals the saved choice is not a change: drop it, and keep the same object when nothing goes.
 */
export function pruneNumberDraft(
  draft: Partial<NumberSystemsSetting>,
  saved: NumberSystemsSetting,
): Partial<NumberSystemsSetting> {
  const next: Partial<NumberSystemsSetting> = {};
  let dropped = false;
  for (const c of CURRENCIES) {
    const choice = draft[c];
    if (choice === undefined) continue;
    if (choice === saved[c]) dropped = true;
    else next[c] = choice;
  }
  return dropped ? next : draft;
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

/** What the pattern reads as, for people who do not read `dd MMM yyyy`. */
const DATE_HINTS: Record<DateFormatSetting, string> = {
  'dd MMM yyyy': 'day month year',
  'dd/MM/yyyy': 'day/month/year',
  'yyyy-MM-dd': 'year-month-day',
  'MMM dd, yyyy': 'month day, year',
};

export interface DateFormatOption {
  value: DateFormatSetting;
  /** Today in this pattern, for example `19 Nov 2026`. */
  example: string;
  /** What the select shows for the option. */
  label: string;
}

/** Today in Kathmandu as `YYYY-MM-DD`. The server computes it once and passes it down. */
export function todayInKathmandu(now: Date = new Date()): string {
  const { y, m, d } = kathmanduDate(now);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The four date formats, each written with `today` (a `YYYY-MM-DD` date) by the documents' formatter. */
export function dateFormatOptions(today: string): DateFormatOption[] {
  return DATE_FORMAT_VALUES.map((value) => {
    const example = formatCustomerDate(today, value);
    return { value, example, label: `${example} (${DATE_HINTS[value]})` };
  });
}

/** A submitted or stored value as a date format, or null when it is not one. */
export function parseDateFormat(raw: unknown): DateFormatSetting | null {
  const parsed = DateFormatSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export const isDefaultDateFormat = (format: DateFormatSetting): boolean =>
  format === DEFAULT_DATE_FORMAT;

/** The default as the option label reads, for the undo icon's tooltip. */
export function defaultDateFormatText(today: string): string {
  return formatCustomerDate(today, DEFAULT_DATE_FORMAT);
}

// ---------------------------------------------------------------------------------------------
// The version a screen loaded
// ---------------------------------------------------------------------------------------------

/**
 * The `version` hidden field: the number the page loaded, or empty when it loaded the default.
 * Anything else (missing, negative, fractional) is refused, so a save is never sent unguarded.
 */
export function parseVersionField(
  raw: unknown,
): { ok: true; version: number | null } | { ok: false } {
  if (raw === '') return { ok: true, version: null };
  if (typeof raw === 'string' && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) {
    return { ok: true, version: Number(raw) };
  }
  return { ok: false };
}

/** The same check for a version passed as an argument (a Server Action argument is untrusted). */
export const isLoadedVersion = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
