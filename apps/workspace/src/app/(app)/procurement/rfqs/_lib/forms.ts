import {
  ConvertSubmissionBodySchema,
  CreateRfqBodySchema,
  RecommendQuotationBodySchema,
  RecordQuotationBodySchema,
  richTextToPlain,
  ScoreQuotationBodySchema,
  type ConvertSubmissionBody,
  type CreateRfqBody,
  type RecommendQuotationBody,
  type RecordQuotationBody,
  type ScoreQuotationBody,
} from '@bos/contracts';
import { NO_SPACES, postedAmount } from '@bos/locale';

/**
 * Pure helpers for the RFQ forms: read what was typed, check it with the contracts' schemas and
 * word every refusal for a person. The server action is the real gate; the browser's checks are a
 * courtesy. Quantities and prices stay the text the person typed: nothing here does arithmetic,
 * because every total is the server's. No server code, so a test or a Client Component can import it.
 */

export type FieldErrors = Record<string, string>;

const str = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};
const trim = (s: string): string => s.trim();

/** A number typed with a space inside it (`10 50`): told so plainly, not with the field's rules. */
const SPACED = /\S\s+\S/;

// ------------------------------------------------------------------------------- new RFQ

export interface RfqValues {
  purchaseRequestId: string;
  /** `datetime-local` text: `YYYY-MM-DDTHH:mm`, read as Kathmandu time. */
  deadline: string;
  vendorIds: string[];
}

export function rfqValuesFromForm(form: FormData): RfqValues {
  return {
    purchaseRequestId: str(form, 'purchaseRequestId'),
    deadline: str(form, 'deadline'),
    vendorIds: form.getAll('vendorIds').filter((v): v is string => typeof v === 'string'),
  };
}

const LOCAL_DEADLINE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * The typed deadline as an ISO instant with Nepal's +05:45 offset. The server's own time zone is
 * never consulted: the person typed Kathmandu time and that is what is sent. Null when the text is
 * not a real date and time.
 */
export function deadlineToIso(local: string): string | null {
  const m = LOCAL_DEADLINE.exec(local.trim());
  if (m === null) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const real =
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === mo - 1 &&
    probe.getUTCDate() === d &&
    probe.getUTCHours() === h &&
    probe.getUTCMinutes() === mi;
  return real ? `${local.trim()}:00+05:45` : null;
}

const DEADLINE_WORDS = 'Choose the quotation deadline: a date and time, in Kathmandu time.';

const RFQ_WORDS: Record<string, string> = {
  purchaseRequestId: 'Choose the purchase request to source.',
  deadline: DEADLINE_WORDS,
  vendorIds: 'Invite at least one vendor, up to 50.',
};

export type ParsedRfq = { ok: true; data: CreateRfqBody } | { ok: false; errors: FieldErrors };

/** Shown next to the deadline when it is not after now (the API answers 400 `deadline_in_past` the same). */
export const DEADLINE_IN_PAST =
  'The quotation deadline has passed. Choose a date and time in the future.';

/**
 * Checks the typed RFQ against the contract and against `now`: a deadline that is not after now would open an
 * RFQ no invited vendor can quote on. The deadline is compared as the Kathmandu instant it is sent as.
 */
export function parseRfqValues(input: RfqValues, now: Date = new Date()): ParsedRfq {
  const distinct = [...new Set(input.vendorIds.map(trim).filter((v) => v !== ''))];
  const parsed = CreateRfqBodySchema.safeParse({
    purchaseRequestId: trim(input.purchaseRequestId),
    deadline: deadlineToIso(input.deadline) ?? '',
    vendorIds: distinct,
  });
  const errors: FieldErrors = {};
  if (parsed.success) {
    if (new Date(parsed.data.deadline).getTime() > now.getTime()) {
      return { ok: true, data: parsed.data };
    }
    errors.deadline = DEADLINE_IN_PAST;
    return { ok: false, errors };
  }
  for (const issue of parsed.error.issues) {
    const head = issue.path[0];
    if (typeof head === 'string') errors[head] ??= RFQ_WORDS[head] ?? issue.message;
  }
  if (Object.keys(errors).length === 0) errors.form = 'Check the form and try again.';
  return { ok: false, errors };
}

// ---------------------------------------------------------------------- deadline extension (F1-Q47)

const KATHMANDU_OFFSET_MS = (5 * 60 + 45) * 60_000;

