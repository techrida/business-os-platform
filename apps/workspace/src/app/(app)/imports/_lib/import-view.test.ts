import { PARTY_IMPORT_COLUMNS, type PartyImportDetail } from '@bos/contracts';
import { expect, it } from 'vitest';

import { errorReportCsv, importSlugOf, slugOfKind, templateCsv } from './import-view';

it('maps the URL words to kinds and back, and refuses anything else', () => {
  expect(importSlugOf('customers')).toBe('customers');
  expect(importSlugOf('vendors')).toBe('vendors');
  expect(importSlugOf('suppliers')).toBeNull();
  expect(importSlugOf('__proto__')).toBeNull();
  expect(slugOfKind('customer')).toBe('customers');
  expect(slugOfKind('vendor')).toBe('vendors');
});

it('writes the template with exactly the contract columns and one example row', () => {
  for (const kind of ['customer', 'vendor'] as const) {
    const [header, example] = templateCsv(kind).replace('﻿', '').trim().split('\r\n');
    expect(header).toBe(PARTY_IMPORT_COLUMNS[kind].map((c) => `"${c}"`).join(','));
    expect(example!.split('","').length).toBe(PARTY_IMPORT_COLUMNS[kind].length);
  }
});

const detail = (rows: PartyImportDetail['rows']): PartyImportDetail => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'customer',
  status: 'previewed',
  fileName: 'x.csv',
  rowCount: rows.length,
  validCount: 0,
  createdCount: 0,
  duplicateCount: 0,
  errorCount: 0,
  createdByUserId: '22222222-2222-4222-8222-222222222222',
  createdAt: '2026-11-21T04:00:00.000Z',
  committedAt: null,
  rows,
});

it('lists only the lines that need attention in the error report, and neutralises formula text from the file', () => {
  const csv = errorReportCsv(
    detail([
      { line: 2, name: 'Fine', pan: null, status: 'valid', issues: [] },
      {
        line: 3,
        name: '=HYPERLINK("http://evil")',
        pan: '123',
        status: 'error',
        issues: [
          { column: 'pan_vat_no', message: 'bad' },
          { column: null, message: 'also' },
        ],
      },
      {
        line: 4,
        name: 'Twin',
        pan: '999999999',
        status: 'duplicate',
        issues: [{ column: null, message: 'Already exists' }],
      },
      { line: 5, name: 'Made', pan: null, status: 'created', issues: [] },
    ]),
  );
  const lines = csv.replace('﻿', '').trim().split('\r\n');
  expect(lines).toEqual([
    '"Line","Name","PAN","Result","Problems"',
    '"3","\'=HYPERLINK(""http://evil"")","123","Needs fixing","pan_vat_no: bad; also"',
    '"4","Twin","999999999","Already exists","Already exists"',
  ]);
});
