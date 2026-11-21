import { expect, it } from 'vitest';

import { csvCell, csvDocument } from './csv';

it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx', ' =x'])(
  'neutralises the formula-looking value %j',
  (value) => {
    expect(csvCell(value)).toBe(`"'${value}"`);
  },
);

it('keeps plain text, numbers and embedded quotes', () => {
  expect(csvCell('Acme, "Co"')).toBe('"Acme, ""Co"""');
  expect(csvCell('-12.50')).toBe('"-12.50"');
  expect(csvCell(null)).toBe('""');
});

it('writes a BOM and CRLF rows', () => {
  expect(csvDocument([['a', 'b'], ['=x']])).toBe('﻿"a","b"\r\n"\'=x"\r\n');
});
