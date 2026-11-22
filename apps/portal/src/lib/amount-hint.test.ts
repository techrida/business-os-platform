import { describe, expect, it } from 'vitest';

import { hasInnerSpace, REMOVE_THE_SPACE, spaceAware } from './amount-hint';

describe('spaceAware', () => {
  it('names a space inside a number, and only that', () => {
    for (const raw of ['10 50', '1 250.5', ' 2 50 000 ']) expect(hasInnerSpace(raw)).toBe(true);
    for (const raw of ['', '1050', ' 1050 ', '2 weeks', '10 a', 'abc']) {
      expect(hasInnerSpace(raw)).toBe(false);
    }
    expect(spaceAware('10 50', 'generic')).toBe(REMOVE_THE_SPACE);
    expect(spaceAware('-5', 'generic')).toBe('generic');
  });
});
