import { describe, expect, it } from 'vitest';

import {
  EMPTY_VENDOR_VALUES,
  parseContact,
  parseCreateVendor,
  parseProposeBank,
  parseReason,
  parseUpdateVendor,
  type VendorValues,
} from './forms';

const company: VendorValues = {
  ...EMPTY_VENDOR_VALUES,
  legalName: '  Himal Traders Pvt. Ltd. ',
  kind: 'company',
  pan: '301234567',
  vatRegistered: true,
  country: 'np',
};

describe('parseCreateVendor', () => {
  it('trims, upper-cases the country and builds the contract body', () => {
    const r = parseCreateVendor(company);
    expect(r).toEqual({
      ok: true,
      data: {
        legalName: 'Himal Traders Pvt. Ltd.',
        kind: 'company',
        pan: '301234567',
        vatRegistered: true,
        country: 'NP',
      },
    });
  });

  it('needs a 9-digit PAN for every resident kind', () => {
    for (const kind of ['company', 'sole_proprietor', 'individual'] as const) {
      const r = parseCreateVendor({ ...company, kind, pan: '' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.pan).toMatch(/PAN is required/);
    }
    const short = parseCreateVendor({ ...company, pan: '12345' });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.errors.pan).toMatch(/9 digits/);
  });

  it('a foreign vendor may leave the PAN out and never sends one', () => {
    const r = parseCreateVendor({ ...company, kind: 'foreign', country: 'IN', pan: '301234567' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.pan).toBeUndefined();
      expect(r.data.country).toBe('IN');
    }
  });

  it('refuses a foreign vendor in Nepal and a resident kind abroad, on the country field', () => {
    const a = parseCreateVendor({ ...company, kind: 'foreign', country: 'NP' });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.errors.country).toMatch(/outside Nepal/);
    const b = parseCreateVendor({ ...company, country: 'IN' });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.errors.country).toMatch(/foreign/i);
  });

  it('names the legal name and the country code', () => {
    const r = parseCreateVendor({ ...company, legalName: '   ', country: 'Nepal' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.legalName).toMatch(/legal name/i);
      expect(r.errors.country).toMatch(/two-letter/);
    }
  });

  it('keeps the trade name only when typed', () => {
    const r = parseCreateVendor({ ...company, tradeName: ' Himal ' });
    expect(r.ok && r.data.tradeName).toBe('Himal');
  });
});

describe('parseUpdateVendor', () => {
  const original = {
    legalName: 'Himal Traders Pvt. Ltd.',
    pan: '301234567',
    vatRegistered: false,
    status: 'draft' as const,
  };
  const values = (over: Partial<VendorValues>): VendorValues => ({
    ...company,
    legalName: original.legalName,
    ...over,
  });

  it('sends only what changed, with the version the person saw', () => {
    const r = parseUpdateVendor(values({ vatRegistered: true }), original, 4);
    expect(r).toEqual({ ok: true, data: { expectedVersion: 4, vatRegistered: true } });
  });

  it('says nothing changed', () => {
    const r = parseUpdateVendor(values({ vatRegistered: false }), original, 4);
    expect(r).toEqual({ ok: false, nothingChanged: true });
  });

  it('ignores a legal name or PAN edit on an approved vendor (the API would answer 409)', () => {
    const r = parseUpdateVendor(
      values({ legalName: 'Other', pan: '999999999', vatRegistered: true }),
      { ...original, status: 'approved' },
      2,
    );
    expect(r).toEqual({ ok: true, data: { expectedVersion: 2, vatRegistered: true } });
  });

  it('checks the PAN rule on edit', () => {
    const r = parseUpdateVendor(values({ pan: '12' }), original, 1);
    expect(r.ok).toBe(false);
    if (!r.ok && 'errors' in r) expect(r.errors.pan).toMatch(/9 digits/);
  });
});

describe('parseContact', () => {
  const base = { name: ' Sita Sharma ', email: '', phone: '', role: '', isPortalAdmin: false };
  it('needs only a name', () => {
    expect(parseContact(base)).toEqual({
      ok: true,
      data: { name: 'Sita Sharma', isPortalAdmin: false },
    });
  });
  it('words a bad email and phone', () => {
    const r = parseContact({ ...base, email: 'nope', phone: '98123' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.email).toMatch(/email/i);
      expect(r.errors.phone).toMatch(/\+/);
    }
  });
});

describe('parseProposeBank', () => {
  const base = {
    bankName: 'Nabil Bank',
    branch: '',
    accountName: 'Himal Traders',
    accountNumber: '0011 2233 4455',
    swift: '',
  };
  it('strips spaces from the account number, as the API does', () => {
    const r = parseProposeBank(base);
    expect(r).toEqual({
      ok: true,
      data: { bankName: 'Nabil Bank', accountName: 'Himal Traders', accountNumber: '001122334455' },
    });
  });
  it('words short numbers and bad SWIFT codes', () => {
    const r = parseProposeBank({ ...base, accountNumber: '123', swift: 'ABC' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.accountNumber).toMatch(/6 to 34/);
      expect(r.errors.swift).toMatch(/8 or 11/);
    }
  });
});

describe('parseReason', () => {
  it('needs a reason of at most 500 characters', () => {
    expect(parseReason('  ')).toEqual({
      ok: false,
      error: 'Say why, so the audit trail keeps it.',
    });
    expect(parseReason('x'.repeat(501)).ok).toBe(false);
    expect(parseReason(' Unpaid dues ')).toEqual({ ok: true, data: 'Unpaid dues' });
  });
});
