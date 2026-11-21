import { describe, expect, it } from 'vitest';
import { hasStrayComma, plainAmount } from './plain-amount.js';

describe('plainAmount', () => {
  it.each([
    ['12,50,000.00', '1250000.00'],
    ['1,250,000.50', '1250000.50'],
    ['1,500', '1500'],
    ['20,18,180', '2018180'],
    [' 1 500 ', '1500'],
    ['1500.25', '1500.25'],
    ['', ''],
  ])('reads %s as %s', (typed, plain) => {
    expect(plainAmount(typed)).toBe(plain);
    expect(hasStrayComma(typed)).toBe(false);
  });

  it.each([
    '1,5',
    '10,50',
    '1,25',
    '1,2345',
    '12,5000',
    '1,50,00',
    ',5',
    '5,',
    '1,000,00',
    '1.000,50',
    '1,5.00',
    '0,250',
    '00,250',
    '0,500',
    '0,50,000',
    '0,000',
    '10,50 0',
    '1, 250',
  ])('keeps the comma in %s so it fails the digit check', (typed) => {
    expect(plainAmount(typed)).toContain(',');
    expect(hasStrayComma(typed)).toBe(true);
  });
});
