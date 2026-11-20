// Turns what a quotation action form posted into the contract's request body, or into one sentence
// per wrong field. Pure, with no React and no server imports, so a test can feed it real FormData.
// Serves the NFR "errors name the problem and the recovery": the contract's own schema decides what
// is valid, this file only words the refusal. Nothing invalid reaches the API.
import {
  CancelQuotationBodySchema,
  ConfirmEvidenceBodySchema,
  type ConfirmEvidenceBody,
  RecordOutcomeBodySchema,
  ReviseQuotationBodySchema,
  SendQuotationBodySchema,
  type CancelQuotationBody,
  type RecordOutcomeBody,
  type ReviseQuotationBody,
  type SendQuotationBody,
} from '@bos/contracts';

export type FieldName =
  'recipient' | 'message' | 'outcome' | 'decidedOn' | 'evidence' | 'comment' | 'reason';

/** One sentence per wrong field, and `form` when the form itself is broken (a lost hidden field). */
export type FieldErrors = Partial<Record<FieldName | 'form', string>>;

export type Parsed<B> = { ok: true; body: B } | { ok: false; errors: FieldErrors };

const BROKEN = 'This form is incomplete. Reload the page and try again.';

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

/** An optional text field: absent when blank, because the contract refuses an empty string. */
function optional(form: FormData, name: string): Record<string, string> {
  const v = text(form, name);
  return v === '' ? {} : { [name]: v };
}

/** Maps the schema's field to the form's field, and its issue to the sentence for that field. */
const FIELD_OF: Record<string, FieldName | 'form'> = {
  recipientContactId: 'recipient',
  message: 'message',
  outcome: 'outcome',
  decidedOn: 'decidedOn',
  evidenceKinds: 'evidence',
  evidenceDocumentIds: 'form',
  comment: 'comment',
  reason: 'reason',
  expectedVersion: 'form',
};

function sentence(field: FieldName | 'form', code: string): string {
  const tooLong = code === 'too_big';
  switch (field) {
    case 'recipient':
      return 'Choose who should receive it.';
    case 'message':
      return tooLong ? 'Keep the message to 2000 characters or fewer.' : 'Check the message.';
    case 'outcome':
      return 'Choose whether the customer accepted or rejected.';
    case 'decidedOn':
      return 'Enter the date the customer answered.';
    case 'evidence':
      return 'Choose at least one kind of evidence the customer gave.';
    case 'comment':
      return tooLong
        ? 'Keep the comment to 2000 characters or fewer.'
        : 'Say why the customer said no. It is kept with the quotation.';
    case 'reason':
      return tooLong
        ? 'Keep the reason to 1000 characters or fewer.'
        : 'Say why you are revising it. The reason is kept with the new revision.';
    case 'form':
      return BROKEN;
  }
}

function errorsOf(issues: readonly { path: PropertyKey[]; code: string }[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? '');
    const field = FIELD_OF[key] ?? 'form';
    // The first issue for a field is the one to word; a later one would only repeat it.
    errors[field] ??= sentence(field, issue.code);
  }
  return errors;
}

function version(form: FormData): { expectedVersion: number } {
  return { expectedVersion: Number(text(form, 'expectedVersion')) };
}

/** The send form: a recipient, an optional message, and the version row the person looked at. */
export function parseSend(form: FormData): Parsed<SendQuotationBody> {
  const parsed = SendQuotationBodySchema.safeParse({
    recipientContactId: text(form, 'recipientContactId'),
    ...optional(form, 'message'),
    ...version(form),
  });
  return parsed.success
    ? { ok: true, body: parsed.data }
    : { ok: false, errors: errorsOf(parsed.error.issues) };
}

/**
 * The outcome form. `today` is the Kathmandu date, so a date after it is refused: nobody can have
 * recorded an answer the customer has not given yet.
 */
export function parseOutcome(form: FormData, today: string): Parsed<RecordOutcomeBody> {
  const decidedOn = text(form, 'decidedOn');
  const parsed = RecordOutcomeBodySchema.safeParse({
    outcome: text(form, 'outcome'),
    decidedOn,
    ...optional(form, 'comment'),
    evidenceKinds: form.getAll('evidenceKinds'),
    ...version(form),
  });
  const errors: FieldErrors = parsed.success ? {} : errorsOf(parsed.error.issues);
  if (
    /^\d{4}-\d{2}-\d{2}$/.test(decidedOn) &&
    decidedOn > today &&
    errors.decidedOn === undefined
  ) {
    errors.decidedOn = 'The date cannot be in the future.';
  }
  if (parsed.success && Object.keys(errors).length === 0) return { ok: true, body: parsed.data };
  return { ok: false, errors };
}

/** The revise form: a mandatory reason and the version row. */
export function parseRevise(form: FormData): Parsed<ReviseQuotationBody> {
  const parsed = ReviseQuotationBodySchema.safeParse({
    reason: text(form, 'reason'),
    ...version(form),
  });
  return parsed.success
    ? { ok: true, body: parsed.data }
    : { ok: false, errors: errorsOf(parsed.error.issues) };
}

/** The cancel form: a mandatory reason and the version row. Cancelling ends the quotation for good. */
export function parseCancel(form: FormData): Parsed<CancelQuotationBody> {
  const parsed = CancelQuotationBodySchema.safeParse({
    reason: text(form, 'reason'),
    ...version(form),
    ...optional(form, 'versionId'),
  });
  if (parsed.success) return { ok: true, body: parsed.data };
  const errors = errorsOf(parsed.error.issues);
  if (errors.reason !== undefined && !/1000 characters/.test(errors.reason)) {
    errors.reason = 'Say why you are cancelling it. The reason is kept with the quotation.';
  }
  return { ok: false, errors };
}

/** The confirm-evidence form: the kinds of evidence the staff member holds, and an optional note. */
export function parseConfirmEvidence(form: FormData): Parsed<ConfirmEvidenceBody> {
  const parsed = ConfirmEvidenceBodySchema.safeParse({
    evidenceKinds: form.getAll('evidenceKinds'),
    ...optional(form, 'comment'),
  });
  if (parsed.success) return { ok: true, body: parsed.data };
  const errors = errorsOf(parsed.error.issues);
  if (errors.evidence !== undefined) errors.evidence = 'Tick the evidence you checked.';
  return { ok: false, errors };
}
