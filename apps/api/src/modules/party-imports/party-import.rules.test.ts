import { describe, expect, it } from 'vitest';

import {
  buildRows,
  clip,
  checkLine,
  countStatuses,
  identityKey,
  parseCsv,
  PartyImportFileError,
  readPartyCsv,
  startsLikeFormula,
} from './party-import.rules';

const customerLine = (over: Partial<Record<string, string>> = {}) => {
  const base: Record<string, string> = {
    legal_name: 'Himal Traders',
    pan_vat_no: '123456789',
    industry: '',
    address_line1: 'Thapathali 12',
    address_city: 'Kathmandu',
    address_country: '',
    contact_name: '',
    contact_email: 'ACCOUNTS@Example.com',
    contact_phone: '',
    ...over,
  };
  return base;
};

describe('parseCsv', () => {
  it('reads quotes, doubled quotes, commas and line breaks inside quotes, CRLF and a byte-order mark', () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","two\nlines"\r\n1,2,3\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'two\nlines'],
      ['1', '2', '3'],
    ]);
  });

  it('skips blank lines and keeps an empty trailing field', () => {
    expect(parseCsv('a,b\n\n1,\n')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
  });

  it('refuses an unterminated quote and a stray quote', () => {
    expect(() => parseCsv('a,b\n"open,1\n')).toThrow(PartyImportFileError);
    expect(() => parseCsv('a,b\nab"c,1\n')).toThrow(PartyImportFileError);
    expect(() => parseCsv('a,b\n"ab"c,1\n')).toThrow(PartyImportFileError);
  });
});

describe('readPartyCsv', () => {
  it('numbers data lines from 2 and accepts the columns in any order', () => {
    const csv = `contact_email,legal_name,address_line1,address_city\na@b.co,Acme,Road 1,Pokhara\n`;
    const read = readPartyCsv('customer', csv);
    expect(read.records).toHaveLength(1);
    expect(read.records[0]).toMatchObject({
      line: 2,
      cells: { legal_name: 'Acme', address_city: 'Pokhara' },
    });
  });

  it('refuses a file that is not the template: unknown or missing columns, no rows, too many rows', () => {
    expect(() => readPartyCsv('customer', 'legal_name,whatever\nA,B\n')).toThrow(/Unknown column/);
    expect(() => readPartyCsv('customer', 'legal_name\nA\n')).toThrow(/is missing/);
    expect(() => readPartyCsv('vendor', 'legal_name,legal_name\nA,B\n')).toThrow(/twice/);
    expect(() => readPartyCsv('vendor', 'legal_name\n')).toThrow(/no rows/);
    expect(() => readPartyCsv('vendor', '')).toThrow(/empty/);
    const many = 'legal_name\n' + Array.from({ length: 2001 }, (_, i) => `V${i}`).join('\n');
    expect(() => readPartyCsv('vendor', many)).toThrow(/more than 2000/);
    expect(() => readPartyCsv('vendor', 'legal_name\nA,B\n')).toThrow(/more fields/);
  });

  it('is malformed-CSV safe: a broken file is a file error, never a half read', () => {
    expect(() => readPartyCsv('vendor', 'legal_name\n"never closed\n')).toThrow(
      PartyImportFileError,
    );
  });
});

