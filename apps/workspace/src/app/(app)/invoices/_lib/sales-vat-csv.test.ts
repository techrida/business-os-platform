import { expect, it } from 'vitest';

import type { SalesVatRegister } from '@bos/contracts';

import { salesVatCsv } from './sales-vat-csv';

const base = {
  invoiceId: '11111111-1111-4111-8111-111111111111',
  kind: 'tax_invoice' as const,
  number: 'INV-1',
  issueDate: '2026-11-09',
  issueDateBs: '2083-07-23',
  buyerPan: null,
  currency: 'NPR' as const,
  taxableAmount: '1.00',
  vatAmount: '0.13',
  exemptAmount: '0.00',
  zeroRatedAmount: '0.00',
  totalAmount: '1.13',
  fxRate: '1.000000',
  nprTaxableAmount: '1.00',
  nprVatAmount: '0.13',
  nprExemptAmount: '0.00',
  nprZeroRatedAmount: '0.00',
  nprTotalAmount: '1.13',
};
const nprTotal = {
  documents: 1,
  taxableAmount: '1.00',
  vatAmount: '0.13',
  exemptAmount: '0.00',
  zeroRatedAmount: '0.00',
  totalAmount: '1.13',
};
const csv = (buyerName: string) =>
  salesVatCsv({
    from: '2026-11-01',
    to: '2026-11-30',
    rows: [{ ...base, buyerName }],
    totals: [],
    nprTotal,
  } satisfies SalesVatRegister);

it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx', ' =x'])(
  'neutralises a formula-looking buyer %j',
  (name) => {
    const row = csv(name).split('\r\n')[1] ?? '';
    expect(row).toContain(`,"'${name.replaceAll('"', '""')}",`);
  },
);

it('keeps an ordinary name, a negative number and quotes as they are', () => {
  expect(csv('Plain "Co", Ltd').split('\r\n')[1]).toContain(',"Plain ""Co"", Ltd",');
  expect(csv('-12.50').split('\r\n')[1]).toContain(',"-12.50",');
});
