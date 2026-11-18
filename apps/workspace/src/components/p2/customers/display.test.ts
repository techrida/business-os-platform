import { describe, expect, it } from 'vitest';

import { addressLines } from './display';

const texts = (lines: { text: string }[]) => lines.map((l) => l.text);

describe('addressLines', () => {
  it('lists only the parts that are set, in writing order', () => {
    expect(texts(addressLines({ line1: 'Balaju', city: 'Kathmandu', country: 'NP' }))).toEqual([
      'Balaju',
      'Kathmandu',
      'NP',
    ]);
    expect(
      texts(
        addressLines({
          line1: 'Plot 4',
          line2: 'Ring Road',
          city: 'Lalitpur',
          district: 'Lalitpur',
          province: 'Bagmati',
          postalCode: '44700',
          country: 'NP',
        }),
      ),
    ).toEqual(['Plot 4', 'Ring Road', 'Lalitpur, Lalitpur, Bagmati', '44700 NP']);
  });

  it('gives each line its own slot even when two lines read the same', () => {
    expect(addressLines({ line1: 'KTM', city: 'KTM', country: 'NP' })).toEqual([
      { slot: 'line1', text: 'KTM' },
      { slot: 'place', text: 'KTM' },
      { slot: 'postal', text: 'NP' },
    ]);
  });
});
