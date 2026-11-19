// Which currencies a portal form offers (`currency.enabled`, D44), and the words for the API's 422 when
// the company switched the chosen one off. Pure and free of server-only code, so Client Components (the
// vendor quotation and bill forms) can import it: `ApiError` is matched by shape, never imported.
import { CURRENCIES, type Currency } from '@bos/contracts';

export interface CurrencyOption {
  code: Currency;
  /** True only for the form's own currency that the company has since switched off. */
  disabled: boolean;
}

const isCurrency = (value: unknown): value is Currency =>
  typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);

/**
 * The enabled currencies in the fixed order NPR, INR, USD, without unknown codes or repeats. NPR is the
 * books currency and the API always accepts it, so it is always first. A `selected` currency that is
 * known but switched off is appended as disabled, so a form still shows the value it holds.
 */
export function currencyOptions(
  enabled: readonly Currency[],
  selected?: string | null,
): CurrencyOption[] {
  const on = new Set<string>(enabled);
  on.add('NPR');
  const options: CurrencyOption[] = CURRENCIES.filter((c) => on.has(c)).map((code) => ({
    code,
    disabled: false,
  }));
  if (isCurrency(selected) && !on.has(selected)) options.push({ code: selected, disabled: true });
  return options;
}

/** The API's text for D44 (`currencyNotEnabled` in the API). Anchored, so no other message matches. */
const NOT_ENABLED_TEXT = /^Currency ([A-Z]{3}) is not enabled for this company$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

interface ApiErrorBody {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

/** The `error` object of an `ApiError` body (`{ error: { code, message, details? } }`), or undefined. */
function apiErrorOf(err: unknown, status: number): ApiErrorBody | undefined {
  if (!(err instanceof Error) || err.name !== 'ApiError') return undefined;
  const { status: actual, body } = err as Error & { status?: unknown; body?: unknown };
  if (actual !== status || typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === 'object' && error !== null ? error : undefined;
}

/** True for the API's 422 CURRENCY_NOT_ENABLED: the company switched the chosen currency off (D44). */
export function isCurrencyNotEnabled(err: unknown): boolean {
  return apiErrorOf(err, 422)?.code === 'CURRENCY_NOT_ENABLED';
}

/** The words for a currency the company switched off. */
export function currencyNotEnabledMessage(code: string): string {
  return `${code} is switched off for the company. Choose another currency.`;
}

/**
 * The words for a 422 CURRENCY_NOT_ENABLED, or undefined for any other failure. The currency comes
 * from `details.currency`, else from the API's message; only a three-letter code is echoed, never
 * other API text.
 */
export function currencyNotEnabledText(err: unknown): string | undefined {
  const error = apiErrorOf(err, 422);
  if (error?.code !== 'CURRENCY_NOT_ENABLED') return undefined;
  const details = error.details;
  const fromDetails =
    typeof details === 'object' && details !== null
      ? (details as { currency?: unknown }).currency
      : undefined;
  const fromText =
    typeof error.message === 'string' ? NOT_ENABLED_TEXT.exec(error.message)?.[1] : undefined;
  const currency =
    typeof fromDetails === 'string' && CURRENCY_CODE.test(fromDetails) ? fromDetails : fromText;
  return currencyNotEnabledMessage(currency ?? 'This currency');
}
