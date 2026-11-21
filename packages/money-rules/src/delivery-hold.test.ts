import { describe, expect, it } from 'vitest';

import { deliveryHoldReleaser, mayReleaseDeliveryHold } from './delivery-hold.js';
import { Dec } from './money.js';

const d = (text: string) => new Dec(text);
const threshold = '100000';

describe('deliveryHoldReleaser (F1-Q32, strict ">")', () => {
  it('lets Finance (or the Founder) release up to and including the threshold', () => {
    expect(deliveryHoldReleaser(d('0'), threshold)).toEqual(['finance', 'founder']);
    expect(deliveryHoldReleaser(d('100000.00'), threshold)).toEqual(['finance', 'founder']);
  });

  it('needs Management (or the Founder) one paisa above the threshold', () => {
    expect(deliveryHoldReleaser(d('100000.01'), threshold)).toEqual(['management', 'founder']);
    expect(deliveryHoldReleaser(d('999999999.99'), threshold)).toEqual(['management', 'founder']);
  });

  it('follows a changed threshold', () => {
    expect(deliveryHoldReleaser(d('150000'), '200000')).toEqual(['finance', 'founder']);
    expect(deliveryHoldReleaser(d('150000'), '0')).toEqual(['management', 'founder']);
  });

  it('refuses a negative threshold', () => {
    expect(() => deliveryHoldReleaser(d('1'), '-1')).toThrow(RangeError);
  });
});

describe('mayReleaseDeliveryHold', () => {
  const base = { amountNpr: d('50000'), thresholdNpr: threshold, requestedByUserId: 'u-sales' };

  it('allows a Finance user below the threshold', () => {
    expect(
      mayReleaseDeliveryHold({ ...base, releaser: { userId: 'u-fin', roles: ['finance'] } }),
    ).toBe(true);
  });

  it('refuses Management below the threshold and Finance above it', () => {
    expect(
      mayReleaseDeliveryHold({ ...base, releaser: { userId: 'u-mgmt', roles: ['management'] } }),
    ).toBe(false);
    expect(
      mayReleaseDeliveryHold({
        ...base,
        amountNpr: d('100000.01'),
        releaser: { userId: 'u-fin', roles: ['finance'] },
      }),
    ).toBe(false);
  });

  it('allows Management above the threshold', () => {
    expect(
      mayReleaseDeliveryHold({
        ...base,
        amountNpr: d('100000.01'),
        releaser: { userId: 'u-mgmt', roles: ['management'] },
      }),
    ).toBe(true);
  });

  it.each([
    ['100000.00', 'at'],
    ['100000.01', 'above'],
    ['999999999.99', 'far above'],
  ])('allows the Founder at %s (%s the threshold)', (amount) => {
    expect(
      mayReleaseDeliveryHold({
        ...base,
        amountNpr: d(amount),
        releaser: { userId: 'u-founder', roles: ['founder'] },
      }),
    ).toBe(true);
  });

  it('switches from Finance to Management between 100,000.00 and 100,000.01', () => {
    const finance = { userId: 'u-fin', roles: ['finance'] };
    const management = { userId: 'u-mgmt', roles: ['management'] };
    const at = { ...base, amountNpr: d('100000.00') };
    const above = { ...base, amountNpr: d('100000.01') };
    expect(mayReleaseDeliveryHold({ ...at, releaser: finance })).toBe(true);
    expect(mayReleaseDeliveryHold({ ...at, releaser: management })).toBe(false);
    expect(mayReleaseDeliveryHold({ ...above, releaser: finance })).toBe(false);
    expect(mayReleaseDeliveryHold({ ...above, releaser: management })).toBe(true);
  });

  it('refuses a role that is none of Finance, Management or Founder', () => {
    for (const roles of [['accountant'], ['sales'], []]) {
      expect(mayReleaseDeliveryHold({ ...base, releaser: { userId: 'u-x', roles } })).toBe(false);
    }
  });

  it('never lets the Founder release a delivery the Founder requested', () => {
    expect(
      mayReleaseDeliveryHold({
        ...base,
        requestedByUserId: 'u-founder',
        releaser: { userId: 'u-founder', roles: ['founder'] },
      }),
    ).toBe(false);
  });

  it('never lets the person who requested the delivery release it', () => {
    expect(
      mayReleaseDeliveryHold({
        ...base,
        requestedByUserId: 'u-fin',
        releaser: { userId: 'u-fin', roles: ['finance', 'management'] },
      }),
    ).toBe(false);
  });

  // The requester is the order's created_by; a null created_by (system-created order) excludes nobody.
  it('applies only the role rule when the requester is unknown', () => {
    expect(
      mayReleaseDeliveryHold({
        ...base,
        requestedByUserId: null,
        releaser: { userId: 'u-fin', roles: ['finance'] },
      }),
    ).toBe(true);
    expect(
      mayReleaseDeliveryHold({
        ...base,
        requestedByUserId: null,
        releaser: { userId: 'u-sales', roles: ['sales'] },
      }),
    ).toBe(false);
  });
});
