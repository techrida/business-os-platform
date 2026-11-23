import type { VendorKind } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_VENDOR_VALUES,
  parseContact,
  parseCreateVendor,
  parseProposeBank,
  parseReason,
  parseUpdateVendor,
  readContactValues,
  readPhones,
  readVendorValues,
  type ContactValues,
  type VendorValues,
} from './forms';

const formOf = (entries: [string, string][]): FormData => {
  const form = new FormData();
  for (const [key, value] of entries) form.append(key, value);
  return form;
};

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

  it('a foreign vendor may leave the tax ID out', () => {
    const r = parseCreateVendor({ ...company, kind: 'foreign', country: 'IN', pan: '' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.pan).toBeUndefined();
      expect(r.data.country).toBe('IN');
    }
  });

  it('a foreign vendor with a loose tax ID and an address builds the body', () => {
    const r = parseCreateVendor({
      ...company,
      kind: 'foreign',
      country: 'US',
      pan: '12-3456789',
      addressLine: ' 500 Howard Street, Suite 2 ',
      addressCity: ' San Francisco ',
    });
    expect(r).toEqual({
      ok: true,
      data: {
        legalName: 'Himal Traders Pvt. Ltd.',
        kind: 'foreign',
        pan: '12-3456789',
        vatRegistered: true,
        country: 'US',
        address: { line: '500 Howard Street, Suite 2', city: 'San Francisco' },
      },
    });
  });

  it('refuses a foreign tax ID outside the loose shape', () => {
    const r = parseCreateVendor({ ...company, kind: 'foreign', country: 'US', pan: 'A1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.pan).toMatch(/5 to 20/);
  });

  it('refuses half an address, on the missing field', () => {
    const lineOnly = parseCreateVendor({ ...company, addressLine: 'Thamel Marg' });
    expect(lineOnly.ok).toBe(false);
    if (!lineOnly.ok) expect(lineOnly.errors.addressCity).toMatch(/city too/);
    const cityOnly = parseCreateVendor({ ...company, addressCity: 'Kathmandu' });
    expect(cityOnly.ok).toBe(false);
    if (!cityOnly.ok) expect(cityOnly.errors.addressLine).toMatch(/street address too/);
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
      expect(r.errors.country).toMatch(/Choose the vendor’s country/);
    }
  });

  it('keeps the trade name only when typed', () => {
    const r = parseCreateVendor({ ...company, tradeName: ' Himal ' });
    expect(r.ok && r.data.tradeName).toBe('Himal');
  });
});

describe('readVendorValues', () => {
  it('reads the address and the country from the address fields', () => {
    const v = readVendorValues(
      formOf([
        ['legalName', 'Acme Inc.'],
        ['kind', 'foreign'],
        ['pan', '12-3456789'],
        ['address.line', '500 Howard Street'],
        ['address.city', 'San Francisco'],
        ['address.country', 'US'],
      ]),
    );
    expect(v).toMatchObject({
      country: 'US',
      addressLine: '500 Howard Street',
      addressCity: 'San Francisco',
      vatRegistered: false,
    });
  });
});

