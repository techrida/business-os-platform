import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api';

import { isQuotationClosed, QuotationClosed } from './quotation-closed';

describe('QuotationClosed (R5 EF2)', () => {
  it('recognises the API answer for a cancelled quotation and nothing else', () => {
    const closed = new ApiError(409, 'closed', {
      error: { code: 'quotation_closed', message: 'This quotation is no longer open' },
    });
    expect(isQuotationClosed(closed)).toBe(true);
    expect(isQuotationClosed(new ApiError(404, 'missing'))).toBe(false);
    expect(isQuotationClosed(new ApiError(409, 'other', { error: { code: 'conflict' } }))).toBe(
      false,
    );
    expect(isQuotationClosed(new Error('x'))).toBe(false);
  });

  it('says the quotation is no longer open, not that it was not found', () => {
    const html = renderToStaticMarkup(<QuotationClosed />);
    expect(html).toContain('no longer open');
    expect(html).not.toMatch(/not found|could not find/i);
  });
});
