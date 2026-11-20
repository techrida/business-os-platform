// No browser, no stack: the pure helpers of workflows/procurement.mjs.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  bankAccountPlan,
  parseCsv,
  procurementValues,
  vatCsvRow,
  workflow,
} from '../workflows/procurement.mjs';

describe('procurementValues', () => {
  const a = procurementValues('scr1-1440x0900');
  const b = procurementValues('scr1-0390x0844');

  test('carries the run key in every value another run could collide with', () => {
    for (const key of ['budgetCode', 'justification', 'quoteRef', 'invoiceNo', 'bankAccountName'])
      assert.ok(a[key].includes('scr1-1440x0900'), key);
    for (const serial of a.serials) assert.ok(serial.endsWith('-scr1-1440x0900'));
    assert.notEqual(a.serials[0], a.serials[1]);
  });

  test('is deterministic, so a resumed run types the same values', () => {
    assert.deepEqual(procurementValues('scr1-1440x0900'), a);
  });

  test('two viewports of one label get different values', () => {
    assert.notEqual(a.invoiceNo, b.invoiceNo);
    assert.notEqual(a.bankAccountNumber, b.bankAccountNumber);
  });

  test('fits the API limits (64 characters; 6 to 34 digits ending in four digits)', () => {
    for (const key of ['budgetCode', 'quoteRef', 'invoiceNo']) assert.ok(a[key].length <= 64, key);
    assert.match(a.bankAccountNumber, /^\d{12}$/);
    assert.equal(a.bankLast4, a.bankAccountNumber.slice(-4));
  });
});

describe('bankAccountPlan', () => {
  const mine = { accountName: 'Dev Vendor Co SCR-x', last4: '4715' };
  const other = { status: 'Verified, in use', accountName: 'Dev Vendor Co', last4: '1717' };

  test('proposes when the vendor has no account of this run (another run’s stays untouched)', () => {
    assert.deepEqual(bankAccountPlan([], mine), { action: 'propose' });
    assert.deepEqual(bankAccountPlan([other], mine), { action: 'propose' });
  });

  test('verifies an account this run proposed, and stops once it is in use', () => {
    const proposed = { status: 'Awaiting verification', ...mine };
    assert.deepEqual(bankAccountPlan([other, proposed], mine), { action: 'verify' });
    const active = { status: 'Verified, in use', ...mine };
    assert.deepEqual(bankAccountPlan([active], mine), { action: 'done' });
  });

  test('fails on two accounts of this run, another ending, or a retired or rejected one', () => {
    const p = { status: 'Awaiting verification', ...mine };
    assert.equal(bankAccountPlan([p, p], mine).action, 'fail');
    assert.equal(bankAccountPlan([{ ...p, last4: '0000' }], mine).action, 'fail');
    assert.equal(bankAccountPlan([{ ...p, status: 'Retired' }], mine).action, 'fail');
    assert.equal(bankAccountPlan([{ ...p, status: 'Rejected' }], mine).action, 'fail');
  });
});

describe('parseCsv', () => {
  test('quoted cells, doubled quotes, commas inside quotes, CRLF and a BOM', () => {
    const csv = '\uFEFF"a","b ""q""","c,d"\r\n"1",,"3"\r\n';
    assert.deepEqual(parseCsv(csv), [
      ['a', 'b "q"', 'c,d'],
      ['1', '', '3'],
    ]);
  });

  test('a last line without a line break, and LF line breaks', () => {
    assert.deepEqual(parseCsv('x,y\nz,w'), [
      ['x', 'y'],
      ['z', 'w'],
    ]);
  });
});

describe('vatCsvRow', () => {
  // As vatCsv (apps/workspace/src/app/(app)/payables/_lib/vat-csv.ts) writes it.
  const header =
    '"PAN","Vendor","Invoice number","Invoice date (BS)","Invoice date (AD)","Taxable amount (NPR)","VAT (NPR)"';
  const line = (no, taxable, vat) =>
    `"123456789","Dev Vendor Co","${no}","2083-08-04","2026-11-20","${taxable}","${vat}"`;
  const csv = (...rows) =>
    `\uFEFF${[header, ...rows, '"Total","","","","","1","2"'].join('\r\n')}\r\n`;

  test('finds this run’s row by its exact invoice number', () => {
    const got = vatCsvRow(
      csv(
        line('BOS-DEMO-VI-01', '5.00', '0.65'),
        line('BOS-DEMO-VI-01-r1', '100000.00', '13000.00'),
      ),
      'BOS-DEMO-VI-01-r1',
    );
    assert.deepEqual(got, {
      ok: true,
      row: {
        pan: '123456789',
        vendor: 'Dev Vendor Co',
        invoiceNo: 'BOS-DEMO-VI-01-r1',
        taxable: '100000.00',
        vat: '13000.00',
      },
    });
  });

  test('never takes a longer invoice number that starts with this one, or the Total row', () => {
    const got = vatCsvRow(csv(line('BOS-DEMO-VI-01-r10', '1.00', '0.13')), 'BOS-DEMO-VI-01-r1');
    assert.equal(got.ok, false);
    assert.equal(vatCsvRow(csv(), 'Total').ok, false);
  });

  test('fails on two rows with the number and on an unexpected header', () => {
    const two = csv(line('X-1', '1.00', '0.13'), line('X-1', '1.00', '0.13'));
    assert.match(vatCsvRow(two, 'X-1').reason, /2 rows/);
    assert.match(vatCsvRow('"PAN","Vendor"\r\n', 'X-1').reason, /unexpected header/);
  });
});

describe('workflow', () => {
  test('lists procurement-1 … procurement-15 and the origins it signs in through', () => {
    const w = workflow({ runKey: 'scr1-1440x0900' });
    assert.equal(w.name, 'procurement');
    assert.deepEqual(
      w.steps.map((s) => s.id),
      Array.from({ length: 15 }, (_, i) => `procurement-${i + 1}`),
    );
    assert.deepEqual(w.origins, ['app', 'portal', 'auth']);
  });
});
