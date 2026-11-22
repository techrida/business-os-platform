import type { CustomerDto } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { duplicateQueries, matchDuplicates } from './duplicate-check';

const WHEN = '2026-11-08T05:45:00.000Z';

function customer(over: Partial<CustomerDto> & { id: string }): CustomerDto {
  return {
    number: 'CUS-0001',
    legalName: 'Himalayan Construction Pvt. Ltd.',
    panVatNo: '301234567',
    industry: null,
    relationship: 'prospect',
    ownerUserId: null,
    defaultCurrency: null,
    country: 'NP',
    address: { line: 'Balaju', city: 'Kathmandu' },
    mergedIntoId: null,
    version: 1,
    createdAt: WHEN,
    updatedAt: WHEN,
    ...over,
  };
}

describe('duplicateQueries', () => {
  it('searches the name without company-form words, and the PAN/VAT as typed', () => {
    expect(duplicateQueries('Himalayan Construction Pvt. Ltd.', '301-234-567')).toEqual([
      'himalayan construction',
      '301-234-567',
    ]);
  });

  it('leaves out a blank PAN/VAT and a name too short to search', () => {
    expect(duplicateQueries('Himalayan Construction', '  ')).toEqual(['himalayan construction']);
    expect(duplicateQueries('A', undefined)).toEqual([]);
  });
});

describe('matchDuplicates', () => {
  const input = { legalName: 'HIMALAYAN CONSTRUCTION PRIVATE LIMITED', panVatNo: '301 234 567' };

  it('matches on the same name or the same PAN/VAT after normalising, and says why', () => {
    const samePan = customer({
      id: 'a',
      legalName: 'Totally Different Name',
      number: 'CUS-0002',
    });
    const sameName = customer({ id: 'b', panVatNo: null, number: 'CUS-0003' });
    const both = customer({ id: 'c', number: 'CUS-0004' });
    const unrelated = customer({
      id: 'd',
      legalName: 'Everest Traders',
      panVatNo: '999999999',
    });
    const out = matchDuplicates(input, [samePan, sameName, both, unrelated]);
    expect(out.map((m) => [m.id, m.reasons])).toEqual([
      ['c', ['pan_vat', 'name']],
      ['a', ['pan_vat']],
      ['b', ['name']],
    ]);
  });

  it('ignores records already merged into another and the record being edited', () => {
    const merged = customer({ id: 'm', mergedIntoId: '22222222-2222-4222-8222-222222222222' });
    const self = customer({ id: 's' });
    expect(matchDuplicates(input, [merged, self], { excludeId: 's' })).toEqual([]);
  });

  it('returns nothing when the input has no usable name or number', () => {
    expect(matchDuplicates({ legalName: ' ' }, [customer({ id: 'x', panVatNo: null })])).toEqual(
      [],
    );
  });

  it('caps the list so a common name cannot flood the form', () => {
    const many = Array.from({ length: 9 }, (_, i) => customer({ id: `id-${i}` }));
    expect(matchDuplicates(input, many, { limit: 3 })).toHaveLength(3);
  });
});
