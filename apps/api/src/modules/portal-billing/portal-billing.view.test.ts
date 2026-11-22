// Unit tests of the strict customer invoice view (no database): it carries what the PDF prints (the exempt and
// zero-rated amounts, the original print's number and date format) and a seller contact cut from the company profile,
// and nothing else of the profile.
import { CustomerInvoiceViewSchema, EMPTY_COMPANY_PROFILE } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { firstPrintFormat } from '../invoices/invoice-mapping';
import {
  issuedInvoiceRow,
  lineRow,
  printRow,
  STORED_FORMAT,
  taxRow,
} from '../invoices/invoice-test-rows';
import { toCustomerInvoiceView, toSellerContact } from './portal-billing.service';

const PROFILE = {
  displayName: 'Techrida',
  logoDocumentId: null,
  // Each phone is its country and E.164 number (FX9); the contact carries it formatted for print.
  phones: [
    { country: 'NP', e164: '+97715550100', label: 'landline' },
    { country: 'NP', e164: '+9779800000000', label: 'mobile' },
  ],
  email: 'billing@techrida.example',
  website: 'https://techrida.example',
  panVatNo: '301234567',
  signatoryName: 'Asha Shrestha',
  signatoryTitle: 'Director',
};

describe('toCustomerInvoiceView', () => {
  it('carries the exempt and zero-rated amounts, the stored format and the seller contact', () => {
    const view = toCustomerInvoiceView(issuedInvoiceRow(), [lineRow()], [taxRow()], null, {
      format: firstPrintFormat([printRow()]),
      sellerContact: toSellerContact(PROFILE),
    });
    expect(view.totals).toEqual({
      subtotal: '1500.00',
      discountAmount: '0.00',
      taxableAmount: '1000.00',
      exemptAmount: '300.00',
      zeroRatedAmount: '200.00',
      taxAmount: '130.00',
      total: '1630.00',
    });
    expect(view.format).toEqual(STORED_FORMAT);
    expect(view.sellerContact).toEqual({
      phones: ['+977 1-5550100', '+977 9800000000'],
      email: 'billing@techrida.example',
      signatoryName: 'Asha Shrestha',
      signatoryTitle: 'Director',
    });
    // No staff field and no other profile field rides along.
    const json = JSON.stringify(view);
    for (const leak of [
      'amountNpr',
      'fxRate',
      'contentHash',
      'logoDataUrl',
      'website',
      'Techrida"',
    ]) {
      expect(json).not.toContain(leak);
    }
  });

  it('answers a null format for an invoice never printed, and an empty contact for a fresh profile', () => {
    const view = toCustomerInvoiceView(issuedInvoiceRow(), [lineRow()], [taxRow()], null, {
      format: firstPrintFormat([]),
      sellerContact: toSellerContact(EMPTY_COMPANY_PROFILE),
    });
    expect(view.format).toBeNull();
    expect(view.sellerContact).toEqual({
      phones: [],
      email: null,
      signatoryName: null,
      signatoryTitle: null,
    });
  });
});

describe('toSellerContact', () => {
  it('is null for a stored profile that does not validate', () => {
    expect(toSellerContact({ phones: 'not a list' })).toBeNull();
    expect(toSellerContact(undefined)).toBeNull();
  });
});

describe('CustomerInvoiceViewSchema', () => {
  it('still parses an older answer without the new keys', () => {
    const view = toCustomerInvoiceView(issuedInvoiceRow(), [lineRow()], [taxRow()], null, {
      format: null,
      sellerContact: null,
    });
    const { format: _f, sellerContact: _s, ...older } = view;
    const { exemptAmount: _e, zeroRatedAmount: _z, ...olderTotals } = older.totals;
    expect(() => CustomerInvoiceViewSchema.parse({ ...older, totals: olderTotals })).not.toThrow();
  });

  it('refuses a contact block with an extra key, such as the logo', () => {
    const view = toCustomerInvoiceView(issuedInvoiceRow(), [lineRow()], [taxRow()], null, {
      format: null,
      sellerContact: null,
    });
    const withLogo = {
      ...view,
      sellerContact: { ...toSellerContact(PROFILE), logoDataUrl: 'data:image/png;base64,AAAA' },
    };
    expect(CustomerInvoiceViewSchema.safeParse(withLogo).success).toBe(false);
  });
});
