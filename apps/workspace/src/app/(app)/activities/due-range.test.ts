import { expect, it } from 'vitest';

import { dueRange, readDay } from './due-range';

it('keeps real calendar days only', () => {
  expect(readDay('2030-01-31')).toBe('2030-01-31');
  expect(readDay('2030-02-30')).toBeUndefined();
  expect(readDay('2030-1-3')).toBeUndefined();
  expect(readDay('tomorrow')).toBeUndefined();
  expect(readDay(undefined)).toBeUndefined();
});

it('passes either end alone, and reads an inverted pair in order', () => {
  expect(dueRange(undefined, undefined)).toEqual({});
  expect(dueRange('2030-01-01', undefined)).toEqual({ dueFrom: '2030-01-01' });
  expect(dueRange(undefined, '2030-01-02')).toEqual({ dueTo: '2030-01-02' });
  expect(dueRange('2030-01-03', '2030-01-02')).toEqual({
    dueFrom: '2030-01-02',
    dueTo: '2030-01-03',
  });
  expect(dueRange('nonsense', '2030-01-02')).toEqual({ dueTo: '2030-01-02' });
});
