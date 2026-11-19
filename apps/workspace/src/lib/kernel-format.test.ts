import { DEFAULT_NUMBER_SYSTEMS, type NumberSystems } from '@bos/locale';
import { describe, expect, it } from 'vitest';

import { documentNumberText, money, snapshotEntries, when } from './kernel-format';

const INTL: NumberSystems = { NPR: 'international', INR: 'international', USD: 'international' };
const SA: NumberSystems = { NPR: 'south_asian', INR: 'south_asian', USD: 'south_asian' };

describe('money() number system', () => {
  it('keeps each currency its own grouping when no number system is given', () => {
    expect(money('2018180', 'NPR')).toBe('NPR 20,18,180.00');
    expect(money('2018180', 'USD')).toBe('USD 2,018,180.00');
    expect(money('2018180')).toBe('NPR 20,18,180.00');
  });

  it('applies the tenant number systems when given', () => {
    expect(money('2018180', 'NPR', INTL)).toBe('NPR 2,018,180.00');
    expect(money('2018180', 'USD', INTL)).toBe('USD 2,018,180.00');
    expect(money('2018180', 'NPR', SA)).toBe('NPR 20,18,180.00');
    expect(money('2018180', 'USD', SA)).toBe('USD 20,18,180.00');
    expect(money('2018180', 'USD', DEFAULT_NUMBER_SYSTEMS)).toBe('USD 2,018,180.00');
  });

  it('still returns odd text untouched', () => {
    expect(money('abc', 'NPR', INTL)).toBe('abc');
  });

  it('groups snapshot amounts by the number system', () => {
    const snapshot = { currency: 'NPR', amount: '2018180', totalNpr: '2018180.00' };
    const values = (ns?: NumberSystems) =>
      snapshotEntries(snapshot, undefined, ns).map((row) => row.value);
    expect(values(INTL)).toEqual(['NPR', 'NPR 2,018,180.00', 'NPR 2,018,180.00']);
    expect(values()).toEqual(['NPR', 'NPR 20,18,180.00', 'NPR 20,18,180.00']);
  });
});

describe('snapshotEntries terms wording', () => {
  it('shows rich terms as plain words, never markup, and leaves the stored value alone', () => {
    const snapshot = {
      scope: '<p>Includes:</p><ul><li>Survey</li><li>Install</li></ul><script>alert(1)</script>',
      termsAndConditions: 'Net 30 days',
    };
    const rows = snapshotEntries(snapshot);
    const scope = rows.find((row) => row.key === 'scope');
    expect(scope?.value).toContain('Survey');
    expect(scope?.value).toContain('Install');
    expect(scope?.value).not.toMatch(/<\/?(p|ul|li|script)/);
    expect(scope?.value).not.toContain('alert(1)');
    expect(scope?.block).toBe(true);
    expect(rows.find((row) => row.key === 'termsAndConditions')?.value).toBe('Net 30 days');
    expect(snapshot.scope).toContain('<ul>');
  });

  it('omits terms wording that has no words', () => {
    expect(snapshotEntries({ terms: '<p></p>', note: 'x' }).map((row) => row.key)).toEqual([
      'note',
    ]);
  });
});

describe('when() date pattern', () => {
  it('keeps the default Kathmandu wording when no pattern is given', () => {
    expect(when('2026-03-05', 'date')).toBe('05 Mar 2026');
    expect(when('2025-07-16T23:59:00Z')).toBe('17 Jul 2025, 05:44');
    expect(when('2025-07-16T23:59:00Z', 'date')).toBe('17 Jul 2025');
  });

  it('writes a calendar date in the pattern, as it is', () => {
    expect(when('2026-03-05', 'date', 'dd/MM/yyyy')).toBe('05/03/2026');
    expect(when('2026-03-05', 'date', 'yyyy-MM-dd')).toBe('2026-03-05');
    expect(when('2026-03-05', 'date', 'MMM dd, yyyy')).toBe('Mar 05, 2026');
    expect(when('2026-03-05', 'datetime', 'dd MMM yyyy')).toBe('05 Mar 2026');
  });

  it('writes an instant as its Kathmandu day in the pattern and keeps its time', () => {
    // 23:59 UTC on the 16th is 05:44 on the 17th in Kathmandu.
    expect(when('2025-07-16T23:59:00Z', 'datetime', 'dd/MM/yyyy')).toBe('17/07/2025, 05:44');
    expect(when('2025-07-16T23:59:00Z', 'date', 'dd/MM/yyyy')).toBe('17/07/2025');
    expect(when('2025-07-16T18:15:00Z', 'datetime', 'yyyy-MM-dd')).toBe('2025-07-17, 00:00');
  });

  it('passes text that is not a date through, with or without a pattern', () => {
    expect(when('On delivery', 'date', 'dd/MM/yyyy')).toBe('On delivery');
    expect(when('soon', 'datetime')).toBe('soon');
  });
});