describe('review fixes', () => {
  it('refuses a file with a control character (NUL) as a file error, so it never reaches the database', () => {
    expect(() => readPartyCsv('vendor', 'legal_name\nAcme\u0000Co\n')).toThrow(
      /control characters/,
    );
    expect(() => readPartyCsv('vendor', 'legal_name\nAcme\tCo\n')).not.toThrow();
  });

  it('refuses a PAN with no letter or digit, and keeps a vendor contact name within 120 characters', () => {
    expect(
      checkLine('customer', customerLine({ pan_vat_no: '-----' })).issues.map((i) => i.column),
    ).toEqual(['pan_vat_no']);
    const long = 'V'.repeat(150);
    const vendor = checkLine('vendor', {
      legal_name: long,
      kind: '',
      pan: '987654321',
      vat_registered: '',
      country: '',
      contact_name: '',
      contact_email: 'a@b.co',
      contact_phone: '',
    });
    expect(vendor.values?.contact_name).toHaveLength(120);
    expect(
      checkLine('vendor', {
        legal_name: 'X',
        kind: '',
        pan: '987654321',
        vat_registered: '',
        country: '',
        contact_name: 'C'.repeat(121),
        contact_email: '',
        contact_phone: '',
      }).issues.map((i) => i.column),
    ).toEqual(['contact_name']);
  });
});

describe('second review fixes', () => {
  const rec = (line: number, over: Partial<Record<string, string>>) => ({
    line,
    cells: customerLine(over),
  });

  it('a name-only line cannot repeat a company an earlier line carries a PAN for', () => {
    const rows = buildRows('customer', [
      rec(2, { legal_name: 'Acme Ltd', pan_vat_no: '555555555' }),
      rec(3, { legal_name: 'ACME PRIVATE LIMITED', pan_vat_no: '' }),
    ]);
    expect(rows.map((r) => r.status)).toEqual(['valid', 'duplicate']);
    expect(rows[1]!.issues[0]!.message).toBe('Same name as line 2 of this file');
  });

  it('keeps a line with its own PAN valid even when the name matches an earlier name-only line', () => {
    const rows = buildRows('customer', [
      rec(2, { legal_name: 'Acme Ltd', pan_vat_no: '' }),
      rec(3, { legal_name: 'Acme Private Limited', pan_vat_no: '555555555' }),
    ]);
    expect(rows.map((r) => r.status)).toEqual(['valid', 'valid']);
  });

  it('clips without splitting a surrogate pair', () => {
    expect(clip('ab', 5)).toBe('ab');
    expect(clip('a\u{1F600}', 2)).toBe('a');
    const row = buildRows('customer', [
      rec(2, { legal_name: `${'x'.repeat(499)}\u{1F600}`, pan_vat_no: '' }),
    ])[0]!;
    expect((JSON.parse(JSON.stringify(row)) as { name: string }).name).toHaveLength(499);
  });
});

describe('checkLine, customers', () => {
  it('normalises a good line: PAN upper-case, e-mail lower-case, country NP, contact name from the company', () => {
    const checked = checkLine('customer', customerLine({ pan_vat_no: 'ab-12345' }));
    expect(checked.issues).toEqual([]);
    expect(checked.values).toMatchObject({
      pan_vat_no: 'AB-12345',
      contact_email: 'accounts@example.com',
      address_country: 'NP',
      contact_name: 'Himal Traders',
    });
  });

  it('lists every problem of a line: missing name, bad PAN, bad email, missing address', () => {
    const checked = checkLine(
      'customer',
      customerLine({
        legal_name: '',
        pan_vat_no: 'ABC',
        contact_email: 'not-an-email',
        address_line1: '',
      }),
    );
    expect(checked.values).toBeUndefined();
    expect(checked.issues.map((i) => i.column).sort()).toEqual(
      ['address_line1', 'contact_email', 'legal_name', 'pan_vat_no'].sort(),
    );
  });

  it('refuses a cell that a spreadsheet would run as a formula, but not a phone number', () => {
    for (const evil of ['=HYPERLINK("http://x")', '+cmd|calc', '-2+3', '@SUM(A1)', '\tx']) {
      const checked = checkLine('customer', customerLine({ legal_name: evil }));
      expect(
        checked.issues.some((i) => i.column === 'legal_name'),
        evil,
      ).toBe(true);
    }
    expect(checkLine('customer', customerLine({ contact_phone: '+9779812345678' })).issues).toEqual(
      [],
    );
    expect(startsLikeFormula('Himal')).toBe(false);
  });
});

