// Small pure helpers of the two controllers. The routes themselves are covered by documents.integration.test.ts.
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { LengthRequiredException, parseContentLength } from './documents.controller';
import { contentDisposition } from './files.controller';

describe('parseContentLength', () => {
  it('reads a plain integer', () => {
    expect(parseContentLength('0')).toBe(0);
    expect(parseContentLength('26214400')).toBe(26_214_400);
  });

  it('is 411 when the header is missing', () => {
    expect(() => parseContentLength(undefined)).toThrow(LengthRequiredException);
    expect(new LengthRequiredException().getStatus()).toBe(411);
  });

  it('is 400 for anything that is not a plain non-negative integer', () => {
    for (const bad of ['', '-1', '1e6', '12abc', ' 12', '1.5', '9'.repeat(13)]) {
      expect(() => parseContentLength(bad)).toThrow(BadRequestException);
    }
  });
});

describe('contentDisposition', () => {
  it('is an attachment with an ASCII fallback and the exact UTF-8 name', () => {
    expect(contentDisposition('invoice.pdf')).toBe(
      `attachment; filename="invoice.pdf"; filename*=UTF-8''invoice.pdf`,
    );
    const nepali = contentDisposition('बिल 2082.pdf');
    expect(nepali).toContain('filename="___ 2082.pdf"');
    expect(nepali).toContain("filename*=UTF-8''%E0%A4%AC");
  });

  it('cannot be broken out of with quotes, semicolons or percent signs', () => {
    const header = contentDisposition('a";x=1; b%.pdf');
    expect(header.startsWith('attachment; filename="a__x=1_ b_.pdf"')).toBe(true);
    // Between the quotes there is no quote or backslash, so the value cannot end early.
    expect(/filename="([^"\\]*)"/.exec(header)?.[1]).toBe('a__x=1_ b_.pdf');
  });
});
