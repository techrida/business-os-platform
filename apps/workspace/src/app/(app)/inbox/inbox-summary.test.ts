import { describe, expect, it } from 'vitest';

import { inboxSummaryCards } from './inbox-summary';

const of = (...types: string[]) => types.map((documentType) => ({ documentType, count: 1 }));

describe('inboxSummaryCards', () => {
  it('has no cards for an empty inbox', () => {
    expect(inboxSummaryCards([])).toEqual([]);
  });

  it('shows only the total when every request is one type', () => {
    const cards = inboxSummaryCards([{ documentType: 'tax_invoice', count: 2 }]);
    expect(cards.map((c) => [c.label, c.value])).toEqual([['Waiting for you', 2]]);
  });

  it('adds the largest types, biggest first, ties by label, and names them in plain words', () => {
    const cards = inboxSummaryCards(
      of('tax_invoice', 'quotation_version', 'quotation_version', 'credit_note', 'test_memo'),
    );
    expect(cards.map((c) => [c.label, c.value])).toEqual([
      ['Waiting for you', 5],
      ['Quotation', 2],
      ['Credit note', 1],
      ['Memo', 1],
    ]);
  });

  it('falls back to the raw key for a type without a label', () => {
    const cards = inboxSummaryCards(of('mystery_doc', 'tax_invoice', 'tax_invoice'));
    expect(cards.map((c) => c.label)).toEqual(['Waiting for you', 'Tax invoice', 'mystery_doc']);
  });
});
