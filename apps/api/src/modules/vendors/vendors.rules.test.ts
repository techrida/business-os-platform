// Unit tests of the pure vendor rules (no database).
import {
  CreateVendorBodySchema,
  PartyPhonesSchema,
  VENDOR_KINDS,
  VENDOR_STATUSES,
  canTransitionVendor,
  type VendorStatus,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  addressColumns,
  addressFromRow,
  isoDay,
  kindCountryProblem,
  kybReadyForReview,
  kindFromRow,
  kindToRow,
  lapsedTaxClearance,
  LIFECYCLE,
  lifecycleAllowed,
  phoneRowsOf,
  phonesOfRows,
  rowCountry,
  sameNameVendors,
  submitKycMove,
  vendorPanProblem,
  vendorPartyCode,
  vendorNameKey,
  type LifecycleCommand,
} from './vendors.rules';

describe('kind mapping', () => {
  it('maps the sole proprietor to the table value and back, and leaves the others alone', () => {
    expect(kindToRow('sole_proprietor')).toBe('proprietor');
    expect(kindFromRow('proprietor')).toBe('sole_proprietor');
    for (const kind of VENDOR_KINDS) expect(kindFromRow(kindToRow(kind))).toBe(kind);
  });
});

describe('vendorPanProblem (FX9)', () => {
  it('holds a Nepal vendor to nine digits and lets a foreign vendor keep a loose tax id', () => {
    expect(vendorPanProblem('NP', '123456789')).toBeUndefined();
    expect(vendorPanProblem('NP', '12345')).toMatch(/9 digits/);
    expect(vendorPanProblem('NP', 'AB1234567')).toMatch(/9 digits/);
    expect(vendorPanProblem('DE', 'DE-123456789')).toBeUndefined();
    expect(vendorPanProblem('US', '12345')).toBeUndefined();
    expect(vendorPanProblem('NP', undefined)).toBeUndefined();
    expect(vendorPanProblem('NP', null)).toBeUndefined();
  });
});

describe('vendor address (FX9)', () => {
  it('maps line and city to the two columns and back, and no address to both null', () => {
    const address = { line: 'Thamel Marg 12', city: 'Kathmandu' };
    const columns = addressColumns(address);
    expect(columns).toEqual({ addressLine: 'Thamel Marg 12', addressCity: 'Kathmandu' });
    expect(addressFromRow(columns)).toEqual(address);
    expect(addressColumns(null)).toEqual({ addressLine: null, addressCity: null });
    expect(addressColumns(undefined)).toEqual({ addressLine: null, addressCity: null });
    expect(addressFromRow({ addressLine: null, addressCity: null })).toBeNull();
  });

  it('refuses an address with only a line, or only a city, on create', () => {
    const base = {
      legalName: 'Himal Traders',
      kind: 'company',
      pan: '123456789',
      vatRegistered: true,
    };
    const ok = { ...base, country: 'NP', address: { line: 'Thamel Marg 12', city: 'Kathmandu' } };
    expect(CreateVendorBodySchema.safeParse(ok).success).toBe(true);
    expect(CreateVendorBodySchema.safeParse({ ...base, country: 'NP' }).success).toBe(true);
    for (const address of [
      { line: 'Thamel Marg 12' },
      { city: 'Kathmandu' },
      { line: ' ', city: 'Kathmandu' },
    ]) {
      expect(
        CreateVendorBodySchema.safeParse({ ...ok, address }).success,
        JSON.stringify(address),
      ).toBe(false);
    }
  });
});

describe('contact phones (FX9)', () => {
  const phones = PartyPhonesSchema.parse([
    { country: 'US', e164: '+14155552671', label: 'work', isPrimary: false },
    { country: 'NP', e164: '+9779812345678', isPrimary: true },
  ]);

  it('stores the list in the order sent and reads it back primary first, with each country kept', () => {
    const rows = phoneRowsOf(phones);
    expect(rows).toEqual([
      { country: 'US', e164: '+14155552671', label: 'work', sortOrder: 0, isPrimary: false },
      { country: 'NP', e164: '+9779812345678', label: null, sortOrder: 1, isPrimary: true },
    ]);
    expect(phonesOfRows([...rows].reverse())).toEqual([
      { country: 'NP', e164: '+9779812345678', label: null, isPrimary: true },
      { country: 'US', e164: '+14155552671', label: 'work', isPrimary: false },
    ]);
  });

  it('refuses a stored country the contract does not know', () => {
    expect(rowCountry('NP')).toBe('NP');
    expect(() => rowCountry('XX')).toThrow(/unknown country/);
  });
});

describe('kindCountryProblem', () => {
  it('ties foreign to a country other than NP, as the 0032 CHECK does', () => {
    expect(kindCountryProblem('company', 'NP')).toBeUndefined();
    expect(kindCountryProblem('foreign', 'IN')).toBeUndefined();
    expect(kindCountryProblem('foreign', 'NP')).toMatch(/foreign/);
    expect(kindCountryProblem('company', 'IN')).toMatch(/foreign/);
  });
});

describe('vendorPartyCode', () => {
  it('is VEN- and 12 hex digits of the id', () => {
    expect(vendorPartyCode('0a1b2c3d-4e5f-6789-abcd-ef0123456789')).toBe('VEN-0A1B2C3D4E5F');
  });
});

