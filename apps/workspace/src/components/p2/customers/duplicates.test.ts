import { describe, expect, it } from 'vitest';

import { findDuplicates, normalizeName, normalizePanVat } from './duplicates';

const c = (id: string, legalName: string, panVatNo: string | null) => ({ id, legalName, panVatNo });

describe('normalizeName', () => {
  it('ignores case, punctuation, spacing and company-form words', () => {
    const forms = [
      'Himalayan Construction Pvt. Ltd.',
      'himalayan  construction PRIVATE LIMITED',
      'Himalayan Construction (P) Ltd',
      ' HIMALAYAN-CONSTRUCTION ',
    ];
    for (const form of forms) expect(normalizeName(form), form).toBe('himalayan construction');
  });

  it('keeps a name that is only a company-form word, and Devanagari text', () => {
    expect(normalizeName('Limited')).toBe('limited');
    expect(normalizeName('हिमालयन कन्स्ट्रक्सन प्रा. लि.')).toContain('हिमालयन');
  });
});

describe('normalizePanVat', () => {
  it('compares PAN and VAT numbers without case, spaces or hyphens', () => {
    expect(normalizePanVat(' 301-234 567 ')).toBe('301234567');
    expect(normalizePanVat('ab-12345')).toBe('AB12345');
    expect(normalizePanVat(null)).toBeNull();
    expect(normalizePanVat('  ')).toBeNull();
  });
});

describe('findDuplicates', () => {
  it('flags every record that shares a PAN/VAT or a normalised name with another', () => {
    const found = findDuplicates([
      c('a', 'Himalayan Construction Pvt. Ltd.', '301234567'),
      c('b', 'Everest Trading', '301-234-567'),
      c('c', 'HIMALAYAN CONSTRUCTION PRIVATE LIMITED', null),
      c('d', 'Annapurna Foods', '999999999'),
    ]);
    expect(found.get('a')).toEqual(['pan_vat', 'name']);
    expect(found.get('b')).toEqual(['pan_vat']);
    expect(found.get('c')).toEqual(['name']);
    expect(found.has('d')).toBe(false);
  });

  it('never flags a record against itself or on an empty PAN/VAT', () => {
    expect(findDuplicates([c('a', 'Solo', null)]).size).toBe(0);
    expect(findDuplicates([c('a', 'One', null), c('b', 'Two', null)]).size).toBe(0);
  });
});
