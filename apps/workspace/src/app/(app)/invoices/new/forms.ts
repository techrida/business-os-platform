import {
  CreateManualInvoiceBodySchema,
  CreditNoteBodySchema,
  CURRENCIES,
  DebitNoteBodySchema,
  type CreateManualInvoiceBody,
  type CreditNoteBody,
  type Currency,
  type DebitNoteBody,
} from '@bos/contracts';

import {
  isGuid,
  parseCreditLines,
  parseLines,
  type CreditLineValues,
  type FieldErrors,
  type LineValues,
  type Parsed,
} from './lines';

// What the three forms hand to their server actions, checked before anything reaches the API. A
// body never carries a number, an issue date or a total: the contracts' bodies are strict, and the
// server sets all three. The final `safeParse` is a seatbelt: it can only fail if these rules drift
// from the contract, and then the form says it is incomplete instead of sending a bad body.

const REASON_MAX = 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const INCOMPLETE = 'This form is incomplete. Reload the page and try again.';

const isRealDay = (s: string): boolean => {
  if (!DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

function reasonError(reason: string, ask: string): string | undefined {
  if (reason === '') return ask;
  if (reason.length > REASON_MAX) return `Keep the reason under ${REASON_MAX} characters.`;
  return undefined;
}

export interface ManualInvoiceValues {
  customerId: string;
  currency: Currency;
  manualReason: string;
  /** `YYYY-MM-DD`, or blank for none. */
  dueDate: string;
  lines: LineValues[];
}

/** "NPR", "NPR or USD", "NPR, INR or USD". */
function listInWords(codes: readonly string[]): string {
  if (codes.length <= 1) return codes.join('');
  return `${codes.slice(0, -1).join(', ')} or ${codes[codes.length - 1]}`;
}

/**
 * `enabled` is the company's switched-on currencies (`currency.enabled`, D44) as the page read them;
 * without it every platform currency passes. The API checks again and answers 422
 * CURRENCY_NOT_ENABLED, which `currencyNotEnabledMessage` words for the form.
 */
export function parseManualInvoice(
  values: ManualInvoiceValues,
  enabled: readonly Currency[] = CURRENCIES,
): Parsed<CreateManualInvoiceBody> {
  const errors: FieldErrors = {};
  const manualReason = values.manualReason.trim();
  const dueDate = values.dueDate.trim();
  if (!isGuid(values.customerId)) errors['customerId'] = 'Choose the customer.';
  const allowed = CURRENCIES.filter((c) => enabled.includes(c));
  if (!(allowed as readonly string[]).includes(values.currency)) {
    errors['currency'] =
      allowed.length === CURRENCIES.length
        ? `Choose ${listInWords(allowed)}.`
        : `Choose ${listInWords(allowed)}. Only these currencies are switched on for your company.`;
  }
  const why = reasonError(
    manualReason,
    'Say why this invoice is raised without a sales order. It stays on the invoice.',
  );
  if (why !== undefined) errors['manualReason'] = why;
  if (dueDate !== '' && !isRealDay(dueDate))
    errors['dueDate'] = 'Enter a real date, or leave it blank.';
  const lines = parseLines(values.lines);
  if (!lines.ok) Object.assign(errors, lines.errors);
  if (Object.keys(errors).length > 0 || !lines.ok) return { ok: false, errors };

  const body = {
    customerId: values.customerId,
    currency: values.currency,
    manualReason,
    ...(dueDate !== '' ? { dueDate } : {}),
    lines: lines.data,
  };
  const checked = CreateManualInvoiceBodySchema.safeParse(body);
  return checked.success
    ? { ok: true, data: checked.data }
    : { ok: false, errors: { form: INCOMPLETE } };
}

/**
 * The words for the API's 422 CURRENCY_NOT_ENABLED (the currency was switched off after the page
 * loaded), or undefined for any other failure. Only a known currency code is echoed from `details`.
 * Reads the `ApiError` shape (`status`, `body`) without importing it: `@/lib/api` is server-only and
 * this file stays plain validation.
 */
export function currencyNotEnabledMessage(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, body } = err as { status?: unknown; body?: unknown };
  if (status !== 422) return undefined;
  const error = (body as { error?: { code?: unknown; details?: unknown } } | undefined)?.error;
  if (error?.code !== 'CURRENCY_NOT_ENABLED') return undefined;
  const details = error.details as { currency?: unknown } | undefined;
  const code = details?.currency;
  const named =
    typeof code === 'string' && (CURRENCIES as readonly string[]).includes(code)
      ? code
      : 'This currency';
  return `${named} is no longer switched on for your company. Reload the page and choose another currency.`;
}

export function parseCreditNote(input: {
  originalInvoiceId: string;
  reason: string;
  lines: readonly CreditLineValues[];
}): Parsed<CreditNoteBody> {
  const errors: FieldErrors = {};
  const reason = input.reason.trim();
  const why = reasonError(reason, 'Say why this invoice is being credited.');
  if (why !== undefined) errors['reason'] = why;
  const lines = parseCreditLines(input.lines);
  if (!lines.ok) Object.assign(errors, lines.errors);
  if (Object.keys(errors).length > 0 || !lines.ok) return { ok: false, errors };

  const checked = CreditNoteBodySchema.safeParse({
    originalInvoiceId: input.originalInvoiceId,
    reason,
    lines: lines.data,
  });
  return checked.success
    ? { ok: true, data: checked.data }
    : { ok: false, errors: { form: INCOMPLETE } };
}

export function parseDebitNote(input: {
  originalInvoiceId: string;
  reason: string;
  lines: readonly LineValues[];
}): Parsed<DebitNoteBody> {
  const errors: FieldErrors = {};
  const reason = input.reason.trim();
  const why = reasonError(reason, 'Say why this invoice is being debited.');
  if (why !== undefined) errors['reason'] = why;
  const lines = parseLines(input.lines);
  if (!lines.ok) Object.assign(errors, lines.errors);
  if (Object.keys(errors).length > 0 || !lines.ok) return { ok: false, errors };

  const checked = DebitNoteBodySchema.safeParse({
    originalInvoiceId: input.originalInvoiceId,
    reason,
    lines: lines.data,
  });
  return checked.success
    ? { ok: true, data: checked.data }
    : { ok: false, errors: { form: INCOMPLETE } };
}