describe('lifecycle', () => {
  const commands = Object.keys(LIFECYCLE) as LifecycleCommand[];

  it('only allows moves the contract state machine allows', () => {
    for (const command of commands) {
      for (const from of VENDOR_STATUSES) {
        const expected =
          (LIFECYCLE[command].from as readonly VendorStatus[]).includes(from) &&
          canTransitionVendor(from, LIFECYCLE[command].to);
        expect(lifecycleAllowed(command, from), `${command} from ${from}`).toBe(expected);
      }
    }
  });

  it('lists only moves that the contract allows (a table entry the contract refuses would be dead)', () => {
    for (const command of commands) {
      for (const from of LIFECYCLE[command].from as readonly VendorStatus[]) {
        expect(canTransitionVendor(from, LIFECYCLE[command].to), `${command} from ${from}`).toBe(
          true,
        );
      }
    }
  });

  it('archives only a blocked vendor', () => {
    expect(lifecycleAllowed('archive', 'blocked')).toBe(true);
    expect(lifecycleAllowed('archive', 'approved')).toBe(false);
    expect(lifecycleAllowed('archive', 'draft')).toBe(false);
  });
});

describe('lapsedTaxClearance', () => {
  const items = [
    { key: 'pan_certificate', expiresOn: '2020-01-01' },
    { key: 'tax_clearance', expiresOn: '2027-07-15' },
  ];

  it('is true the day after expiresOn, not on it', () => {
    expect(lapsedTaxClearance(items, '2027-07-15')).toBe(false);
    expect(lapsedTaxClearance(items, '2027-07-16')).toBe(true);
  });

  it('reads only the tax clearance, and ignores a missing expiry', () => {
    expect(
      lapsedTaxClearance([{ key: 'pan_certificate', expiresOn: '2020-01-01' }], '2030-01-01'),
    ).toBe(false);
    expect(lapsedTaxClearance([{ key: 'tax_clearance', expiresOn: null }], '2030-01-01')).toBe(
      false,
    );
    expect(lapsedTaxClearance([], '2030-01-01')).toBe(false);
  });
});

describe('isoDay', () => {
  it('is the calendar day in Kathmandu (UTC+05:45), not in UTC', () => {
    expect(isoDay(new Date('2026-11-09T18:00:00Z'))).toBe('2026-11-09');
    expect(isoDay(new Date('2026-11-09T18:15:00Z'))).toBe('2026-11-10');
  });
});

describe('submitKycMove (a stale KYB button never runs the other move)', () => {
  it('moves draft to pending_kyc and pending_kyc to under_review when the button saw that status', () => {
    expect(submitKycMove('draft', 'draft')).toEqual({ ok: true, to: 'pending_kyc' });
    expect(submitKycMove('pending_kyc', 'pending_kyc')).toEqual({ ok: true, to: 'under_review' });
  });

  it('refuses a "Start KYB review" drawn for draft once the vendor is pending_kyc, instead of sending it for review', () => {
    expect(submitKycMove('pending_kyc', 'draft')).toMatchObject({ ok: false, kind: 'stale' });
    expect(submitKycMove('under_review', 'draft')).toMatchObject({ ok: false, kind: 'stale' });
    expect(submitKycMove('under_review', 'pending_kyc')).toMatchObject({
      ok: false,
      kind: 'stale',
    });
  });

  it('keeps the old answer for a caller that names no status', () => {
    expect(submitKycMove('draft', undefined)).toEqual({ ok: true, to: 'pending_kyc' });
    expect(submitKycMove('pending_kyc', undefined)).toEqual({ ok: true, to: 'under_review' });
    for (const s of VENDOR_STATUSES.filter((x) => x !== 'draft' && x !== 'pending_kyc')) {
      expect(submitKycMove(s, undefined)).toMatchObject({ ok: false, kind: 'invalid' });
    }
  });
});

describe('kybReadyForReview (the gate of "Send for review")', () => {
  it('is true only for a submitted or approved KYB case', () => {
    expect(kybReadyForReview('submitted')).toBe(true);
    expect(kybReadyForReview('approved')).toBe(true);
    for (const s of [undefined, 'open', 'draft', 'rejected', 'changes_requested', '']) {
      expect(kybReadyForReview(s)).toBe(false);
    }
  });
});

describe('vendor name key (TR-Q12d same-name warning)', () => {
  it('ignores case, spaces, punctuation and company-form words', () => {
    const key = vendorNameKey('Himal Hardware Traders Pvt. Ltd.');
    expect(vendorNameKey('  himal   hardware-traders  PRIVATE LIMITED ')).toBe(key);
    expect(vendorNameKey('HIMAL HARDWARE TRADERS (P) LTD')).toBe(key);
    expect(vendorNameKey('Himal Hardware')).not.toBe(key);
  });

  it('finds the rows with the same key, and none for a name with no letters or digits', () => {
    const rows = [
      { id: 'a', legalName: 'Everest Supplies Pvt Ltd' },
      { id: 'b', legalName: 'Everest Supplies & Co.' },
      { id: 'c', legalName: 'Everest Supply' },
      { id: 'd', legalName: '...' },
    ];
    expect(sameNameVendors('everest supplies', rows).map((r) => r.id)).toEqual(['a', 'b']);
    expect(sameNameVendors(' -- ', rows)).toEqual([]);
  });
});
