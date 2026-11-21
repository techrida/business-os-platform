import { describe, expect, it } from 'vitest';

import { IDS } from './fixtures';
import { parseConfirm, parseDraft, parseMarkBillable } from './forms';

function form(entries: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries))
    for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
  return f;
}

describe('parseConfirm', () => {
  it('sends the version id and the uploaded evidence id', () => {
    const parsed = parseConfirm(
      form({ quotationVersionId: IDS.version, evidenceDocumentIds: IDS.po }),
    );
    expect(parsed).toEqual({
      ok: true,
      body: { quotationVersionId: IDS.version, evidenceDocumentIds: [IDS.po] },
    });
  });

  it('still parses several ids without repeats', () => {
    const parsed = parseConfirm(
      form({
        quotationVersionId: IDS.version,
        evidenceDocumentIds: `${IDS.po}\r\n\n ${IDS.contract} ,${IDS.po}`,
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      body: { quotationVersionId: IDS.version, evidenceDocumentIds: [IDS.po, IDS.contract] },
    });
  });

  it('allows no evidence, because the policy may ask for none', () => {
    const missing = parseConfirm(form({ quotationVersionId: IDS.version }));
    expect(missing).toEqual({
      ok: true,
      body: { quotationVersionId: IDS.version, evidenceDocumentIds: [] },
    });
    // The upload control posts an empty hidden field when no file was uploaded.
    const empty = parseConfirm(form({ quotationVersionId: IDS.version, evidenceDocumentIds: '' }));
    expect(empty).toEqual({
      ok: true,
      body: { quotationVersionId: IDS.version, evidenceDocumentIds: [] },
    });
  });

  it('says which field is wrong and never builds a body', () => {
    const none = parseConfirm(form({ quotationVersionId: '' }));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.errors.quotation).toMatch(/Choose an accepted quotation/);

    const bad = parseConfirm(
      form({ quotationVersionId: IDS.version, evidenceDocumentIds: 'not-an-id' }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.evidence).toBe(
        'The uploaded document is not valid. Remove it and upload it again.',
      );
      expect(bad.errors.evidence).not.toMatch(/line/);
    }

    const many = parseConfirm(
      form({
        quotationVersionId: IDS.version,
        evidenceDocumentIds: Array.from(
          { length: 11 },
          (_, i) => `88888888-8888-4888-8888-${String(i).padStart(12, '0')}`,
        ).join('\n'),
      }),
    );
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.errors.evidence).toMatch(/at most 10/);
  });
});

describe('parseMarkBillable', () => {
  const base = { salesOrderId: IDS.order, scheduleLineId: IDS.milestone, expectedVersion: '3' };

  it('takes the document from the list and the version from the order', () => {
    expect(parseMarkBillable(form({ ...base, evidenceDocumentId: IDS.po }))).toEqual({
      ok: true,
      value: {
        salesOrderId: IDS.order,
        scheduleLineId: IDS.milestone,
        body: { evidenceDocumentId: IDS.po, expectedVersion: 3 },
      },
    });
  });

  it('lets an uploaded document win over the list', () => {
    const parsed = parseMarkBillable(
      form({ ...base, evidenceDocumentId: IDS.po, otherDocumentId: ` ${IDS.contract} ` }),
    );
    expect(parsed.ok && parsed.value.body.evidenceDocumentId).toBe(IDS.contract);
  });

  it('asks for an upload when nothing is chosen, and for a choice or upload when a list is shown', () => {
    const missing = parseMarkBillable(form(base));
    expect(!missing.ok && missing.errors.document).toBe(
      'Upload the document that shows this step was done.',
    );
    const listed = parseMarkBillable(form({ ...base, evidenceListed: '1' }));
    expect(!listed.ok && listed.errors.document).toMatch(
      /Choose a document from the list, or upload/,
    );
  });

  it('refuses a malformed document and a lost hidden field, without asking for an id', () => {
    const bad = parseMarkBillable(form({ ...base, otherDocumentId: 'abc' }));
    expect(!bad.ok && bad.errors.document).toBe('That file could not be used. Upload it again.');
    const lost = parseMarkBillable(
      form({ ...base, expectedVersion: '', evidenceDocumentId: IDS.po }),
    );
    expect(!lost.ok && lost.errors.form).toMatch(/Reload/);
  });
});

describe('parseDraft', () => {
  it('needs both ids', () => {
    expect(parseDraft(form({ salesOrderId: IDS.order, scheduleLineId: IDS.advance }))).toEqual({
      ok: true,
      value: { salesOrderId: IDS.order, scheduleLineId: IDS.advance },
    });
    const lost = parseDraft(form({ salesOrderId: IDS.order }));
    expect(!lost.ok && lost.errors.form).toMatch(/Reload/);
  });
});
