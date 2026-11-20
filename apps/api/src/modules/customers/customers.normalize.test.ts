// Unit tests of the pure normalisers. normalizeName must agree with the workspace's normalizeName
// (apps/workspace/src/components/p2/customers/duplicates.ts), because the workspace searches the API with its
// own normalised text and the API compares it with name_norm.
import { describe, expect, it } from 'vitest';

import {
  escapeLike,
  normalizeEmail,
  normalizeName,
  normalizePan,
  panMatchKey,
  searchTerms,
} from './customers.normalize';

describe('normalizeName (parity with the workspace)', () => {
  it('drops company-form words, case and punctuation', () => {
    expect(normalizeName('Himalayan Construction Pvt. Ltd.')).toBe('himalayan construction');
    expect(normalizeName('HIMALAYAN CONSTRUCTION PRIVATE LIMITED')).toBe('himalayan construction');
    expect(normalizeName('Acme (P) Ltd')).toBe('acme');
  });

  it('keeps the words of a name that is only form words', () => {
    expect(normalizeName('Pvt Ltd')).toBe('pvt ltd');
  });

  it('handles Devanagari company-form words and NFKC width variants', () => {
    expect(normalizeName('हिमालयन प्रा लि')).toBe('हिमालयन');
    expect(normalizeName('ＡＣＭＥ Co.')).toBe('acme');
  });
});

describe('normalizePan', () => {
  it('trims and upper-cases, the form the unique index holds', () => {
    expect(normalizePan(' ab-123456 ')).toBe('AB-123456');
  });
});

describe('panMatchKey (parity with the workspace duplicate check)', () => {
  it('drops spaces and hyphens and upper-cases, so the hyphenated form matches the plain one', () => {
    expect(panMatchKey('123-456-789')).toBe('123456789');
    expect(panMatchKey(' ab 12-34 ')).toBe('AB1234');
    expect(panMatchKey('123-456-789')).toBe(panMatchKey('123456789'));
  });

  it('is null when nothing is left', () => {
    expect(panMatchKey(' - ')).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it('lower-cases and trims, the form the CHECK demands', () => {
    expect(normalizeEmail('  Sita.Rai@Example.COM ')).toBe('sita.rai@example.com');
  });
});

describe('escapeLike', () => {
  it('escapes the three LIKE metacharacters so user text matches literally', () => {
    expect(escapeLike('50%_off\\now')).toBe('50\\%\\_off\\\\now');
  });
});

describe('searchTerms', () => {
  it('searches the name on its normalised form and the PAN and number upper-cased', () => {
    expect(searchTerms('Himalayan Pvt. Ltd.')).toEqual({
      name: 'himalayan',
      code: 'HIMALAYAN PVT. LTD.',
    });
  });

  it('has no name term when the text is only punctuation', () => {
    expect(searchTerms('--')).toEqual({ name: null, code: '--' });
  });
});
