import { describe, expect, it } from 'vitest';

import { TAX } from '../_lib/test-fixtures';

import {
  MAX_LINES,
  newLine,
  parseCreditLines,
  parseLines,
  parseLinesJson,
  type LineValues,
} from './lines';

const line = (over: Partial<LineValues> = {}): LineValues => ({
  ...newLine('l1'),
  description: 'Advance 40% of the website build',
  uom: 'lot',
  quantity: '1',
  unitPrice: '1880000.00',
  taxCodeId: TAX,
  ...over,
});

describe('parseLines: commas in amounts', () => {
  it.each([
    ['12,50,000.00', '1250000.00'],
    ['1,250,000.50', '1250000.50'],
  ])('reads the grouping in a price of %s', (typed, plain) => {
    const out = parseLines([line({ unitPrice: typed })]);
    expect(out.ok && out.data[0]?.unitPrice).toBe(plain);
  });

  it.each(['1,5', '10,50', '1,25'])('refuses %s as a price and says to use a point', (typed) => {
    const out = parseLines([line({ unitPrice: typed })]);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.errors['lines.0.unitPrice']).toMatch(/^Use a point for decimals\./);
  });

  it.each(['1,5', '10,50', '1,25'])('refuses %s as a quantity and says to use a point', (typed) => {
    const out = parseLines([line({ quantity: typed })]);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.errors['lines.0.quantity']).toMatch(/^Use a point for decimals\./);
  });

  it('keeps the plain message when the field is wrong without a stray comma', () => {
    const out = parseLines([line({ unitPrice: 'abc' })]);
    expect(!out.ok && out.errors['lines.0.unitPrice']).not.toMatch(/point/);
  });
});

describe('parseLines', () => {
  it('sends description, unit, quantity, price and tax code only, trimmed and without grouping', () => {
    const out = parseLines([line({ description: '  Design  ', unitPrice: '18,80,000.00' })]);
    expect(out).toEqual({
      ok: true,
      data: [
        {
          description: 'Design',
          uom: 'lot',
          quantity: '1',
          unitPrice: '1880000.00',
          taxCodeId: TAX,
        },
      ],
    });
  });

  it('asks for at least one line', () => {
    expect(parseLines([])).toEqual({
      ok: false,
      errors: { lines: 'Add at least one line.' },
    });
  });

  it('names each wrong field of each wrong line', () => {
    const out = parseLines([
      line(),
      line({ description: ' ', uom: '', quantity: '0', unitPrice: '', taxCodeId: '' }),
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(Object.keys(out.errors).sort()).toEqual([
      'lines.1.description',
      'lines.1.quantity',
      'lines.1.taxCodeId',
      'lines.1.unitPrice',
      'lines.1.uom',
    ]);
    expect(out.errors['lines.1.quantity']).toMatch(/above zero/);
  });

  it('refuses a quantity with more than four decimals and a price with more than two', () => {
    const out = parseLines([line({ quantity: '1.23456', unitPrice: '10.005' })]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors['lines.0.quantity']).toBeTruthy();
    expect(out.errors['lines.0.unitPrice']).toBeTruthy();
  });

  it('refuses a negative price and a tax code that is not an id', () => {
    const out = parseLines([line({ unitPrice: '-5', taxCodeId: 'VAT' })]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors['lines.0.unitPrice']).toBeTruthy();
    expect(out.errors['lines.0.taxCodeId']).toBe('Choose a tax code.');
  });

  it('allows a free line (price 0) and stops at the line limit', () => {
    expect(parseLines([line({ unitPrice: '0' })]).ok).toBe(true);
    const many = Array.from({ length: MAX_LINES + 1 }, (_, i) => line({ key: `k${i}` }));
    const out = parseLines(many);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors['lines']).toContain(String(MAX_LINES));
  });

  it('refuses a description over 500 characters and a unit over 20', () => {
    const out = parseLines([line({ description: 'x'.repeat(501), uom: 'y'.repeat(21) })]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors['lines.0.description']).toContain('500');
    expect(out.errors['lines.0.uom']).toContain('20');
  });
});

describe('parseLinesJson', () => {
  it('reads what the form posts and nothing else', () => {
    const posted = JSON.stringify([{ ...line(), extra: 'ignored' }]);
    expect(parseLinesJson(posted)).toEqual([line()]);
  });

  it('answers null for anything that is not a list of text fields', () => {
    expect(parseLinesJson('not json')).toBeNull();
    expect(parseLinesJson('{}')).toBeNull();
    expect(parseLinesJson(JSON.stringify([{ description: 5 }]))).toBeNull();
    expect(parseLinesJson(JSON.stringify(Array.from({ length: 1001 }, () => line())))).toBeNull();
  });
});

describe('parseCreditLines', () => {
  it('credits only the lines that have a quantity, by their original line number', () => {
    const out = parseCreditLines([
      { lineNo: 1, quantity: '' },
      { lineNo: 2, quantity: '1.5' },
      { lineNo: 3, quantity: '0' },
      { lineNo: 4, quantity: '2' },
    ]);
    expect(out).toEqual({
      ok: true,
      data: [
        { originalLineNo: 2, quantity: '1.5' },
        { originalLineNo: 4, quantity: '2' },
      ],
    });
  });

  it('needs at least one line credited', () => {
    expect(parseCreditLines([{ lineNo: 1, quantity: '' }])).toEqual({
      ok: false,
      errors: { lines: 'Enter a quantity to credit on at least one line.' },
    });
  });

  it('names the line whose quantity is not a number', () => {
    const out = parseCreditLines([
      { lineNo: 1, quantity: 'two' },
      { lineNo: 2, quantity: '1' },
    ]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(Object.keys(out.errors)).toEqual(['lines.0.quantity']);
  });
});