describe('checkLine, vendors', () => {
  const vendor = (over: Record<string, string> = {}) => ({
    legal_name: 'Everest Supplies',
    kind: '',
    pan: '987654321',
    vat_registered: 'YES',
    country: '',
    contact_name: '',
    contact_email: '',
    contact_phone: '',
    ...over,
  });

  it('defaults to a Nepal company that is not VAT registered', () => {
    const checked = checkLine('vendor', vendor({ vat_registered: '' }));
    expect(checked.issues).toEqual([]);
    expect(checked.values).toMatchObject({
      kind: 'company',
      country: 'NP',
      vat_registered: 'no',
      pan: '987654321',
    });
  });

  it('needs a 9-digit PAN unless the vendor is foreign, and a foreign vendor needs a country outside Nepal', () => {
    expect(checkLine('vendor', vendor({ pan: '' })).issues.map((i) => i.column)).toEqual(['pan']);
    expect(checkLine('vendor', vendor({ pan: '12345' })).issues.map((i) => i.column)).toEqual([
      'pan',
    ]);
    expect(
      checkLine('vendor', vendor({ kind: 'foreign', pan: '' })).issues.map((i) => i.column),
    ).toEqual(['country']);
    expect(checkLine('vendor', vendor({ kind: 'foreign', pan: '', country: 'in' })).issues).toEqual(
      [],
    );
    expect(
      checkLine('vendor', vendor({ kind: 'foreign', country: 'NP' })).issues.map((i) => i.column),
    ).toEqual(['country']);
    expect(checkLine('vendor', vendor({ kind: 'martian' })).issues.map((i) => i.column)).toContain(
      'kind',
    );
  });

  it('checks the optional contact only when it is given', () => {
    expect(
      checkLine('vendor', vendor({ contact_email: 'bad' })).issues.map((i) => i.column),
    ).toEqual(['contact_email']);
    expect(checkLine('vendor', vendor({ contact_email: 'a@b.co' })).values?.contact_name).toBe(
      'Everest Supplies',
    );
    expect(checkLine('vendor', vendor()).values?.contact_name).toBe('');
  });
});

describe('buildRows and identityKey', () => {
  const rec = (line: number, over: Partial<Record<string, string>>) => ({
    line,
    cells: customerLine(over),
  });

  it('keys on the PAN when there is one (spaces and hyphens ignored), otherwise on the normalised name', () => {
    expect(identityKey('customer', { legal_name: 'Acme Pvt. Ltd.', pan_vat_no: '12-34 5' })).toBe(
      'pan:12345',
    );
    expect(identityKey('customer', { legal_name: 'Acme Pvt. Ltd.', pan_vat_no: '' })).toBe(
      'name:acme',
    );
    expect(identityKey('vendor', { legal_name: 'X', pan: '123456789' })).toBe('pan:123456789');
  });

  it('marks a repeat inside the file as a duplicate of the first line, and counts the statuses', () => {
    const rows = buildRows('customer', [
      rec(2, { legal_name: 'A One', pan_vat_no: '111111111' }),
      rec(3, { legal_name: 'A Two', pan_vat_no: '111-111-111' }),
      rec(4, { legal_name: 'B', pan_vat_no: '' }),
      rec(5, { legal_name: 'b Pvt Ltd', pan_vat_no: '' }),
      rec(6, { legal_name: '', pan_vat_no: '' }),
    ]);
    expect(rows.map((r) => r.status)).toEqual([
      'valid',
      'duplicate',
      'valid',
      'duplicate',
      'error',
    ]);
    expect(rows[1]!.issues[0]!.message).toBe('Same PAN as line 2 of this file');
    expect(rows[3]!.issues[0]!.message).toBe('Same name as line 4 of this file');
    expect(countStatuses(rows)).toEqual({
      rowCount: 5,
      validCount: 2,
      createdCount: 0,
      duplicateCount: 2,
      errorCount: 1,
    });
  });
});
