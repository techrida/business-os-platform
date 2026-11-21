// Turns what a sales-order action form posted into the contract's request body, or into one sentence
// per wrong field. Pure, with no React and no server imports, so a test can feed it real FormData.
// Serves the NFR "errors name the problem and the recovery": the contract's own schema has the last
// word, this file words the refusal. Nothing invalid reaches the API.
import {
  ConfirmSalesOrderBodySchema,
  MarkBillableBodySchema,
  type ConfirmSalesOrderBody,
  type MarkBillableBody,
} from '@bos/contracts';

import { EVIDENCE_REQUIRED } from '@/lib/evidence';

import { isGuid } from './status';

export type FieldName = 'quotation' | 'evidence' | 'document';

/** One sentence per wrong field, and `form` when the form itself is broken (a lost hidden field). */
export type FieldErrors = Partial<Record<FieldName | 'form', string>>;

export type Parsed<V> = { ok: true; value: V } | { ok: false; errors: FieldErrors };

const BROKEN = 'This form is incomplete. Reload the page and try again.';
const MAX_EVIDENCE = 10;

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The evidence ids the confirm form posts: the upload control's one hidden id, or '' when no file
 * was uploaded (which yields []). Split on spaces and commas, without repeats, so a form that ever
 * posts several ids still parses.
 */
function idsOf(raw: string): string[] {
  return [...new Set(raw.split(/[\s,;]+/).filter((token) => token !== ''))];
}

export function parseConfirm(
  form: FormData,
): { ok: true; body: ConfirmSalesOrderBody } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const quotationVersionId = text(form, 'quotationVersionId');
  if (!isGuid(quotationVersionId)) errors.quotation = 'Choose an accepted quotation.';

  const ids = idsOf(text(form, 'evidenceDocumentIds'));
  if (ids.length > MAX_EVIDENCE) {
    errors.evidence = `Attach at most ${MAX_EVIDENCE} documents.`;
  } else if (!ids.every(isGuid)) {
    errors.evidence = 'The uploaded document is not valid. Remove it and upload it again.';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const body = ConfirmSalesOrderBodySchema.safeParse({
    quotationVersionId,
    evidenceDocumentIds: ids,
  });
  return body.success ? { ok: true, body: body.data } : { ok: false, errors: { form: BROKEN } };
}

export interface MarkBillableInput {
  salesOrderId: string;
  scheduleLineId: string;
  body: MarkBillableBody;
}

export function parseMarkBillable(form: FormData): Parsed<MarkBillableInput> {
  const salesOrderId = text(form, 'salesOrderId');
  const scheduleLineId = text(form, 'scheduleLineId');
  const expectedVersion = Number(text(form, 'expectedVersion'));
  if (
    !isGuid(salesOrderId) ||
    !isGuid(scheduleLineId) ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    return { ok: false, errors: { form: BROKEN } };
  }

  // An uploaded file wins: it is for the document that is not in the order's evidence list.
  const documentId = text(form, 'otherDocumentId') || text(form, 'evidenceDocumentId');
  if (documentId === '') {
    const listed = text(form, 'evidenceListed') === '1';
    return {
      ok: false,
      errors: {
        document: listed
          ? 'Choose a document from the list, or upload the one that shows this step was done.'
          : EVIDENCE_REQUIRED,
      },
    };
  }
  if (!isGuid(documentId)) {
    return { ok: false, errors: { document: 'That file could not be used. Upload it again.' } };
  }
  const body = MarkBillableBodySchema.safeParse({
    evidenceDocumentId: documentId,
    expectedVersion,
  });
  return body.success
    ? { ok: true, value: { salesOrderId, scheduleLineId, body: body.data } }
    : { ok: false, errors: { form: BROKEN } };
}

export interface DraftInput {
  salesOrderId: string;
  scheduleLineId: string;
}

export function parseDraft(form: FormData): Parsed<DraftInput> {
  const salesOrderId = text(form, 'salesOrderId');
  const scheduleLineId = text(form, 'scheduleLineId');
  return isGuid(salesOrderId) && isGuid(scheduleLineId)
    ? { ok: true, value: { salesOrderId, scheduleLineId } }
    : { ok: false, errors: { form: BROKEN } };
}
