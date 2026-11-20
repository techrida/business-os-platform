import { describe, expect, it } from 'vitest';

import { documentContact } from './format';

const printed = {
  numberSystems: { NPR: 'south_asian', INR: 'south_asian', USD: 'international' },
  dateFormat: 'dd MMM yyyy',
  capturedAt: '2026-11-09T06:00:00.000Z',
} as const;
const frozen = {
  phones: ['01-4000000'],
  email: 'billing@techrida.example',
  signatoryName: 'Sita Sharma',
  signatoryTitle: 'Finance Manager',
};
const now = {
  phones: ['01-5999999'],
  email: 'new@techrida.example',
  signatoryName: 'Hari Rai',
  signatoryTitle: null,
};

describe('documentContact', () => {
  it('shows the contact print 1 froze, not the profile as it is now', () => {
    expect(documentContact({ ...printed, sellerContact: frozen }, now)).toEqual(frozen);
  });

  it('shows none when print 1 could not read the profile', () => {
    expect(documentContact({ ...printed, sellerContact: null }, now)).toBeNull();
  });

  it('falls back to the profile as it is now for an invoice never printed, or printed before contacts froze', () => {
    expect(documentContact(null, now)).toEqual(now);
    expect(documentContact(undefined, now)).toEqual(now);
    expect(documentContact(printed, now)).toEqual(now);
  });
});
