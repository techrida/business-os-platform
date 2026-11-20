import { CUSTOMER_VIEW_FORBIDDEN_WORDS } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { nextStepText, QuotationNextStep } from './quotation-next-step';

describe('QuotationNextStep (F1-Q28)', () => {
  it('names the documents the company still needs instead of a dead end', () => {
    expect(nextStepText({ status: 'pending', needs: ['contract', 'purchase_order'] }).body).toBe(
      'To complete your order we need a signed contract and a purchase order from you. Our team will contact you to collect it, then confirm your acceptance.',
    );
    expect(nextStepText({ status: 'pending', needs: ['contract'] }).body).toMatch(
      /^To complete your order we need a signed contract from you\./,
    );
  });

  it('says staff will confirm when nothing more is needed, and that it is confirmed after', () => {
    expect(nextStepText({ status: 'pending', needs: [] })).toEqual({
      title: 'What happens next',
      body: 'Our team will confirm your acceptance and then send you the order details.',
    });
    expect(nextStepText({ status: 'confirmed', needs: [] }).title).toBe('Acceptance confirmed');
  });

  it('renders the note with no internal word', () => {
    const html = renderToStaticMarkup(
      <QuotationNextStep after={{ status: 'pending', needs: ['purchase_order'] }} />,
    );
    expect(html).toContain('a purchase order');
    const words = new Set(html.split(/[^A-Za-z]+/).map((w) => w.toLowerCase()));
    expect(CUSTOMER_VIEW_FORBIDDEN_WORDS.filter((w) => words.has(w))).toEqual([]);
  });
});
