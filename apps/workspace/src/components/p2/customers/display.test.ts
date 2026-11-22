import type { PartyPhone } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { addressText, primaryPhone } from './display';

describe('addressText', () => {
  it('writes street, city and the country name for a Nepal customer', () => {
    expect(addressText({ line: 'Durbar Marg 1', city: 'Kathmandu' }, 'NP')).toBe(
      'Durbar Marg 1, Kathmandu, Nepal',
    );
  });

  it('names a foreign country in full', () => {
    expect(addressText({ line: '1 Market St', city: 'San Francisco' }, 'US')).toBe(
      '1 Market St, San Francisco, United States',
    );
  });
});

describe('primaryPhone', () => {
  const np: PartyPhone = { country: 'NP', e164: '+9779812345678', isPrimary: false };
  const us: PartyPhone = { country: 'US', e164: '+14155552671', isPrimary: true };

  it('picks the primary number wherever it sits', () => {
    expect(primaryPhone([np, us])).toBe(us);
  });

  it('falls back to the first number when none is marked, and to none for an empty list', () => {
    expect(primaryPhone([np])).toBe(np);
    expect(primaryPhone([])).toBeNull();
  });
});
