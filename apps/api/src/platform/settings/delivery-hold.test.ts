import { SETTINGS } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import type { DbTransaction } from '../db/db.module';
import { DELIVERY_HOLD_THRESHOLD_KEY, deliveryHoldThresholdNpr } from './delivery-hold';

const scope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
};

/** A transaction stand-in whose settings query finds `saved` (the latest stored value), or no row. */
function txWith(saved?: unknown) {
  let calls = 0;
  const execute = () => {
    calls += 1;
    return Promise.resolve({ rows: saved === undefined ? [] : [{ version: 1, value: saved }] });
  };
  return { calls: () => calls, tx: { execute } as unknown as DbTransaction };
}

describe('deliveryHoldThresholdNpr (F1-Q32)', () => {
  it('reads NPR 100,000 when nothing was saved', async () => {
    const q = txWith();
    await expect(deliveryHoldThresholdNpr(q.tx, scope)).resolves.toBe('100000');
    expect(q.calls()).toBe(1);
  });

  it('reads the saved amount', async () => {
    const q = txWith('250000.50');
    await expect(deliveryHoldThresholdNpr(q.tx, scope)).resolves.toBe('250000.50');
  });

  it('names a key the settings contract declares', () => {
    expect(SETTINGS[DELIVERY_HOLD_THRESHOLD_KEY]).toBeDefined();
  });
});
