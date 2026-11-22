// The address line holds what the FX9 migration copied in: the old line1 (200) and line2 (200) joined with ', ',
// up to 402 characters. A limit under that would refuse an edit that keeps a migrated address as it was.
import { describe, expect, it } from 'vitest';

import { AddressLinesSchema, PrintAddressSchema } from './index.js';

const migrated = `${'a'.repeat(200)}, ${'b'.repeat(200)}`;

describe('address line length (FX9)', () => {
  it('takes a migrated two-line address of 402 characters, and a line of 500', () => {
    expect(migrated).toHaveLength(402);
    for (const line of [migrated, 'x'.repeat(500)]) {
      expect(AddressLinesSchema.safeParse({ line, city: 'Kathmandu' }).success).toBe(true);
      expect(PrintAddressSchema.safeParse({ line, city: 'Kathmandu', country: 'NP' }).success).toBe(
        true,
      );
    }
  });

  it('refuses a line of 501 characters and a city of 101', () => {
    const line = 'x'.repeat(501);
    expect(AddressLinesSchema.safeParse({ line, city: 'Kathmandu' }).success).toBe(false);
    expect(PrintAddressSchema.safeParse({ line, city: 'Kathmandu', country: 'NP' }).success).toBe(
      false,
    );
    expect(
      AddressLinesSchema.safeParse({ line: 'Durbar Marg', city: 'c'.repeat(101) }).success,
    ).toBe(false);
  });
});
