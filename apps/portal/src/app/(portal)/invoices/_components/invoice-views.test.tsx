import { CUSTOMER_VIEW_FORBIDDEN_WORDS, type PortalDisplay } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  INVOICE_ID,
  sampleFormat,
  sampleInvoice,
  sampleListItem,
  sampleSettlement,
} from './invoice-fixtures';
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
      '22 Kartik 2083 BS',
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

describe('InvoiceView as the printed invoice', () => {
  /** What the company uses today: lakh grouping and `8 Nov 2026` dates. */
  const TODAY: PortalDisplay = {
    numberSystems: { NPR: 'south_asian', INR: 'south_asian', USD: 'international' },
    dateFormat: 'dd MMM yyyy',
  };
  const INTERNATIONAL = {
    NPR: 'international',
    INR: 'international',
    USD: 'international',
  } as const;

  it("draws numbers, dates and words with the first print's format, not today's setting", () => {
    const html = renderToStaticMarkup(
      <InvoiceView
        view={sampleInvoice({
          format: sampleFormat({ numberSystems: INTERNATIONAL, dateFormat: 'dd/MM/yyyy' }),
        })}
        settlement={sampleSettlement()}
        display={TODAY}
      />,
    );
    for (const text of [
      '08/11/2026',
      '08/12/2026',
      'NPR 1,880,000.00',
      'NPR 2,018,180.00',
      'Two Million Eighteen Thousand One Hundred Eighty Rupees Only',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain('20,18,180');
    expect(html).not.toContain('8 Nov 2026');
    expect(html).not.toContain('Lakh');
  });

  it('falls back to the company display when the invoice has no stored format', () => {
    const company: PortalDisplay = { numberSystems: INTERNATIONAL, dateFormat: 'yyyy-MM-dd' };
    const { format: _omitted, ...older } = sampleInvoice();
    for (const view of [sampleInvoice({ format: null }), older]) {
      const html = renderToStaticMarkup(
        <InvoiceView view={view} settlement={sampleSettlement()} display={company} />,
      );
      expect(html).toContain('NPR 2,018,180.00');
      expect(html).toContain('2026-11-08');
      expect(html).toContain('Two Million Eighteen Thousand');
    }
    const plain = renderToStaticMarkup(
      <InvoiceView view={sampleInvoice({ format: null })} settlement={sampleSettlement()} />,
    );
    expect(plain).toContain('NPR 20,18,180.00');
    expect(plain).toContain('8 Nov 2026');
  });

  it('spells the total in words in the currency and grouping of the invoice', () => {
    const html = renderToStaticMarkup(
      <InvoiceView view={sampleInvoice()} settlement={sampleSettlement()} />,
    );
    expect(html).toContain('Twenty Lakh Eighteen Thousand One Hundred Eighty Rupees Only');
    const usd = renderToStaticMarkup(
      <InvoiceView
        view={sampleInvoice({
          currency: 'USD',
          totals: { ...sampleInvoice().totals, total: '1500.50' },
        })}
        settlement={sampleSettlement({ currency: 'USD', openAmount: '1500.50' })}
      />,
    );
    expect(usd).toContain('One Thousand Five Hundred Dollars And Fifty Cents Only');
  });

  it('shows exempt and zero-rated amounts only when they are not zero', () => {
    const html = renderToStaticMarkup(
      <InvoiceView
        view={sampleInvoice({
          totals: {
            ...sampleInvoice().totals,
            exemptAmount: '50000.00',
            zeroRatedAmount: '25000.00',
          },
        })}
        settlement={sampleSettlement()}
      />,
    );
    expect(html).toContain('Exempt amount');
    expect(html).toContain('NPR 50,000.00');
    expect(html).toContain('Zero-rated amount');
    expect(html).toContain('NPR 25,000.00');
    const { exemptAmount: _e, zeroRatedAmount: _z, ...olderTotals } = sampleInvoice().totals;
    for (const totals of [sampleInvoice().totals, olderTotals]) {
      const none = renderToStaticMarkup(
        <InvoiceView view={sampleInvoice({ totals })} settlement={sampleSettlement()} />,
      );
      expect(none).not.toContain('Exempt');
      expect(none).not.toContain('Zero-rated');
    }
  });

  it("prints the seller's phones, email and signatory, and omits them without a contact", () => {
    const html = renderToStaticMarkup(
      <InvoiceView view={sampleInvoice()} settlement={sampleSettlement()} />,
    );
    for (const text of [
      '+977 1 5551234',
      '+977 9801234567',
      'href="tel:+97715551234"',
      'href="mailto:accounts@techrida.example"',
      'Amanda Vance',
      'Finance Manager',
      'Jhamsikhel Road, Lalitpur',
      'PAN/VAT 601234567',
    ]) {
      expect(html).toContain(text);
    }
    const { sellerContact: _c, ...older } = sampleInvoice();
    for (const view of [sampleInvoice({ sellerContact: null }), older]) {
      const none = renderToStaticMarkup(
        <InvoiceView view={view} settlement={sampleSettlement()} />,
      );
      for (const text of ['5551234', 'mailto:', 'Amanda Vance', 'Finance Manager', 'signatory']) {
        expect(none).not.toContain(text);
      }
      expect(none).toContain('Jhamsikhel Road, Lalitpur');
      expect(none).toContain('PAN/VAT 601234567');
    }
    const bare = renderToStaticMarkup(
      <InvoiceView
        view={sampleInvoice({
          sellerContact: { phones: [], email: null, signatoryName: null, signatoryTitle: null },
        })}
        settlement={sampleSettlement()}
      />,
    );
    expect(bare).not.toContain('mailto:');
    expect(bare).not.toContain('tel:');
    expect(bare).not.toContain('signatory');
  });

  it('writes the frozen issue date in the long BS form, never the compact one (U16-Q5)', () => {
    const html = renderToStaticMarkup(
      <InvoiceView view={sampleInvoice()} settlement={sampleSettlement()} />,
    );
    expect(html).toContain('22 Kartik 2083 BS');
    expect(html).not.toContain('2083-07-22');
  });

  it('gives the due date its Bikram Sambat date, and the Gregorian date alone out of range', () => {
    const html = renderToStaticMarkup(
      <InvoiceView view={sampleInvoice()} settlement={sampleSettlement()} />,
    );
    expect(html).toContain('22 Mangsir 2083 BS');
    const far = renderToStaticMarkup(
      <InvoiceView
        view={sampleInvoice({ dueDate: '2040-01-01' })}
        settlement={sampleSettlement({ dueDate: '2040-01-01' })}
      />,
    );
    expect(far).toContain('<dt>Due date</dt><dd>01 Jan 2040</dd>');
  });

  it('titles the document by its kind and names the balance to match', () => {
    const tax = renderToStaticMarkup(
      <InvoiceView view={sampleInvoice()} settlement={sampleSettlement()} />,
    );
    expect(tax).toContain('Invoice to');
    expect(tax).toContain('Invoice total');
    const note = renderToStaticMarkup(
      <InvoiceView view={sampleInvoice({ kind: 'credit_note' })} settlement={sampleSettlement()} />,
    );
    expect(note).toContain('Credit note');
    expect(note).toContain('Total credited');
    expect(note).not.toContain('Invoice total');
    // A credit note owes nothing: no payment-due copy under its credited total.
    const undated = renderToStaticMarkup(
      <InvoiceView
        view={sampleInvoice({ kind: 'credit_note', dueDate: null })}
        settlement={sampleSettlement()}
      />,
    );
    expect(undated).not.toContain('Due on receipt');
    const taxUndated = renderToStaticMarkup(
      <InvoiceView view={sampleInvoice({ dueDate: null })} settlement={sampleSettlement()} />,
    );
    expect(taxUndated).toContain('Due on receipt');
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