/** An ISO instant as `datetime-local` text in Kathmandu time (`YYYY-MM-DDTHH:mm`); empty when unreadable. */
export function isoToKathmanduLocal(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  return new Date(t + KATHMANDU_OFFSET_MS).toISOString().slice(0, 16);
}

/** Shown when the new deadline is not after the current one (the API refuses it the same). */
export const DEADLINE_NOT_LATER = 'Choose a deadline later than the current one.';

export type ParsedExtension =
  { ok: true; data: { deadline: string } } | { ok: false; errors: FieldErrors };

/**
 * The typed new deadline, read as Kathmandu time like the create form's, and checked against now
 * and the current deadline: the API refuses one that is not after both.
 */
export function parseExtensionValues(
  local: string,
  currentDeadline: string,
  now: Date = new Date(),
): ParsedExtension {
  const iso = deadlineToIso(local);
  if (iso === null) return { ok: false, errors: { deadline: DEADLINE_WORDS } };
  const at = new Date(iso).getTime();
  if (at <= now.getTime()) return { ok: false, errors: { deadline: DEADLINE_IN_PAST } };
  if (at <= new Date(currentDeadline).getTime()) {
    return { ok: false, errors: { deadline: DEADLINE_NOT_LATER } };
  }
  return { ok: true, data: { deadline: iso } };
}

// ---------------------------------------------------------------------- quotation entry

export type QuoteMode = 'record' | 'convert';

export interface QuoteLineValues {
  /** Unticked lines are left out of the quotation. */
  include: boolean;
  prLineId: string;
  /** What the vendor quoted for the line; the request line's wording unless changed. */
  description: string;
  quantity: string;
  unitPrice: string;
  taxCodeId: string;
}

export interface QuoteValues {
  mode: QuoteMode;
  vendorId: string;
  documentId: string;
  submissionId: string;
  vendorRef: string;
  validUntil: string;
  currency: string;
  deliveryDays: string;
  warranty: string;
  terms: string;
  lines: QuoteLineValues[];
}

/** A blank quotation form with one ticked row per purchase request line, quantity pre-filled with the request's. */
export function emptyQuoteValues(
  mode: QuoteMode,
  prLines: readonly { id: string; quantity: string; description: string }[],
): QuoteValues {
  return {
    mode,
    vendorId: '',
    documentId: '',
    submissionId: '',
    vendorRef: '',
    validUntil: '',
    currency: 'NPR',
    deliveryDays: '',
    warranty: '',
    terms: '',
    lines: prLines.map((l) => ({
      include: true,
      prLineId: l.id,
      description: l.description,
      quantity: l.quantity,
      unitPrice: '',
      taxCodeId: '',
    })),
  };
}

/** Reads the form: header fields by name, lines as `lines.<n>.<field>` in index order. */
export function quoteValuesFromForm(form: FormData): QuoteValues {
  const indexes = new Set<number>();
  for (const name of form.keys()) {
    const m = /^lines\.(\d{1,3})\./.exec(name);
    if (m?.[1] !== undefined) indexes.add(Number(m[1]));
  }
  const lines = [...indexes]
    .sort((a, b) => a - b)
    .map((i) => ({
      include: str(form, `lines.${i}.include`) === 'on',
      prLineId: str(form, `lines.${i}.prLineId`),
      description: str(form, `lines.${i}.description`),
      quantity: str(form, `lines.${i}.quantity`),
      unitPrice: str(form, `lines.${i}.unitPrice`),
      taxCodeId: str(form, `lines.${i}.taxCodeId`),
    }));
  return {
    mode: str(form, 'mode') === 'convert' ? 'convert' : 'record',
    vendorId: str(form, 'vendorId'),
    documentId: str(form, 'documentId'),
    submissionId: str(form, 'submissionId'),
    vendorRef: str(form, 'vendorRef'),
    validUntil: str(form, 'validUntil'),
    currency: str(form, 'currency') || 'NPR',
    deliveryDays: str(form, 'deliveryDays'),
    warranty: str(form, 'warranty'),
    terms: str(form, 'terms'),
    lines,
  };
}

