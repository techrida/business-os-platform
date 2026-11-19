// Unit tests for SettingsController (fakes, no database) and for the built-in setting defaults.
// Run with: pnpm --filter @bos/api exec vitest run src/platform/settings/settings.controller.test.ts
//
// The controller's own job is routing and validation: an unknown key is a 404, a bad body is a 400, and a
// write runs inside withTx with the caller's scope. withTx and requestTx are replaced so no request or
// database is needed; the real behaviour against Postgres is covered in settings.integration.test.ts.
import 'reflect-metadata';

import {
  DEFAULT_ROLE_PERMISSIONS,
  SETTINGS,
  SETTING_KEYS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

import { can } from '../authz/can';
import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../authz/decorators';
import type { Principal } from '../authz/principal';
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
  getLocked: vi.fn(),
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

  describe('PUT entity.profile keeps the stored logo', () => {
    const DOC_STORED = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
    const DOC_ATTACKER = '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b';
    const LEGACY_STORED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAA==';
    const LEGACY_ATTACKER = 'data:image/png;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==';
    const stored = {
      ...SETTING_DEFAULTS['entity.profile'],
      displayName: 'Old Name',
      logoDocumentId: DOC_STORED,
    };

    it('ignores a logoDocumentId and legacyLogoDataUrl in the request and saves the other fields', async () => {
      fakeSettings.getLocked.mockResolvedValue({ value: stored, version: 3 });
      fakeSettings.set.mockResolvedValue({ version: 4 });
      await expect(
        controller.putSetting('entity.profile', {
          value: {
            ...stored,
            displayName: 'New Name',
            logoDocumentId: DOC_ATTACKER,
            legacyLogoDataUrl: LEGACY_ATTACKER,
          },
          expectedVersion: 3,
        }),
      ).resolves.toEqual({ version: 4 });
      // Read under the setting lock, on the write transaction.
      expect(fakeSettings.getLocked).toHaveBeenCalledWith({ fake: 'tx' }, 'entity.profile');
      expect(fakeSettings.set).toHaveBeenCalledWith(
        { fake: 'tx' },
        'entity.profile',
        { ...stored, displayName: 'New Name', logoDocumentId: DOC_STORED },
        { expectedVersion: 3 },
      );
    });

    it('keeps a stored legacy logo, and cannot clear the stored document id', async () => {
      const legacy = { ...stored, logoDocumentId: null, legacyLogoDataUrl: LEGACY_STORED };
      fakeSettings.getLocked.mockResolvedValue({ value: legacy, version: 5 });
      fakeSettings.set.mockResolvedValue({ version: 6 });
      await controller.putSetting('entity.profile', {
        value: { ...stored, displayName: 'New Name', logoDocumentId: null, legacyLogoDataUrl: null },
      });
      expect(fakeSettings.set).toHaveBeenCalledWith({ fake: 'tx' }, 'entity.profile', {
        ...stored,
        displayName: 'New Name',
        logoDocumentId: null,
        legacyLogoDataUrl: LEGACY_STORED,
      });

      fakeSettings.getLocked.mockResolvedValue({ value: stored, version: 6 });
      await controller.putSetting('entity.profile', {
        value: { ...stored, logoDocumentId: null },
      });
      expect(fakeSettings.set).toHaveBeenLastCalledWith({ fake: 'tx' }, 'entity.profile', stored);
    });

    it('cannot add a legacy logo where none is stored', async () => {
      fakeSettings.getLocked.mockResolvedValue({ value: stored, version: 2 });
      fakeSettings.set.mockResolvedValue({ version: 3 });
      await controller.putSetting('entity.profile', {
        value: { ...stored, legacyLogoDataUrl: LEGACY_ATTACKER },
      });
      const saved = fakeSettings.set.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(saved).not.toHaveProperty('legacyLogoDataUrl');
      expect(saved['logoDocumentId']).toBe(DOC_STORED);
    });

    it('passes a value that is not an object on for the service to refuse', async () => {
      fakeSettings.getLocked.mockResolvedValue({ value: stored, version: 2 });
      fakeSettings.set.mockRejectedValue(new BadRequestException('Invalid value for entity.profile'));
      await expect(
        controller.putSetting('entity.profile', { value: 'not a profile' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fakeSettings.set).toHaveBeenCalledWith({ fake: 'tx' }, 'entity.profile', 'not a profile');
    });

    it('leaves other keys alone: no profile read, the value passed through as sent', async () => {
      fakeSettings.set.mockResolvedValue({ version: 2 });
      await controller.putSetting('tax.vat_rate', { value: '15' });
      expect(fakeSettings.getLocked).not.toHaveBeenCalled();
      expect(fakeSettings.set).toHaveBeenCalledWith({ fake: 'tx' }, 'tax.vat_rate', '15');
    });
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

describe('GET approval-sla-defaults (the default approval times for workflow editors)', () => {
  const proto = SettingsController.prototype;
  const reflector = new Reflector();

  /** A staff principal holding what `role` holds by default, plus `extra` grants. */
  function principalOf(role: RoleKey, extra: Partial<Record<Permission, Scope>> = {}): Principal {
    return {
      userId: 'a0000000-0000-4000-8000-000000000001',
      zitadelUserId: 'sub-1',
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      orgKind: 'staff',
      partyId: null,
      idpOrgId: 'e0000000-0000-4000-8000-000000000001',
      roles: [role],
      departmentId: null,
      status: 'active',
      grants: new Map(
        Object.entries({ ...DEFAULT_ROLE_PERMISSIONS[role], ...extra }) as [Permission, Scope][],
      ),
    };
  }

  /**
   * The tenancy interceptor's route decision, step for step: the real Reflector reads @Can from the
   * handler then the class, the real can() decides; @AnyAuthenticated needs an active user; an
   * unmarked route is refused. 200 when allowed, 403 when refused.
   */
  function status(handler: (...args: never[]) => unknown, caller: Principal): 200 | 403 {
    const targets = [handler, SettingsController];
    const action = reflector.getAllAndOverride<Permission | undefined>(CAN_KEY, targets);
    if (action !== undefined) return can(caller, action).allowed ? 200 : 403;
    const any = reflector.getAllAndOverride<boolean | undefined>(ANY_AUTHENTICATED_KEY, targets);
    return any === true && caller.status === 'active' ? 200 : 403;
  }

  // No default role but the Founder edits workflows, so the editor is Management granted just that.
  const editor = principalOf('management', { 'approvals.definitions.write': 'all' });

  it('a non-admin who may edit workflows gets the saved value (200)', async () => {
    expect(can(editor, 'admin.settings.write').allowed).toBe(false);
    expect(status(proto.approvalSlaDefaults, editor)).toBe(200);
    const saved = {
      remindAfterHours: 8,
      escalateAfterHours: 36,
      escalateTo: { role: 'management' },
    };
    fakeSettings.getCurrent.mockResolvedValue({ value: saved, version: 3 });
    await expect(controller.approvalSlaDefaults()).resolves.toEqual({
      key: 'approvals.sla_defaults',
      value: saved,
      version: 3,
    });
    expect(fakeSettings.getCurrent).toHaveBeenCalledWith(scope, 'approvals.sla_defaults');
  });

  it('the same editor is still refused every other setting (403)', () => {
    expect(status(proto.getSetting, editor)).toBe(403);
    expect(status(proto.putSetting, editor)).toBe(403);
  });

  it('a user who may neither edit workflows nor administer settings is refused both (403)', () => {
    const plain = principalOf('management');
    expect(status(proto.approvalSlaDefaults, plain)).toBe(403);
    expect(status(proto.getSetting, plain)).toBe(403);
  });

  it('the Founder reads it too; a portal user does not', () => {
    expect(status(proto.approvalSlaDefaults, principalOf('founder'))).toBe(200);
    expect(
      status(proto.approvalSlaDefaults, {
        ...principalOf('customer_user'),
        orgKind: 'customer',
        partyId: '20000000-0000-4000-8000-000000000001',
      }),
    ).toBe(403);
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