describe('snapshotEntries reference names', () => {
  const id = '3F2A9C1E-7B44-4D6A-9E10-5C8D2A7B6F01';
  const names = new Map([[id.toLowerCase(), 'Operations']]);

  it('finds a name for an id written in upper case, top level and nested', () => {
    const rows = snapshotEntries({ purchaseRequest: { departmentId: id }, ownerUserId: id }, names);
    const text = rows.map((row) => row.value).join('\n');
    expect(text).toContain('Operations');
    expect(text).not.toContain('Name unavailable');
  });

  it('still says the name is unavailable for an unknown id', () => {
    const rows = snapshotEntries({ ownerUserId: '00000000-0000-4000-8000-000000000000' }, names);
    expect(rows.map((row) => row.value).join('\n')).toContain('Name unavailable');
  });
});

describe('documentNumberText', () => {
  it('names a document that has no number yet by its kind, without its internal id', () => {
    expect(documentNumberText('Draft debit_note 7d92d5bf')).toBe('Draft debit note');
    expect(documentNumberText('Draft credit_note 0a1b2c3d')).toBe('Draft credit note');
    expect(documentNumberText('Draft pr_commitment 0a1b2c3d')).toBe('Draft PR commitment');
    expect(documentNumberText('Draft goods_receipt abcdef12')).toBe('Draft goods receipt');
  });

  it('leaves words a person typed alone even when they look like a draft reference', () => {
    expect(documentNumberText('Draft budget 20261120')).toBe('Draft budget 20261120');
    expect(snapshotEntries({ title: 'Draft budget 20261120' })[0]?.value).toBe(
      'Draft budget 20261120',
    );
  });

  it('leaves a real document number alone', () => {
    expect(documentNumberText('INV-2083/84-00001')).toBe('INV-2083/84-00001');
    expect(documentNumberText('Draft budget for review')).toBe('Draft budget for review');
  });
});

describe('snapshotEntries invoice approval snapshot', () => {
  // The frozen shape invoice-approval.service.ts submits for a tax invoice, credit note or debit note.
  const snapshot = {
    kind: 'debit_note',
    reference: 'Draft debit_note 7d92d5bf',
    customerName: 'Acme Traders',
    currency: 'NPR',
    total: '1130.00',
    noteReason: 'Short billed',
    contentSha256: 'a'.repeat(64),
  };

  it('labels the kind and the reference in product words and hides the content hash', () => {
    const rows = snapshotEntries(snapshot);
    expect(rows.find((row) => row.key === 'kind')).toMatchObject({
      label: 'Document type',
      value: 'Debit note',
    });
    expect(rows.find((row) => row.key === 'reference')?.value).toBe('Draft debit note');
    expect(rows.map((row) => row.key)).not.toContain('contentSha256');
    expect(rows.map((row) => row.value).join(' ')).not.toMatch(/debit_note|7d92d5bf|a{64}/);
    expect(rows.find((row) => row.key === 'customerName')?.value).toBe('Acme Traders');
  });

  it('keeps a kind that is not a document type as it was', () => {
    expect(snapshotEntries({ kind: 'service' })).toEqual([
      { key: 'kind', label: 'Kind', value: 'service', block: false },
    ]);
  });
});
