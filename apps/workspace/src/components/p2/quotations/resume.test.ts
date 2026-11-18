import type { QuotationListItem } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  editQuotationHref,
  newQuotationHref,
  opportunityQuotationsHref,
  quotationEntryFor,
} from './resume';

const OPP = '3f1d2c3b-0d52-4d1e-9d8a-4f6c7a5e4a5f';
const row = (id: string, over: Partial<QuotationListItem> = {}): QuotationListItem =>
  ({ id, number: `QT-${id}`, status: 'draft', canEdit: true, ...over }) as QuotationListItem;

describe('quotationEntryFor', () => {
  it('starts a new quotation when the opportunity has none', () => {
    expect(quotationEntryFor([])).toEqual({ kind: 'new' });
  });

  it('resumes the one editable quotation instead of starting a second', () => {
    expect(quotationEntryFor([row('a')])).toEqual({
      kind: 'resume',
      quotationId: 'a',
      number: 'QT-a',
    });
  });

  it('ignores quotations the caller may not edit (sent, approved, a colleague draft)', () => {
    const items = [
      row('sent', { status: 'sent', canEdit: false }),
      row('theirs', { canEdit: false }),
      row('mine', { status: 'returned' }),
    ];
    expect(quotationEntryFor(items)).toMatchObject({ kind: 'resume', quotationId: 'mine' });
    expect(quotationEntryFor(items.slice(0, 2))).toEqual({ kind: 'new' });
  });

  it('asks the person to choose when several are editable', () => {
    expect(quotationEntryFor([row('a'), row('b', { status: 'returned' })])).toEqual({
      kind: 'choose',
      count: 2,
    });
  });
});

describe('quotation links', () => {
  it('builds the editor, the filtered list and the new-quotation URLs', () => {
    expect(editQuotationHref('a/b')).toBe('/quotations/a%2Fb/edit');
    expect(opportunityQuotationsHref(OPP)).toBe(`/quotations?opportunityId=${OPP}`);
    expect(newQuotationHref(OPP)).toBe(`/quotations/new?opportunityId=${OPP}`);
    expect(newQuotationHref(OPP, { another: true })).toBe(
      `/quotations/new?opportunityId=${OPP}&another=1`,
    );
  });
});
