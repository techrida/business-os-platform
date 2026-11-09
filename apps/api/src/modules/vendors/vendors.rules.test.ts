// Unit tests of the pure vendor rules (no database).
import {
  VENDOR_KINDS,
  VENDOR_STATUSES,
  canTransitionVendor,
  type VendorStatus,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  isoDay,
  kindCountryProblem,
  kindFromRow,
  kindToRow,
  lapsedTaxClearance,
  LIFECYCLE,
  lifecycleAllowed,
  vendorPartyCode,
  type LifecycleCommand,
} from './vendors.rules';

describe('kind mapping', () => {
  it('maps the sole proprietor to the table value and back, and leaves the others alone', () => {
    expect(kindToRow('sole_proprietor')).toBe('proprietor');
    expect(kindFromRow('proprietor')).toBe('sole_proprietor');
    for (const kind of VENDOR_KINDS) expect(kindFromRow(kindToRow(kind))).toBe(kind);
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
