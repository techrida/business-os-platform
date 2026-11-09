import { describe, expect, it } from 'vitest';

import { vatCsv } from './vat-csv';

describe('purchase VAT register CSV', () => {
  it('exports PAN, invoice, BS date and the API totals without recomputing money', () => {
    const result = vatCsv({
      from: '2026-11-01',
      to: '2026-11-30',
      rows: [
        {
          vendorBillId: 'bill',
          billNumber: 'BILL-1',
          vendorPartyId: 'vendor',
          vendorName: 'Himal, "Traders"',
          vendorPan: '123456789',
          vendorInvoiceNo: 'INV-1',
          invoiceDate: '2026-11-09',
          invoiceDateBs: '2083-07-23',
          taxableAmount: '100000.00',
          vatAmount: '13000.00',
        },
      ],
      total: { taxableAmount: '100000.00', vatAmount: '13000.00' },
    });
    expect(result).toContain('"PAN","Vendor","Invoice number","Invoice date (BS)"');
    expect(result).toContain(
      '"123456789","Himal, ""Traders""","INV-1","2083-07-23","2026-11-09","100000.00","13000.00"',
    );
    expect(result).toContain('"Total","","","","","100000.00","13000.00"');
  });

  it('neutralizes spreadsheet formulas even after whitespace and escapes embedded newlines', () => {
    const result = vatCsv({
      from: '2026-11-01',
      to: '2026-11-30',
      rows: [
        {
          vendorBillId: 'bill',
          billNumber: null,
          vendorPartyId: 'vendor',
          vendorName: ' =HYPERLINK("x")',
          vendorPan: null,
          vendorInvoiceNo: '@SUM(1)\nnext',
          invoiceDate: '2026-11-09',
          invoiceDateBs: '2083-07-23',
          taxableAmount: '-1.00',
          vatAmount: '-0.13',
        },
      ],
      total: { taxableAmount: '-1.00', vatAmount: '-0.13' },
    });
    expect(result).toContain('"\' =HYPERLINK(""x"")"');
    expect(result).toContain('"\'@SUM(1)\nnext"');
    expect(result).toContain('"-1.00","-0.13"');
    expect(result.endsWith('\r\n')).toBe(true);
  });
});
