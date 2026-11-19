// Unit tests for SettingsController (fakes, no database) and for the built-in setting defaults.
// Run with: pnpm --filter @bos/api exec vitest run src/platform/settings/settings.controller.test.ts
//
// The controller's own job is routing and validation: an unknown key is a 404, a bad body is a 400, and a
// write runs inside withTx with the caller's scope. withTx and requestTx are replaced so no request or
// database is needed; the real behaviour against Postgres is covered in settings.integration.test.ts.
import { SETTINGS, SETTING_KEYS } from '@bos/contracts';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

import type { Db } from '../db/db.module';
import type { MoneyService } from './money.service';
import { SettingsController } from './settings.controller';
import { SETTING_DEFAULTS, type SettingsService } from './settings.service';

const scope = { tenantId: 't-1', organizationId: 'o-1' };
const actor = { kind: 'user' as const, id: 'u-1', correlationId: 'c-1' };

vi.mock('../db/tx', () => ({
  requestTx: () => ({ scope, actor }),
  withTx: (_db: unknown, _scope: unknown, _actor: unknown, fn: (tx: unknown) => unknown) =>
    fn({ fake: 'tx' }),
}));

const fakeSettings = {
  getCurrent: vi.fn(),
  set: vi.fn(),
  listNumberSeries: vi.fn(),
};
const fakeMoney = { setRate: vi.fn(), listRates: vi.fn() };

let controller: SettingsController;

beforeEach(() => {
  vi.resetAllMocks();
  controller = new SettingsController(
    {} as Db,
    fakeSettings as unknown as SettingsService,
    fakeMoney as unknown as MoneyService,
  );
});

describe('SettingsController', () => {
  it('answers 404 for an unknown key on GET and PUT, before touching the service', async () => {
    await expect(controller.getSetting('no.such_key')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.putSetting('no.such_key', { value: 1 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(fakeSettings.getCurrent).not.toHaveBeenCalled();
    expect(fakeSettings.set).not.toHaveBeenCalled();
  });

  it('GET returns the value with its version (null for a default)', async () => {
    fakeSettings.getCurrent.mockResolvedValue({ value: '13', version: null });
    await expect(controller.getSetting('tax.vat_rate')).resolves.toEqual({
      key: 'tax.vat_rate',
      value: '13',
      version: null,
    });
    expect(fakeSettings.getCurrent).toHaveBeenCalledWith(scope, 'tax.vat_rate');
  });

  it('PUT writes through withTx and returns the new version', async () => {
    fakeSettings.set.mockResolvedValue({ version: 4 });
    await expect(controller.putSetting('tax.vat_rate', { value: '15' })).resolves.toEqual({
      version: 4,
    });
    expect(fakeSettings.set).toHaveBeenCalledWith({ fake: 'tx' }, 'tax.vat_rate', '15');
  });

  it('PUT passes expectedVersion (a number or null) on to the service as an option', async () => {
    fakeSettings.set.mockResolvedValue({ version: 4 });
    await controller.putSetting('tax.vat_rate', { value: '15', expectedVersion: 3 });
    expect(fakeSettings.set).toHaveBeenLastCalledWith({ fake: 'tx' }, 'tax.vat_rate', '15', {
      expectedVersion: 3,
    });
    await controller.putSetting('tax.vat_rate', { value: '15', expectedVersion: null });
    expect(fakeSettings.set).toHaveBeenLastCalledWith({ fake: 'tx' }, 'tax.vat_rate', '15', {
      expectedVersion: null,
    });
  });

  it('PUT lets the service answer 409 stale_setting through unchanged', async () => {
    fakeSettings.set.mockRejectedValue(
      new ConflictException({ code: 'stale_setting', message: 'changed' }),
    );
    await expect(
      controller.putSetting('tax.vat_rate', { value: '15', expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([0, -1, 1.5, '3', 'x'])('PUT refuses expectedVersion %j with 400', async (bad) => {
    await expect(
      controller.putSetting('tax.vat_rate', { value: '15', expectedVersion: bad }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fakeSettings.set).not.toHaveBeenCalled();
  });

  it('PUT passes a bad value on to the service, which rejects it with 400', async () => {
    fakeSettings.set.mockRejectedValue(new BadRequestException('Invalid value for tax.vat_rate'));
    await expect(controller.putSetting('tax.vat_rate', { value: '500' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('POST fx-rates rejects a zero rate, an unknown currency and a malformed date with 400', async () => {
    const good = { currency: 'USD', rateNpr: '133.5', rateDate: '2025-07-17' };
    for (const bad of [
      { ...good, rateNpr: '0' },
      { ...good, rateNpr: '0.000000' },
      { ...good, currency: 'NPR' },
      { ...good, rateDate: '17/07/2025' },
      { ...good, rateNpr: '1.1234567' },
    ]) {
      await expect(controller.addFxRate(bad)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(fakeMoney.setRate).not.toHaveBeenCalled();
  });

  it('POST fx-rates records a valid rate with source defaulting to manual', async () => {
    fakeMoney.setRate.mockResolvedValue({ id: 'r-1' });
    await expect(
      controller.addFxRate({ currency: 'USD', rateNpr: '133.5', rateDate: '2025-07-17' }),
    ).resolves.toEqual({ id: 'r-1' });
    expect(fakeMoney.setRate).toHaveBeenCalledWith(
      { fake: 'tx' },
      'USD',
      '133.5',
      '2025-07-17',
      'manual',
    );
  });
});

describe('SETTING_DEFAULTS', () => {
  it('has a default for every setting key', () => {
    expect(Object.keys(SETTING_DEFAULTS).sort()).toEqual([...SETTING_KEYS].sort());
  });

  it.each(SETTING_KEYS)('the default of %s satisfies its schema', (key) => {
    const schema: ZodType = SETTINGS[key];
    expect(schema.safeParse(SETTING_DEFAULTS[key]).success).toBe(true);
  });

  it('uses the plan values', () => {
    expect(SETTING_DEFAULTS['currency.enabled']).toEqual(['NPR', 'INR', 'USD']);
    expect(SETTING_DEFAULTS['tax.vat_rate']).toBe('13');
    expect(SETTING_DEFAULTS['numbering.memo_prefix']).toBe('MEMO');
    expect(SETTING_DEFAULTS['approvals.sla_defaults']).toEqual({
      remindAfterHours: 24,
      escalateAfterHours: 72,
      escalateTo: { role: 'founder' },
    });
  });

  it('uses the P2 values: 7 days of FX age, 15 days of validity, a signed quote as evidence', () => {
    expect(SETTING_DEFAULTS['fx.max_rate_age_days']).toBe(7);
    expect(SETTING_DEFAULTS['quotation.validity_days']).toBe(15);
    expect(SETTING_DEFAULTS['sales.evidence_policy']).toBe('signed_quote');
  });
});
