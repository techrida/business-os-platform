import { CUSTOMER_VIEW_FORBIDDEN_WORDS } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { INVOICE_ID, sampleInvoice, sampleListItem, sampleSettlement } from './invoice-fixtures';
import { InvoiceList } from './invoice-list';
import { canPay } from './invoice-status';
import { InvoiceView } from './invoice-view';

vi.mock('server-only', () => ({}));

/** Every word in the markup (text, attributes, class names), split on non-letters and camelCase, lower-cased. */
function wordsOf(markup: string): Set<string> {
  const spaced = markup.replace(/([a-z])([A-Z])/g, '$1 $2');
  return new Set(spaced.split(/[^A-Za-z]+/).map((w) => w.toLowerCase()));
}

/** "NPR" here is the invoice's own currency, which the customer must see; the forbidden word means an NPR equivalent of a foreign amount. */
const forbiddenIn = (markup: string): string[] => {
  const words = wordsOf(markup.replace(/\bNPR\b/g, ''));
  return CUSTOMER_VIEW_FORBIDDEN_WORDS.filter((w) => words.has(w));
};

const STAFF_ONLY = [
  'createdBy',
  'approvedBy',
  'submittedBy',
  'verifiedBy',
  'contentHash',
  'version',
];

describe('InvoiceView', () => {
  it('shows every field of an unpaid invoice, with the golden totals formatted with lakh grouping', () => {
    const html = renderToStaticMarkup(
      <InvoiceView view={sampleInvoice()} settlement={sampleSettlement()} />,
    );
    for (const text of [
      'INV-2083/84-00001',
      'Tax invoice',
      'Unpaid',
      '8 Dec 2026',
      'BS 2083-07-22',
      'Techrida Pvt. Ltd.',
      'Big Kahuna Burger Ltd.',
      'PAN/VAT 609876543',
      'Managed switch, 48 port',
      'NPR 18,80,000.00',
      '−NPR 94,000.00',
      'NPR 17,86,000.00',
      'VAT 13% on NPR 17,86,000.00',
      'NPR 2,32,180.00',
      'NPR 20,18,180.00',
      'Amount open',
      'aaaaaaaa',
    ]) {
      expect(html).toContain(text);
    }
    expect(forbiddenIn(html)).toEqual([]);
    for (const word of STAFF_ONLY) expect(html).not.toContain(word);
  });

  it('offers View PDF and a plain Download link to the BFF route, and says so when it is not ready', () => {
    const html = renderToStaticMarkup(
      <InvoiceView view={sampleInvoice()} settlement={sampleSettlement()} />,
    );
    expect(html).toContain('View PDF');
    expect(html).not.toContain('Download PDF');
    expect(html).toContain(`href="/invoices/${INVOICE_ID}/document"`);
    expect(html).not.toContain('/document/preview');
    const none = renderToStaticMarkup(
      <InvoiceView view={sampleInvoice({ file: null })} settlement={sampleSettlement()} />,
    );
    expect(none).not.toContain('/document"');
    expect(none).not.toContain('View PDF');
    expect(none).toContain('being prepared');
  });

  it('offers payment only while something is owed, and never on a credit note', () => {
    const owed = renderToStaticMarkup(
      <InvoiceView view={sampleInvoice()} settlement={sampleSettlement()} />,
    );
    expect(owed).toContain(`href="/payments/new?invoice=${INVOICE_ID}"`);
    const paid = renderToStaticMarkup(
      <InvoiceView
        view={sampleInvoice()}
        settlement={sampleSettlement({ settlement: 'paid', openAmount: '0.00' })}
      />,
    );
    expect(paid).toContain('Paid');
    expect(paid).not.toContain('Submit a payment');
    const note = renderToStaticMarkup(
      <InvoiceView view={sampleInvoice({ kind: 'credit_note' })} settlement={sampleSettlement()} />,
    );
    expect(note).toContain('Credit note');
    expect(note).not.toContain('Submit a payment');
    expect(canPay('debit_note', 'overdue')).toBe(true);
    expect(canPay('tax_invoice', 'credited')).toBe(false);
  });

  it('names an overdue invoice and the days late, from the server figures', () => {
    const html = renderToStaticMarkup(
      <InvoiceView
        view={sampleInvoice()}
        settlement={sampleSettlement({ settlement: 'overdue', daysOverdue: 1 })}
      />,
    );
    expect(html).toContain('Overdue');
    expect(html).toContain('1 day past its due date');
  });

  it('says the status is unavailable instead of guessing, and offers no payment', () => {
    const html = renderToStaticMarkup(<InvoiceView view={sampleInvoice()} settlement={null} />);
    expect(html).toContain('could not load the payment status');
    expect(html).not.toContain('Amount open');
    expect(html).not.toContain('Submit a payment');
  });

  it('copes with no due date, no discount, no tax lines and a very long description', () => {
    const long = 'Long description '.repeat(40);
    const html = renderToStaticMarkup(
      <InvoiceView
        view={sampleInvoice({
          dueDate: null,
          taxSummary: [],
          totals: { ...sampleInvoice().totals, discountAmount: '0.00' },
          lines: [{ ...sampleInvoice().lines[0]!, description: long }],
        })}
        settlement={sampleSettlement({ dueDate: null })}
      />,
    );
    expect(html).toContain('On receipt');
    expect(html).not.toContain('Discount');
    expect(html).toContain('>Tax<');
    expect(html).toContain(long.trim());
  });
});

describe('InvoiceList', () => {
  it('lists number, type, dates, total and open amount, with a plain link per invoice', () => {
    const html = renderToStaticMarkup(
      <InvoiceList
        items={[
          sampleListItem(),
          sampleListItem({
            id: '3f8fad5b-d9cb-469f-a165-70867728950e',
            kind: 'credit_note',
            number: 'CN-2083/84-00001',
            dueDate: null,
            currency: 'USD',
            total: '100.00',
            openAmount: '0.00',
          }),
        ]}
      />,
    );
    expect(html).toContain('Your invoices');
    expect(html).toContain(`href="/invoices/${INVOICE_ID}"`);
    expect(html).toContain('NPR 20,18,180.00');
    expect(html).toContain('Credit note');
    expect(html).toContain('USD 100.00');
    expect(html).toContain('—');
    expect(forbiddenIn(html)).toEqual([]);
  });
});
