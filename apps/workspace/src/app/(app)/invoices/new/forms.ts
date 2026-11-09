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

export function parseManualInvoice(values: ManualInvoiceValues): Parsed<CreateManualInvoiceBody> {
  const errors: FieldErrors = {};
  const manualReason = values.manualReason.trim();
  const dueDate = values.dueDate.trim();
  if (!isGuid(values.customerId)) errors['customerId'] = 'Choose the customer.';
  if (!(CURRENCIES as readonly string[]).includes(values.currency)) {
    errors['currency'] = 'Choose NPR, INR or USD.';
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
