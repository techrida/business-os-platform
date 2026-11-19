// Unit tests of the invoice detail mapper (no database): the detail carries the number and date format of the original
// print, so a screen draws the invoice the way its PDF reads.
import { InvoiceDetailSchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { firstPrintFormat, toInvoiceDetail } from './invoice-mapping';
import {
  issuedInvoiceRow,
  lineRow,
  printRow,
  STORED_FORMAT,
  taxRow,
  USER,
} from './invoice-test-rows';

const detail = (prints: Parameters<typeof toInvoiceDetail>[0]['prints']) =>
  InvoiceDetailSchema.parse(
    toInvoiceDetail({
      invoice: issuedInvoiceRow(),
      customerName: 'Buyer Ltd.',
      lines: [lineRow()],
      taxSummary: [taxRow()],
      prints,
    }),
  );

describe('toInvoiceDetail format', () => {
  it("carries print 1's stored format, even when print 1 has no user and a later copy has one", () => {
    const copy = printRow({
      id: '14141414-1414-4414-8414-141414141414',
      printNo: 2,
      printedBy: USER,
      renderFormat: null,
    });
    const d = detail([copy, printRow()]);
    expect(d.format).toEqual(STORED_FORMAT);
    // The prints list still leaves out the print with no user.
    expect(d.prints.map((p) => p.printNo)).toEqual([2]);
  });

  it('is null when the invoice was never printed', () => {
    expect(detail([]).format).toBeNull();
  });

  it('is null when print 1 predates the stored format (render_format NULL)', () => {
    expect(detail([printRow({ renderFormat: null })]).format).toBeNull();
  });

  it('is null when what print 1 stored does not validate, rather than failing the read', () => {
    expect(detail([printRow({ renderFormat: { dateFormat: 'whenever' } })]).format).toBeNull();
  });

  it('never takes a copy’s format for the original', () => {
    expect(firstPrintFormat([printRow({ printNo: 2 })])).toBeNull();
  });
});

describe('InvoiceDetailSchema', () => {
  it('still parses an older answer with no format key', () => {
    const { format: _dropped, ...older } = detail([printRow()]);
    expect(InvoiceDetailSchema.parse(older)).not.toHaveProperty('format');
  });
});
