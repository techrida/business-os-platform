import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { isQuotationClosed } from './quotation-closed';

vi.mock('server-only', () => ({}));

describe('isQuotationClosed', () => {
  it('is true only for the 409 quotation_closed answer', () => {
    expect(isQuotationClosed(new ApiError(409, 'x', { error: { code: 'quotation_closed' } }))).toBe(
      true,
    );
    expect(isQuotationClosed(new ApiError(409, 'x', { error: { code: 'other' } }))).toBe(false);
    expect(isQuotationClosed(new ApiError(410, 'x', { error: { code: 'quotation_closed' } }))).toBe(
      false,
    );
    expect(isQuotationClosed(new Error('x'))).toBe(false);
  });
});

describe('a portal server action', () => {
  it('imports no UI module: shared code lives in lib/', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/app/(portal)/quotations/[id]/actions.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from '@\/components\//);
  });
});
