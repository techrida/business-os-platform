import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { QuoteValues } from '../_lib/forms';
import { QuoteForm } from './quote-form';

const missingTax = '11111111-1111-4111-8111-111111111111';
// Model a controlled conversion form retaining its selection after the registry changes.
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  return {
    ...react,
    useState: <T,>(initial: T | (() => T)) => {
      const value = typeof initial === 'function' ? (initial as () => T)() : initial;
      if (typeof value === 'object' && value !== null && 'lines' in value && 'mode' in value) {
        const quote = value as unknown as QuoteValues;
        return react.useState({
          ...quote,
          lines: quote.lines.map((line) => ({ ...line, taxCodeId: missingTax })),
        });
      }
      return react.useState(value);
    },
  };
});

describe('conversion tax selection', () => {
  it('shows a retained unavailable tax code and requires an available replacement', () => {
    const out = renderToStaticMarkup(
      <QuoteForm
        action={vi.fn()}
        idempotencyKey="key"
        rfqId="rfq"
        mode="convert"
        vendors={[]}
        submission={{ id: 'submission', vendorName: 'Vendor', vendorRef: null, sentAt: 'Today' }}
        prLines={[{ id: 'line', lineNo: 1, description: 'Chair', uom: 'pcs', quantity: '1' }]}
        taxCodes={[{ id: '22222222-2222-4222-8222-222222222222', label: 'VAT 13%' }]}
        enabledCurrencies={['NPR', 'INR', 'USD']}
        cancelHref="/procurement/rfqs/rfq"
        reloadHref="/procurement/rfqs/rfq/quotations/new?submission=submission"
      />,
    );
    expect(out).toMatch(new RegExp(`<option[^>]*value="${missingTax}"[^>]*selected`));
    expect(out).toContain('Unavailable tax code');
    expect(out).toContain('Choose an available tax code for this line.');
    expect(out).toContain('VAT 13%');
    expect(out).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });
});

describe('currency picker (D44)', () => {
  it('offers only the enabled currencies', () => {
    const out = renderToStaticMarkup(
      <QuoteForm
        action={vi.fn()}
        idempotencyKey="key"
        rfqId="rfq"
        mode="record"
        vendors={[{ id: 'vendor', name: 'Vendor' }]}
        prLines={[{ id: 'line', lineNo: 1, description: 'Chair', uom: 'pcs', quantity: '1' }]}
        taxCodes={[{ id: '22222222-2222-4222-8222-222222222222', label: 'VAT 13%' }]}
        enabledCurrencies={['NPR', 'USD']}
        cancelHref="/procurement/rfqs/rfq"
        reloadHref="/procurement/rfqs/rfq/quotations/new"
      />,
    );
    // The shared Select keeps a hidden native <select> after its named field, listing every option.
    const select = /name="currency" value="[^"]*"\/><button.*?<select[^>]*>(.*?)<\/select>/s.exec(
      out,
    )?.[1];
    expect(select).toBeDefined();
    const values = [...select!.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);
    expect(values.filter((v) => v !== '')).toEqual(['NPR', 'USD']);
  });
});

describe('line items as table rows', () => {
  it('keeps one row per request line with the same field names and a per-line name for each input', () => {
    const out = renderToStaticMarkup(
      <QuoteForm
        action={vi.fn()}
        idempotencyKey="key"
        rfqId="rfq"
        mode="record"
        vendors={[{ id: 'vendor', name: 'Vendor' }]}
        prLines={[
          { id: 'line-a', lineNo: 1, description: 'Chair', uom: 'pcs', quantity: '4' },
          { id: 'line-b', lineNo: 2, description: 'Desk', uom: 'pcs', quantity: '2' },
        ]}
        taxCodes={[{ id: '22222222-2222-4222-8222-222222222222', label: 'VAT 13%' }]}
        enabledCurrencies={['NPR']}
        cancelHref="/procurement/rfqs/rfq"
        reloadHref="/procurement/rfqs/rfq/quotations/new"
      />,
    );
    expect(out.match(/<li /g)).toHaveLength(2);
    for (const name of ['prLineId', 'include', 'quantity', 'unitPrice', 'taxCodeId']) {
      expect(out).toContain(`name="lines.1.${name}"`);
    }
    expect(out).toContain('Quantity<span class="sr-only"> (line 2)</span>');
    expect(out).toContain('Quote line 2: </span>');
    expect(out).toContain('2 pcs requested');
    expect(out).toMatch(/aria-hidden="true"[^>]*><span>#<\/span>/);
  });
});

describe('quotation document upload', () => {
  it('takes the vendor’s file as an upload in record mode, not a typed id', () => {
    const out = renderToStaticMarkup(
      <QuoteForm
        action={vi.fn()}
        idempotencyKey="key"
        rfqId="rfq"
        mode="record"
        vendors={[{ id: 'vendor', name: 'Vendor' }]}
        prLines={[{ id: 'line', lineNo: 1, description: 'Chair', uom: 'pcs', quantity: '1' }]}
        taxCodes={[{ id: '22222222-2222-4222-8222-222222222222', label: 'VAT 13%' }]}
        enabledCurrencies={['NPR']}
        cancelHref="/procurement/rfqs/rfq"
        reloadHref="/procurement/rfqs/rfq/quotations/new"
      />,
    );
    expect(out).toContain('Quotation document');
    expect(out).toMatch(/<input type="hidden" name="documentId" value=""\/>/);
    expect(out).toMatch(/<input type="file"/);
    expect(out).not.toMatch(/<input[^>]*name="documentId"[^>]*class=/);
    expect(out).not.toMatch(/already uploaded to documents/);
  });
});

describe('line description', () => {
  it('starts each line with the request wording in an editable box that is named per line', () => {
    const out = renderToStaticMarkup(
      <QuoteForm
        action={vi.fn()}
        idempotencyKey="key"
        rfqId="rfq"
        mode="record"
        vendors={[{ id: 'vendor', name: 'Vendor' }]}
        prLines={[
          { id: 'line', lineNo: 1, description: 'Office chair', uom: 'pcs', quantity: '1' },
        ]}
        taxCodes={[{ id: '22222222-2222-4222-8222-222222222222', label: 'VAT 13%' }]}
        enabledCurrencies={['NPR']}
        cancelHref="/procurement/rfqs/rfq"
        reloadHref="/procurement/rfqs/rfq/quotations/new"
      />,
    );
    expect(out).toMatch(/name="lines\.0\.description"[^>]*value="Office chair"/);
    expect(out).toContain('Description');
  });
});
