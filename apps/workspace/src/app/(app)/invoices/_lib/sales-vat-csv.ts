import type { SalesVatRegister } from '@bos/contracts';

/** Quote every cell and keep buyer-supplied text from becoming a spreadsheet formula (same rule as the purchase CSV). */
function cell(value: string | null): string {
  let text = value ?? '';
  if (/^[\t\r]/.test(text) || (!/^-?\d+(?:\.\d+)?$/.test(text) && /^\s*[=+@-]/.test(text)))
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

const KIND_LABEL = {
  tax_invoice: 'Tax invoice',
  credit_note: 'Credit note',
  debit_note: 'Debit note',
} as const;

/**
 * The Nepal sales book as CSV: one row per issued document, amounts in the document's own currency, credit notes
 * negative, then the same amounts in NPR at the rate frozen at issue. Totals are one row per currency, never added across
 * currencies, and one last row adds the NPR equivalents of every currency for the filing.
 */
const BOM = String.fromCodePoint(0xfeff);

export function salesVatCsv(register: SalesVatRegister): string {
  const header = [
    'Date (BS)',
    'Date (AD)',
    'Document',
    'Invoice number',
    'Buyer',
    'Buyer PAN',
    'Currency',
    'Taxable amount',
    'VAT',
    'Exempt amount',
    'Zero-rated amount',
    'Total',
    'Rate to NPR',
    'NPR taxable amount',
    'NPR VAT',
    'NPR exempt amount',
    'NPR zero-rated amount',
    'NPR total',
  ];
  const rows: (string | null)[][] = [
    header,
    ...register.rows.map((row) => [
      row.issueDateBs,
      row.issueDate,
      KIND_LABEL[row.kind],
      row.number,
      row.buyerName,
      row.buyerPan,
      row.currency,
      row.taxableAmount,
      row.vatAmount,
      row.exemptAmount,
      row.zeroRatedAmount,
      row.totalAmount,
      row.fxRate,
      row.nprTaxableAmount,
      row.nprVatAmount,
      row.nprExemptAmount,
      row.nprZeroRatedAmount,
      row.nprTotalAmount,
    ]),
    ...register.totals.map((t) => [
      `Total ${t.currency}`,
      '',
      '',
      '',
      '',
      '',
      t.currency,
      t.taxableAmount,
      t.vatAmount,
      t.exemptAmount,
      t.zeroRatedAmount,
      t.totalAmount,
      '',
      '',
      '',
      '',
      '',
      '',
    ]),
    [
      'Total NPR (all currencies)',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      register.nprTotal.taxableAmount,
      register.nprTotal.vatAmount,
      register.nprTotal.exemptAmount,
      register.nprTotal.zeroRatedAmount,
      register.nprTotal.totalAmount,
    ],
  ];
  return `${BOM}${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}
