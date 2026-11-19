// Which currencies a document picker offers (`currency.enabled`, D44). Pure, so Client Components can
// import it; the server read is `loadEnabledCurrencies` in `enabled-currencies.server.ts`.
import { CURRENCIES, SETTING_DEFAULTS, type Currency } from '@bos/contracts';

export const CURRENCY_NAME: Readonly<Record<Currency, string>> = {
  NPR: 'NPR (Nepalese rupee)',
  INR: 'INR (Indian rupee)',
  USD: 'USD (US dollar)',
};

export interface CurrencyChoice {
  value: string;
  label: string;
  /** False only for a document's own currency that has since been switched off in Settings. */
  enabled: boolean;
}

const isCurrency = (value: unknown): value is Currency =>
  typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);

/**
 * The enabled list in the fixed order NPR, INR, USD, without unknown codes or repeats. NPR is the
 * books currency and is always in it; an empty or unreadable list falls back to the default.
 */
export function normalizeEnabled(list: readonly unknown[] | null | undefined): Currency[] {
  const known = new Set((list ?? []).filter(isCurrency));
  const source = known.size === 0 ? new Set(SETTING_DEFAULTS['currency.enabled']) : known;
  source.add('NPR');
  return CURRENCIES.filter((c) => source.has(c));
}

/**
 * Picker options: the enabled currencies (NPR first, then the fixed order), plus the document's own
 * `current` currency when it is no longer enabled, so an existing document still shows its value.
 * Labels stay plain, like the other currency pickers; `enabled` lets a caller mark a kept one.
 */
export function currencyChoices(
  enabled: readonly unknown[] | null | undefined,
  current?: string | null,
): CurrencyChoice[] {
  const on = new Set<string>(normalizeEnabled(enabled));
  const choices: CurrencyChoice[] = CURRENCIES.filter((c) => on.has(c) || c === current).map(
    (c) => ({
      value: c,
      label: CURRENCY_NAME[c],
      enabled: on.has(c),
    }),
  );
  if (current && !isCurrency(current)) {
    choices.push({ value: current, label: current, enabled: false });
  }
  return choices;
}
