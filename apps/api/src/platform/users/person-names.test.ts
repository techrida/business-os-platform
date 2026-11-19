// D54-2: a person is shown by their display name or as "Unnamed user", never by a piece of their address.
// Run: pnpm --filter @bos/api exec vitest run src/platform/users/person-names.test.ts
import { describe, expect, it } from 'vitest';

import { nameIn, personLabel, UNNAMED_USER } from './person-names';

describe('personLabel', () => {
  it('is the trimmed display name', () => {
    expect(personLabel('  Sita Sharma ', 'sita.sharma@example.test')).toBe('Sita Sharma');
  });

  it('is "Unnamed user" for an address with no display name, never the part before the @', () => {
    expect(personLabel(null, 'sita.sharma@example.test')).toBe('Unnamed user');
    expect(personLabel('', 'sita.sharma@example.test')).toBe('Unnamed user');
    expect(personLabel('   ', 'accounts.desk@example.test')).toBe('Unnamed user');
  });

  it('is "Unnamed user" with neither a name nor an address', () => {
    expect(personLabel(null, null)).toBe(UNNAMED_USER);
    expect(personLabel(null)).toBe(UNNAMED_USER);
  });
});

describe('nameIn', () => {
  const names = new Map([['u-1', 'Sita Sharma']]);

  it('is null when the record names no one', () => {
    expect(nameIn(names, null)).toBeNull();
    expect(nameIn(names, undefined)).toBeNull();
  });

  it('is the name when known and "Unnamed user" for an id the tenant does not have', () => {
    expect(nameIn(names, 'u-1')).toBe('Sita Sharma');
    expect(nameIn(names, 'u-2')).toBe('Unnamed user');
  });
});
