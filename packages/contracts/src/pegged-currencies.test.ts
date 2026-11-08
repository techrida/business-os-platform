import { describe, expect, it } from 'vitest';

import { CURRENCIES, PEGGED_CURRENCIES } from './index.js';

describe('PEGGED_CURRENCIES', () => {
  it('lists exactly INR, the only currency Nepal Rastra Bank fixes against the NPR', () => {
    expect([...PEGGED_CURRENCIES]).toEqual(['INR']);
  });

  it('only names currencies the system knows, and never NPR itself', () => {
    for (const currency of PEGGED_CURRENCIES) {
      expect(CURRENCIES).toContain(currency);
      expect(currency).not.toBe('NPR');
    }
  });
});
