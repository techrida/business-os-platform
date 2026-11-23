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
  type SettingKey,
} from '@bos/contracts';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

import { can } from '../authz/can';
import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../authz/decorators';
import type { Principal } from '../authz/principal';
import { RoleCache } from '../authz/role-cache';
import { findUnmarkedRoutes } from '../authz/route-policy.check';
import { DB, type Db } from '../db/db.module';
import { MoneyService } from './money.service';
import { SettingsController } from './settings.controller';
import { SETTING_DEFAULTS, SettingsService } from './settings.service';

const scope = { tenantId: 't-1', organizationId: 'o-1' };
const actor = { kind: 'user' as const, id: 'u-1', correlationId: 'c-1' };

vi.mock('../db/tx', () => ({
  requestTx: () => ({ scope, actor }),
  withTx: (_db: unknown, _scope: unknown, _actor: unknown, fn: (tx: unknown) => unknown) =>
    fn({ fake: 'tx' }),
}));

// The settings routes check the caller's grants in the handler (settings-access.ts), so principal() is the
// caller under test. The Founder unless a test says otherwise.
let currentPrincipal: Principal;
vi.mock('../authz/principal', () => ({ principal: () => currentPrincipal }));

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
  currentPrincipal = principalOf('founder');
  controller = new SettingsController(
    {} as Db,
    fakeSettings as unknown as SettingsService,
    fakeMoney as unknown as MoneyService,
    {} as RoleCache,
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
    const LEGACY_STORED =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAA==';
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

    it('ignores forged or dropped logo-for-dark and logo-for-light pointers in the request', async () => {
      const withVariants = {
        ...stored,
        logoOnDarkDocumentId: DOC_STORED,
        logoOnLightDocumentId: null,
      };
      fakeSettings.getLocked.mockResolvedValue({ value: withVariants, version: 3 });
      fakeSettings.set.mockResolvedValue({ version: 4 });
      await controller.putSetting('entity.profile', {
        value: {
          ...withVariants,
          displayName: 'New Name',
          logoOnDarkDocumentId: null,
          logoOnLightDocumentId: DOC_ATTACKER,
        },
        expectedVersion: 3,
      });
      expect(fakeSettings.set).toHaveBeenCalledWith(
        { fake: 'tx' },
        'entity.profile',
        { ...withVariants, displayName: 'New Name' },
        { expectedVersion: 3 },
      );
    });

    it('keeps a stored legacy logo, and cannot clear the stored document id', async () => {
      const legacy = { ...stored, logoDocumentId: null, legacyLogoDataUrl: LEGACY_STORED };
      fakeSettings.getLocked.mockResolvedValue({ value: legacy, version: 5 });
      fakeSettings.set.mockResolvedValue({ version: 6 });
      await controller.putSetting('entity.profile', {
        value: {
          ...stored,
          displayName: 'New Name',
          logoDocumentId: null,
          legacyLogoDataUrl: null,
        },
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
      fakeSettings.set.mockRejectedValue(
        new BadRequestException('Invalid value for entity.profile'),
      );
      await expect(
        controller.putSetting('entity.profile', { value: 'not a profile' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fakeSettings.set).toHaveBeenCalledWith(
        { fake: 'tx' },
        'entity.profile',
        'not a profile',
      );
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

  it('the same editor is still refused every other setting (403 from the handler, nothing read)', async () => {
    currentPrincipal = editor;
    await expect(controller.getSetting('approvals.sla_defaults')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      controller.putSetting('approvals.sla_defaults', { value: {} }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fakeSettings.getCurrent).not.toHaveBeenCalled();
    expect(fakeSettings.set).not.toHaveBeenCalled();
  });

  it('a user who may neither edit workflows nor administer settings is refused both (403)', async () => {
    const plain = principalOf('management');
    expect(status(proto.approvalSlaDefaults, plain)).toBe(403);
    currentPrincipal = plain;
    await expect(controller.getSetting('tax.vat_rate')).rejects.toBeInstanceOf(ForbiddenException);
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

describe('who may read and change which setting (F1-Q48)', () => {
  // The new grants are given explicitly so these tests decide the route rule, whatever the role defaults hold.
  const finance = principalOf('finance', {
    'settings.fx_rate.write': 'all',
    'settings.finance.write': 'all',
  });
  const accountant = principalOf('accountant', { 'settings.finance.write': 'all' });
  const sales = principalOf('sales');
  const founder = principalOf('founder');
  const callers = { finance, accountant, sales, founder } as const;
  type Caller = keyof typeof callers;

  /** 200 when the handler ran, 403 when it refused; any other error fails the test. */
  async function outcome(run: () => Promise<unknown>): Promise<200 | 403> {
    try {
      await run();
      return 200;
    } catch (error) {
      if (error instanceof ForbiddenException) return 403;
      throw error;
    }
  }

  beforeEach(() => {
    fakeSettings.getCurrent.mockResolvedValue({ value: 'x', version: null });
    fakeSettings.set.mockResolvedValue({ version: 1 });
    fakeSettings.listNumberSeries.mockResolvedValue([]);
    fakeMoney.listRates.mockResolvedValue([]);
    fakeMoney.setRate.mockResolvedValue({ id: 'r-1' });
  });

  it('the grants are as described: neither Finance nor Accountant holds admin.settings.write', () => {
    expect(finance.grants.has('admin.settings.write')).toBe(false);
    expect(accountant.grants.has('admin.settings.write')).toBe(false);
    expect(accountant.grants.has('settings.fx_rate.write')).toBe(false);
    expect(sales.grants.has('settings.finance.write')).toBe(false);
    expect(founder.grants.has('admin.settings.write')).toBe(true);
  });

  // [key, finance, accountant, sales, founder]
  const keyTable: Array<[SettingKey, 200 | 403, 200 | 403, 200 | 403, 200 | 403]> = [
    ['tax.vat_rate', 200, 200, 403, 200],
    ['numbering.memo_prefix', 200, 200, 403, 200],
    ['quotation.term_presets', 200, 200, 403, 200],
    ['entity.address', 403, 403, 403, 200],
    ['quotation.validity_days', 403, 403, 403, 200],
    ['currency.enabled', 403, 403, 403, 200],
    ['fx.max_rate_age_days', 403, 403, 403, 200],
  ];

  describe.each(keyTable)('%s', (key, ...expected) => {
    const roles: Caller[] = ['finance', 'accountant', 'sales', 'founder'];
    it.each(roles.map((role, i) => [role, expected[i]] as const))(
      'PUT and GET settings/:key by %s answers %s',
      async (role, want) => {
        currentPrincipal = callers[role];
        await expect(
          outcome(() => controller.putSetting(key, { value: 'x', expectedVersion: null })),
        ).resolves.toBe(want);
        await expect(outcome(() => controller.getSetting(key))).resolves.toBe(want);
        if (want === 403) {
          expect(fakeSettings.set).not.toHaveBeenCalled();
          expect(fakeSettings.getCurrent).not.toHaveBeenCalled();
        } else {
          expect(fakeSettings.set).toHaveBeenCalledWith({ fake: 'tx' }, key, 'x', {
            expectedVersion: null,
          });
        }
      },
    );
  });

  it('an unknown key: 403 for a caller who may edit no setting, 404 for Accountant', async () => {
    currentPrincipal = sales;
    await expect(controller.getSetting('no.such_key')).rejects.toBeInstanceOf(ForbiddenException);
    currentPrincipal = accountant;
    await expect(controller.getSetting('no.such_key')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('an inactive Finance user is refused a tax key (403)', async () => {
    currentPrincipal = { ...finance, status: 'inactive' };
    await expect(controller.putSetting('tax.vat_rate', { value: '13' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('a portal user holding settings.finance.write is refused (staff only)', async () => {
    currentPrincipal = {
      ...principalOf('customer_user', { 'settings.finance.write': 'all' }),
      orgKind: 'customer',
      partyId: '20000000-0000-4000-8000-000000000001',
    };
    await expect(controller.getSetting('tax.vat_rate')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    ['finance', 200],
    ['accountant', 200],
    ['sales', 403],
    ['founder', 200],
  ] as const)('GET number-series by %s answers %s', async (role, want) => {
    currentPrincipal = callers[role];
    await expect(outcome(() => controller.numberSeries())).resolves.toBe(want);
  });

  it('settings.fx_rate.write alone does not open number-series or tax keys', async () => {
    currentPrincipal = principalOf('procurement', { 'settings.fx_rate.write': 'all' });
    await expect(outcome(() => controller.numberSeries())).resolves.toBe(403);
    await expect(outcome(() => controller.getSetting('tax.vat_rate'))).resolves.toBe(403);
    await expect(outcome(() => controller.listFxRates({}))).resolves.toBe(200);
  });

  const rate = { currency: 'USD', rateNpr: '133.5', rateDate: '2025-07-17' };

  it.each([
    ['finance', 200],
    ['accountant', 403],
    ['sales', 403],
    ['founder', 200],
  ] as const)('GET and POST fx-rates by %s answers %s', async (role, want) => {
    currentPrincipal = callers[role];
    await expect(outcome(() => controller.listFxRates({}))).resolves.toBe(want);
    await expect(outcome(() => controller.addFxRate(rate))).resolves.toBe(want);
    if (want === 403) expect(fakeMoney.setRate).not.toHaveBeenCalled();
  });

  it('Finance records a rate through withTx (201 body is the new id)', async () => {
    currentPrincipal = finance;
    await expect(controller.addFxRate(rate)).resolves.toEqual({ id: 'r-1' });
    expect(fakeMoney.setRate).toHaveBeenCalledWith(
      { fake: 'tx' },
      'USD',
      '133.5',
      '2025-07-17',
      'manual',
    );
  });

  it('an inactive Finance user is refused fx-rates (403)', async () => {
    currentPrincipal = { ...finance, status: 'inactive' };
    await expect(controller.addFxRate(rate)).rejects.toBeInstanceOf(ForbiddenException);
    expect(fakeMoney.setRate).not.toHaveBeenCalled();
  });

  it('the any-of routes are @AnyAuthenticated (no single @Can), and every route is marked', async () => {
    const proto = SettingsController.prototype;
    for (const handler of [
      proto.getSetting,
      proto.putSetting,
      proto.defaultLeadOwnerPeople,
      proto.numberSeries,
      proto.listFxRates,
      proto.addFxRate,
    ]) {
      expect(Reflect.getMetadata(CAN_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, handler)).toBe(true);
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        { provide: DB, useValue: {} },
        { provide: SettingsService, useValue: {} },
        { provide: MoneyService, useValue: {} },
        { provide: RoleCache, useValue: {} },
      ],
    }).compile();
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    await moduleRef.close();
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
