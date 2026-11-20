import { describe, expect, it } from 'vitest';

import { bankReferenceKey, sameReferencePayments } from './payments.rules';

describe('bankReferenceKey', () => {
  it('ignores case, spaces at either end and runs of spaces', () => {
    expect(bankReferenceKey('  NIC   77812 ')).toBe('nic 77812');
    expect(bankReferenceKey('nic\t77812')).toBe('nic 77812');
    expect(bankReferenceKey('Nic 77812')).toBe(bankReferenceKey('NIC 77812'));
  });

  it('keeps punctuation and inner characters, so different references stay different', () => {
    expect(bankReferenceKey('NIC-77812')).not.toBe(bankReferenceKey('NIC 77812'));
    expect(bankReferenceKey('NIC77812')).not.toBe(bankReferenceKey('NIC 77812'));
  });

  it('is empty for a reference of spaces only', () => {
    expect(bankReferenceKey('   ')).toBe('');
  });
});

describe('sameReferencePayments', () => {
  const rows = [
    { id: 'a', bankReference: 'NIC  77812' },
    { id: 'b', bankReference: 'NIC-77812' },
    { id: 'c', bankReference: null },
    { id: 'd', bankReference: ' nic 77812' },
  ];

  it('returns the rows with the same reference, in their order', () => {
    expect(sameReferencePayments('Nic 77812 ', rows).map((r) => r.id)).toEqual(['a', 'd']);
  });

  it('returns none for a reference no row has', () => {
    expect(sameReferencePayments('EBL-1', rows)).toEqual([]);
  });

  it('returns none for an empty reference, even against rows without one', () => {
    expect(sameReferencePayments('  ', rows)).toEqual([]);
  });
});
