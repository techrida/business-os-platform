import { expect, it } from 'vitest';

import { seriesName } from './series-name';

it('names counters after the document, never the storage key', () => {
  expect(seriesName('quotation')).toBe('Quotations');
  expect(seriesName('MEMO')).toBe('Memos');
  expect(seriesName('purchase-order')).toBe('Purchase orders');
  expect(seriesName('vendor.code')).toBe('Vendor code');
});
