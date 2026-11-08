import { describe, expect, it } from 'vitest';

import { addressLines } from './display';

describe('addressLines', () => {
  it('lists only the parts that are set, in writing order', () => {
    expect(addressLines({ line1: 'Balaju', city: 'Kathmandu', country: 'NP' })).toEqual([
      'Balaju',
      'Kathmandu',
      'NP',
    ]);
    expect(
      addressLines({
        line1: 'Plot 4',
        line2: 'Ring Road',
        city: 'Lalitpur',
        district: 'Lalitpur',
        province: 'Bagmati',
        postalCode: '44700',
        country: 'NP',
      }),
    ).toEqual(['Plot 4', 'Ring Road', 'Lalitpur, Lalitpur, Bagmati', '44700 NP']);
  });
});