const QUOTE_WORDS: Record<string, string> = {
  vendorId: 'Choose the vendor that sent this quotation.',
  documentId: 'Upload the vendor’s quotation document.',
  submissionId: 'Choose the vendor submission to convert.',
  vendorRef: "The vendor's reference can be up to 100 characters.",
  validUntil: 'Choose the date the quotation is valid until.',
  currency: 'Choose NPR, INR or USD.',
  deliveryDays: 'Enter the delivery time as a whole number of days, 0 to 3650.',
  warranty: 'The warranty can be up to 500 characters.',
  // The schema counts the words of the terms (richTextToPlain), not their markup.
  terms: 'The terms can be up to 2000 characters.',
  quantity: 'Enter a quantity with up to 4 decimal places.',
  unitPrice: 'Enter a unit price of 0 or more, with up to 2 decimal places.',
  taxCodeId: 'Choose the tax code for this line.',
  prLineId: 'This line does not belong to the request. Reload the page.',
  description: 'The description can be up to 500 characters.',
};

export type ParsedQuote =
  | { ok: true; mode: 'record'; data: RecordQuotationBody }
  | { ok: true; mode: 'convert'; data: ConvertSubmissionBody }
  | { ok: false; errors: FieldErrors };

export function parseQuoteValues(input: QuoteValues): ParsedQuote {
  const errors: FieldErrors = {};
  const days = trim(input.deliveryDays);
  if (days !== '' && !/^\d{1,4}$/.test(days)) {
    errors.deliveryDays = SPACED.test(days) ? NO_SPACES : QUOTE_WORDS.deliveryDays!;
  }

  // Only ticked lines are sent; `onScreen[k]` is where the k-th sent line sits on the form.
  const onScreen: number[] = [];
  const lines = input.lines.flatMap((l, i) => {
    if (!l.include) return [];
    onScreen.push(i);
    return [
      {
        prLineId: trim(l.prLineId),
        // Left blank, the server uses the request line's wording.
        ...(trim(l.description) !== '' ? { description: trim(l.description) } : {}),
        quantity: postedAmount(l.quantity),
        unitPrice: postedAmount(l.unitPrice),
        taxCodeId: trim(l.taxCodeId),
      },
    ];
  });

  const shared = {
    ...(trim(input.vendorRef) !== '' ? { vendorRef: trim(input.vendorRef) } : {}),
    ...(trim(input.validUntil) !== '' ? { validUntil: trim(input.validUntil) } : {}),
    currency: trim(input.currency),
    ...(days !== '' && errors.deliveryDays === undefined ? { deliveryDays: Number(days) } : {}),
    ...(trim(input.warranty) !== '' ? { warranty: trim(input.warranty) } : {}),
    // The terms are the editor's HTML (or older plain text): trimmed and sent as is, the API sanitises.
    // A value without words (an empty paragraph) is the same as nothing typed.
    ...(richTextToPlain(input.terms).trim() !== '' ? { terms: trim(input.terms) } : {}),
    lines,
  };
  const result =
    input.mode === 'convert'
      ? ConvertSubmissionBodySchema.safeParse({
          submissionId: trim(input.submissionId),
          ...shared,
        })
      : RecordQuotationBodySchema.safeParse({
          vendorId: trim(input.vendorId),
          documentId: trim(input.documentId),
          ...shared,
        });

  if (result.success && Object.keys(errors).length === 0) {
    return input.mode === 'convert'
      ? { ok: true, mode: 'convert', data: result.data as ConvertSubmissionBody }
      : { ok: true, mode: 'record', data: result.data as RecordQuotationBody };
  }
  if (!result.success) {
    for (const issue of result.error.issues) {
      const [head, index, field] = issue.path;
      if (head === 'lines' && index === undefined) {
        errors.lines ??= 'Choose at least one line to quote.';
      } else if (head === 'lines' && typeof index === 'number' && typeof field === 'string') {
        const row = onScreen[index] ?? index;
        const typed = lines[index]?.[field as keyof (typeof lines)[number]];
        errors[`lines.${row}.${field}`] ??=
          (field === 'quantity' || field === 'unitPrice') &&
          typeof typed === 'string' &&
          SPACED.test(typed)
            ? NO_SPACES
            : (QUOTE_WORDS[field] ?? issue.message);
      } else if (typeof head === 'string') {
        errors[head] ??= QUOTE_WORDS[head] ?? issue.message;
      }
    }
  }
  if (Object.keys(errors).length === 0) errors.form = 'Check the form and try again.';
  return { ok: false, errors };
}

// ----------------------------------------------------------------------------- scores

export const MAX_SCORE_ROWS = 20;

