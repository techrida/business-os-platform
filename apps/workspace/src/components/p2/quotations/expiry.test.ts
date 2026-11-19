import { describe, expect, it } from 'vitest';

import { expiryState, isIsoCalendarDate, kathmanduToday } from './expiry';

describe('expiryState', () => {
  it('labels a date in the future', () => {
    expect(expiryState('2026-11-24', '2026-11-19')).toEqual({
      state: 'expiring',
      daysLeft: 5,
      label: 'Expires in 5 days',
    });
  });

  it('says today on the day itself', () => {
    expect(expiryState('2026-11-19', '2026-11-19')).toEqual({
      state: 'expiring',
      daysLeft: 0,
      label: 'Expires today',
    });
  });

  it('counts days since an expired date', () => {
    expect(expiryState('2026-11-16', '2026-11-19')).toEqual({
      state: 'expired',
      daysLeft: -3,
      label: 'Expired 3 days ago',
    });
  });

  it('uses the singular for one day', () => {
    expect(expiryState('2026-11-20', '2026-11-19').label).toBe('Expires in 1 day');
    expect(expiryState('2026-11-18', '2026-11-19').label).toBe('Expired 1 day ago');
  });

  it('is valid beyond the expiring window and expiring at its edge', () => {
    expect(expiryState('2026-11-26', '2026-11-19').state).toBe('expiring');
    expect(expiryState('2026-11-27', '2026-11-19')).toMatchObject({
      state: 'valid',
      daysLeft: 8,
    });
  });

  it('counts across month and year ends and leap days', () => {
    expect(expiryState('2027-01-02', '2026-12-30').daysLeft).toBe(3);
    expect(expiryState('2028-03-01', '2028-02-28').daysLeft).toBe(2);
  });

  it('rejects malformed dates instead of guessing', () => {
    expect(() => expiryState('2026-02-30', '2026-11-19')).toThrow(RangeError);
    expect(() => expiryState('2026-11-19', '19 Nov 2026')).toThrow(RangeError);
    expect(isIsoCalendarDate('2026-11-19')).toBe(true);
    expect(isIsoCalendarDate('2026-13-01')).toBe(false);
  });
});

describe('kathmanduToday', () => {
  it('uses the Kathmandu calendar day, not UTC', () => {
    // 20:30 UTC on the 18th is 02:15 on the 19th in Kathmandu (UTC+5:45).
    expect(kathmanduToday(new Date('2026-11-18T20:30:00Z'))).toBe('2026-11-19');
    expect(kathmanduToday(new Date('2026-11-18T18:00:00Z'))).toBe('2026-11-18');
  });
});
