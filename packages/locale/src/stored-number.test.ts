import { describe, expect, it } from 'vitest';

import { storedNumberText } from './stored-number.js';

describe('storedNumberText', () => {
  it('drops the extra zeros of a stored value', () => {
    expect(storedNumberText('100000.000')).toBe('100000');
    expect(storedNumberText('10.5000')).toBe('10.5');
    expect(storedNumberText('100000.000', 2)).toBe('100000.00');
    expect(storedNumberText('1250.5', 2)).toBe('1250.50');
  });

  it('keeps real decimals past the scale, and text that is not a plain decimal', () => {
    expect(storedNumberText('12.345', 2)).toBe('12.345');
    expect(storedNumberText('')).toBe('');
    expect(storedNumberText('-5.00')).toBe('-5.00');
    expect(storedNumberText('1e5')).toBe('1e5');
  });
});