export interface ScoreRowValues {
  criterion: string;
  /** The text typed: converted to a number only after it passes the pattern below. */
  score: string;
}

/** Reads `scores.<n>.criterion` and `scores.<n>.score` in index order. */
export function scoreValuesFromForm(form: FormData): ScoreRowValues[] {
  const indexes = new Set<number>();
  for (const name of form.keys()) {
    const m = /^scores\.(\d{1,3})\./.exec(name);
    if (m?.[1] !== undefined) indexes.add(Number(m[1]));
  }
  return [...indexes]
    .sort((a, b) => a - b)
    .map((i) => ({
      criterion: str(form, `scores.${i}.criterion`),
      score: str(form, `scores.${i}.score`),
    }));
}

/** 0 to 100 with at most two decimals: the platform stores two places and would round more. */
const SCORE_TEXT = /^\d{1,3}(\.\d{1,2})?$/;

export type ParsedScores =
  { ok: true; data: ScoreQuotationBody } | { ok: false; errors: FieldErrors };

/**
 * A row left empty is skipped; errors carry the row's place on screen. A criterion is scored once
 * per submission because each row is an upsert and the later one would silently replace the earlier.
 */
export function parseScoreValues(rows: readonly ScoreRowValues[]): ParsedScores {
  const errors: FieldErrors = {};
  const seen = new Set<string>();
  const scores: { criterion: string; score: number }[] = [];
  rows.forEach((row, i) => {
    const criterion = trim(row.criterion);
    const score = trim(row.score);
    if (criterion === '' && score === '') return;
    if (criterion === '') {
      errors[`scores.${i}.criterion`] = 'Name the criterion, for example Price or Delivery.';
    } else if (criterion.length > 64) {
      errors[`scores.${i}.criterion`] = 'A criterion name can be up to 64 characters.';
    } else if (seen.has(criterion.toLowerCase())) {
      errors[`scores.${i}.criterion`] =
        'Each criterion can be scored once. Rename or clear this row.';
    }
    seen.add(criterion.toLowerCase());
    if (!SCORE_TEXT.test(score) || Number(score) > 100) {
      errors[`scores.${i}.score`] = SPACED.test(score)
        ? NO_SPACES
        : 'Enter a score from 0 to 100, with up to 2 decimal places.';
    }
    scores.push({ criterion, score: Number(score) });
  });
  if (scores.length === 0) errors.scores ??= 'Score at least one criterion.';
  if (scores.length > MAX_SCORE_ROWS) {
    errors.scores = `Score up to ${MAX_SCORE_ROWS} criteria at a time.`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const parsed = ScoreQuotationBodySchema.safeParse({ scores });
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, errors: { form: 'Check the scores and try again.' } };
}

// ----------------------------------------------------------------------- recommendation

export interface RecommendValues {
  vendorQuotationId: string;
  rationale: string;
  /** Needed only when the RFQ has fewer quotations than the company's minimum. */
  fewerThanThreeReason: string;
}

export function recommendValuesFromForm(form: FormData): RecommendValues {
  return {
    vendorQuotationId: str(form, 'vendorQuotationId'),
    rationale: str(form, 'rationale'),
    fewerThanThreeReason: str(form, 'fewerThanThreeReason'),
  };
}

const RECOMMEND_WORDS: Record<string, string> = {
  vendorQuotationId: 'Choose the quotation you recommend.',
  rationale: 'Say why this quotation is the right one, in up to 2000 characters.',
  fewerThanThreeReason: 'The reason can be up to 1000 characters.',
};

export type ParsedRecommend =
  { ok: true; data: RecommendQuotationBody } | { ok: false; errors: FieldErrors };

export function parseRecommendValues(input: RecommendValues): ParsedRecommend {
  const reason = trim(input.fewerThanThreeReason);
  const parsed = RecommendQuotationBodySchema.safeParse({
    vendorQuotationId: trim(input.vendorQuotationId),
    rationale: trim(input.rationale),
    ...(reason !== '' ? { fewerThanThreeReason: reason } : {}),
  });
  if (parsed.success) return { ok: true, data: parsed.data };
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const head = issue.path[0];
    if (typeof head === 'string') errors[head] ??= RECOMMEND_WORDS[head] ?? issue.message;
  }
  if (Object.keys(errors).length === 0) errors.form = 'Check the form and try again.';
  return { ok: false, errors };
}
