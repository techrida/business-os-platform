import { describe, expect, it } from 'vitest';

import { formatAddress } from './invoice-support';

// FX9: the invoice snapshots hold the address as one printed line, the same as the PDF: street, city, then the
// country's name, which is left out when it is the issuing entity's own country.
describe('formatAddress', () => {
  it("prints a foreign customer's address with the country name", () => {
    expect(formatAddress({ line: '1 Market St', city: 'San Francisco', country: 'US' }, 'NP')).toBe(
      '1 Market St, San Francisco, United States',
    );
  });

  it("omits the country of a customer in the entity's own country", () => {
    expect(formatAddress({ line: 'Durbar Marg 1', city: 'Kathmandu', country: 'NP' }, 'NP')).toBe(
      'Durbar Marg 1, Kathmandu',
    );
  });

  it('prints the country when no own country is given', () => {
    expect(formatAddress({ line: 'Durbar Marg 1', city: 'Kathmandu', country: 'NP' })).toBe(
      'Durbar Marg 1, Kathmandu, Nepal',
    );
  });
});
