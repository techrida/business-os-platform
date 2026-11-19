import { describe, expect, it } from 'vitest';

import { numberSystemOptions, parseNumberSystem } from './number-format';

describe('numberSystemOptions', () => {
  it('draws both worked examples from the shared formatters', () => {
    const [southAsian, international] = numberSystemOptions();
    expect(southAsian).toMatchObject({
      value: 'south_asian',
      amount: 'NPR 20,18,180.00',
      words: 'Twenty Lakh Eighteen Thousand One Hundred Eighty Rupees Only',
    });
    expect(international).toMatchObject({
      value: 'international',
      amount: 'NPR 2,018,180.00',
      words: 'Two Million Eighteen Thousand One Hundred Eighty Rupees Only',
    });
  });
});

describe('parseNumberSystem', () => {
  it('accepts the two systems and nothing else', () => {
    expect(parseNumberSystem('south_asian')).toBe('south_asian');
    expect(parseNumberSystem('international')).toBe('international');
    expect(parseNumberSystem('lakh')).toBeNull();
    expect(parseNumberSystem('')).toBeNull();
    expect(parseNumberSystem(undefined)).toBeNull();
  });
});
