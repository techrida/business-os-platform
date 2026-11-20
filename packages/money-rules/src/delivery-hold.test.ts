import { describe, expect, it } from 'vitest';

import { deliveryHoldReleaser, mayReleaseDeliveryHold } from './delivery-hold.js';
import { Dec } from './money.js';

const d = (text: string) => new Dec(text);
const threshold = '100000';

describe('deliveryHoldReleaser (F1-Q32, strict ">")', () => {
  it('lets Finance release up to and including the threshold', () => {
    expect(deliveryHoldReleaser(d('0'), threshold)).toEqual(['finance']);
    expect(deliveryHoldReleaser(d('100000.00'), threshold)).toEqual(['finance']);
  });

  it('needs Management one paisa above the threshold', () => {
    expect(deliveryHoldReleaser(d('100000.01'), threshold)).toEqual(['management']);
    expect(deliveryHoldReleaser(d('999999999.99'), threshold)).toEqual(['management']);
  });

  it('follows a changed threshold', () => {
    expect(deliveryHoldReleaser(d('150000'), '200000')).toEqual(['finance']);
    expect(deliveryHoldReleaser(d('150000'), '0')).toEqual(['management']);
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

  it('never lets the person who requested the delivery release it', () => {
    expect(
      mayReleaseDeliveryHold({
        ...base,
        requestedByUserId: 'u-fin',
        releaser: { userId: 'u-fin', roles: ['finance', 'management'] },
      }),
    ).toBe(false);
  });

  it('applies only the role rule when the requester is unknown', () => {
    expect(
      mayReleaseDeliveryHold({
        ...base,
        requestedByUserId: null,
        releaser: { userId: 'u-fin', roles: ['finance'] },
      }),
    ).toBe(true);
  });
});
