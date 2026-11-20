import { SETTING_DEFAULTS, SETTINGS, type SettingKey } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import type { TxScope } from '../db/tx';
import { DELIVERY_HOLD_THRESHOLD_KEY, deliveryHoldThresholdNpr } from './delivery-hold';
import type { SettingsService } from './settings.service';

const scope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
};

/** A SettingsService stand-in that answers like the real one: the saved value, or the contract default. */
function settingsWith(saved: Partial<Record<SettingKey, unknown>>) {
  const asked: SettingKey[] = [];
  const get = (_scope: TxScope, key: SettingKey) => {
    asked.push(key);
    return Promise.resolve(key in saved ? saved[key] : SETTING_DEFAULTS[key]);
  };
  return { asked, get: get as Pick<SettingsService, 'get'>['get'] };
}

describe('deliveryHoldThresholdNpr (F1-Q32)', () => {
  it('reads NPR 100,000 when nothing was saved', async () => {
    const settings = settingsWith({});
    await expect(deliveryHoldThresholdNpr(settings, scope)).resolves.toBe('100000');
    expect(settings.asked).toEqual(['sales.delivery_hold.management_npr']);
  });

  it('reads the saved amount', async () => {
    const settings = settingsWith({ 'sales.delivery_hold.management_npr': '250000.50' });
    await expect(deliveryHoldThresholdNpr(settings, scope)).resolves.toBe('250000.50');
  });

  it('names a key the settings contract declares', () => {
    expect(SETTINGS[DELIVERY_HOLD_THRESHOLD_KEY]).toBeDefined();
  });
});