describe('parseUpdateVendor', () => {
  const original = {
    legalName: 'Himal Traders Pvt. Ltd.',
    kind: 'company' as VendorKind,
    pan: '301234567' as string | null,
    vatRegistered: false,
    status: 'draft' as const,
    country: 'NP',
    address: null as { line: string; city: string } | null,
  };
  const values = (over: Partial<VendorValues>): VendorValues => ({
    ...company,
    legalName: original.legalName,
    vatRegistered: original.vatRegistered,
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

  it('holds a foreign vendor to the loose tax-id shape, by its stored country', () => {
    const foreign = { ...original, kind: 'foreign' as VendorKind, country: 'US', pan: null };
    const asForeign = (over: Partial<VendorValues>) =>
      values({ kind: 'foreign', country: 'US', ...over });
    const ok = parseUpdateVendor(asForeign({ pan: 'EIN-1234567' }), foreign, 3);
    expect(ok).toEqual({ ok: true, data: { expectedVersion: 3, pan: 'EIN-1234567' } });
    const cleared = parseUpdateVendor(
      asForeign({ pan: '' }),
      { ...foreign, pan: 'EIN-1234567' },
      3,
    );
    // R6AA: an unapproved foreign vendor may clear its tax id; the API takes null.
    expect(cleared).toEqual({ ok: true, data: { expectedVersion: 3, pan: null } });
  });

  describe('D10: the kind and country', () => {
    const foreign = { ...original, kind: 'foreign' as VendorKind, country: 'DE', pan: null };
    const asForeign = (over: Partial<VendorValues>) =>
      values({ kind: 'foreign', country: 'DE', ...over });
    const errorsOf = (r: ReturnType<typeof parseUpdateVendor>) =>
      !r.ok && 'errors' in r ? r.errors : {};

    it('sends the kind and country together when either changed, and keeps the PAN it has', () => {
      const r = parseUpdateVendor(values({ kind: 'foreign', country: 'IN' }), original, 6);
      expect(r).toEqual({ ok: true, data: { expectedVersion: 6, kind: 'foreign', country: 'IN' } });
      const kinds = parseUpdateVendor(values({ kind: 'sole_proprietor' }), original, 6);
      expect(kinds).toEqual({
        ok: true,
        data: { expectedVersion: 6, kind: 'sole_proprietor', country: 'NP' },
      });
    });

    it('stops a switch to Nepal with no PAN, or with the foreign tax id left in the box', () => {
      const none = parseUpdateVendor(
        asForeign({ kind: 'company', country: 'NP', pan: '' }),
        foreign,
        2,
      );
      expect(errorsOf(none).pan).toMatch(/PAN is required/);
      const loose = parseUpdateVendor(
        values({ kind: 'company', country: 'NP', pan: 'DE-81234567' }),
        { ...foreign, pan: 'DE-81234567' },
        2,
      );
      expect(errorsOf(loose).pan).toMatch(/9 digits/);
      const ok = parseUpdateVendor(
        values({ kind: 'company', country: 'NP', pan: '301234568' }),
        foreign,
        2,
      );
      expect(ok).toEqual({
        ok: true,
        data: { expectedVersion: 2, kind: 'company', country: 'NP', pan: '301234568' },
      });
    });

    it('refuses a kind and country that contradict, on the country', () => {
      const r = parseUpdateVendor(values({ kind: 'foreign', country: 'NP' }), original, 2);
      expect(errorsOf(r).country).toMatch(/foreign vendor is outside Nepal/);
      const other = parseUpdateVendor(values({ kind: 'company', country: 'IN' }), original, 2);
      expect(errorsOf(other).country).toMatch(/must be a foreign vendor/);
    });

    it('ignores a posted kind and country on an approved vendor (the API would answer 409)', () => {
      const r = parseUpdateVendor(
        values({ kind: 'foreign', country: 'IN', vatRegistered: true }),
        { ...original, status: 'approved' },
        2,
      );
      expect(r).toEqual({ ok: true, data: { expectedVersion: 2, vatRegistered: true } });
      // A locked form posts neither: the empty values are not read as a change.
      const locked = parseUpdateVendor(
        values({ kind: '', country: '', vatRegistered: true }),
        { ...original, status: 'suspended' },
        2,
      );
      expect(locked).toEqual({ ok: true, data: { expectedVersion: 2, vatRegistered: true } });
    });
  });

  it('sends a new address, and null when it is cleared', () => {
    const added = parseUpdateVendor(
      values({ pan: '301234567', addressLine: 'Thamel Marg', addressCity: 'Kathmandu' }),
      original,
      5,
    );
    expect(added).toEqual({
      ok: true,
      data: { expectedVersion: 5, address: { line: 'Thamel Marg', city: 'Kathmandu' } },
    });
    const cleared = parseUpdateVendor(
      values({}),
      { ...original, address: { line: 'Thamel Marg', city: 'Kathmandu' } },
      5,
    );
    expect(cleared).toEqual({ ok: true, data: { expectedVersion: 5, address: null } });
    const half = parseUpdateVendor(values({ addressLine: 'Thamel Marg' }), original, 5);
    expect(half.ok).toBe(false);
    if (!half.ok && 'errors' in half) expect(half.errors.addressCity).toMatch(/city too/);
  });
});

describe('parseContact', () => {
  const base: ContactValues = {
    name: ' Sita Sharma ',
    email: '',
    country: 'NP',
    phones: [],
    role: '',
    isPortalAdmin: false,
  };
  it('needs only a name and a country', () => {
    expect(parseContact(base)).toEqual({
      ok: true,
      data: { name: 'Sita Sharma', country: 'NP', phones: [], isPortalAdmin: false },
    });
  });
  it('words a bad email and a bad phone, naming the row', () => {
    const r = parseContact({
      ...base,
      email: 'nope',
      phones: [{ country: 'NP', e164: '+97798123', label: null, isPrimary: true }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.email).toMatch(/email/i);
      expect(r.errors.phones).toMatch(/^Phone 1: /);
    }
  });
  it('posts two phones in different countries, read from the form', () => {
    const r = parseContact(
      readContactValues(
        formOf([
          ['name', 'John Doe'],
          ['country', 'US'],
          ['phones.0.country', 'US'],
          ['phones.0.number', '+14155552671'],
          ['phones.0.label', 'work'],
          ['phones.0.isPrimary', 'true'],
          ['phones.1.country', 'NP'],
          ['phones.1.number', '+9779812345678'],
          ['phones.1.label', ''],
          ['phones.1.isPrimary', 'false'],
        ]),
      ),
    );
    expect(r).toEqual({
      ok: true,
      data: {
        name: 'John Doe',
        country: 'US',
        phones: [
          { country: 'US', e164: '+14155552671', label: 'work', isPrimary: true },
          { country: 'NP', e164: '+9779812345678', isPrimary: false },
        ],
        isPortalAdmin: false,
      },
    });
  });
});

describe('readPhones', () => {
  it('drops blank rows and keeps one primary', () => {
    const phones = readPhones(
      formOf([
        ['phones.0.country', 'NP'],
        ['phones.0.number', ''],
        ['phones.0.isPrimary', 'true'],
        ['phones.1.country', 'IN'],
        ['phones.1.number', '+919812345678'],
        ['phones.1.isPrimary', 'false'],
      ]),
      'phones',
    );
    expect(phones).toEqual([
      { country: 'IN', e164: '+919812345678', label: null, isPrimary: true },
    ]);
  });
  it('keeps a row with an invalid number for the contracts to refuse', () => {
    const phones = readPhones(
      formOf([
        ['phones.0.country', 'NP'],
        ['phones.0.number', '+97798'],
        ['phones.0.isPrimary', 'true'],
      ]),
      'phones',
    );
    expect(phones).toHaveLength(1);
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
