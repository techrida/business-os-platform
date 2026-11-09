import type { VatRegister } from '@/lib/api-payables';

/** Quote every cell and keep vendor-supplied text from becoming a spreadsheet formula. */
function cell(value: string | null): string {
  let text = value ?? '';
  if (/^[\t\r]/.test(text) || (!/^-?\d+(?:\.\d+)?$/.test(text) && /^\s*[=+@-]/.test(text)))
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function vatCsv(register: VatRegister): string {
  const rows: (string | null)[][] = [
    [
      'PAN',
      'Vendor',
      'Invoice number',
      'Invoice date (BS)',
      'Invoice date (AD)',
      'Taxable amount (NPR)',
      'VAT (NPR)',
    ],
    ...register.rows.map((row) => [
      row.vendorPan,
      row.vendorName,
      row.vendorInvoiceNo,
      row.invoiceDateBs,
      row.invoiceDate,
      row.taxableAmount,
      row.vatAmount,
    ]),
    ['Total', '', '', '', '', register.total.taxableAmount, register.total.vatAmount],
  ];
  return `\uFEFF${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}
