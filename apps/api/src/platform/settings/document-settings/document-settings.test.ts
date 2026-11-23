// Unit tests for the document-settings routes and service with fakes (no database, no HTTP).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/settings/document-settings/document-settings.test.ts
//
// Two layers on purpose. The service tests call DocumentSettingsService with a REAL AuthzService (its assert()
// runs the real can() on a principal built from DEFAULT_ROLE_PERMISSIONS) over an in-memory settings fake that
// behaves like the versioned store. The route tests do what the tenancy interceptor does: read the @Can marker
// of each handler and run the real can() on a principal. A direct controller call never meets @Can, so
// refusal is proven through that path, not by calling the handlers.
import 'reflect-metadata';

import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_NUMBER_SYSTEMS,
  DEFAULT_ROLE_PERMISSIONS,
  type CompanyProfile,
  type DateFormatSetting,
  type NumberSystemsSetting,
  type OrgKind,
  type Permission,
  type RoleKey,
  type TermPreset,
  EMPTY_COMPANY_PROFILE,
  sanitizeRichText,
} from '@bos/contracts';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthzService } from '../../authz/authz.service';
import { can } from '../../authz/can';
import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../../authz/decorators';
import type { Principal } from '../../authz/principal';
import type { RoleCache } from '../../authz/role-cache';
import { findUnmarkedRoutes } from '../../authz/route-policy.check';
import type { Db } from '../../db/db.module';
import type { DocumentLogoResolverFactory } from '../../../modules/images/document-logo.resolver';
import type { SettingsService } from '../settings.service';
import { DocumentSettingsController } from './document-settings.controller';
import { DocumentSettingsService } from './document-settings.service';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ENTITY = '10000000-0000-4000-8000-000000000001';
const scope = { tenantId: TENANT, organizationId: ENTITY };
const actor = { kind: 'user' as const, id: 'u-1', correlationId: 'c-1' };
const TX = { fake: 'tx' };

let currentPrincipal: Principal;
vi.mock('../../authz/principal', () => ({ principal: () => currentPrincipal }));
vi.mock('../../db/tx', () => ({
  requestTx: () => ({ scope, actor }),
  withTx: (_db: unknown, _scope: unknown, _actor: unknown, fn: (tx: unknown) => unknown) => fn(TX),
}));

/** `role`'s default grants plus `extra` (for a grant the role may or may not hold by default). */
function principalWith(role: RoleKey, extra: Partial<Record<Permission, 'all'>>): Principal {
  const base = principalOf(role);
  return {
    ...base,
    grants: new Map([...base.grants, ...(Object.entries(extra) as [Permission, never][])]),
  };
}

/** A principal holding exactly what `role` holds by default (the seed copies these into the live table). */
function principalOf(role: RoleKey, over: Partial<Principal> = {}): Principal {
  const orgKind: OrgKind =
    role === 'customer_user' ? 'customer' : role === 'vendor_user' ? 'vendor' : 'staff';
  return {
    userId: 'a0000000-0000-4000-8000-000000000001',
    zitadelUserId: 'sub-1',
    tenantId: TENANT,
    organizationId: ENTITY,
    orgKind,
    partyId: orgKind === 'staff' ? null : '20000000-0000-4000-8000-000000000001',
    idpOrgId: 'e0000000-0000-4000-8000-000000000001',
    roles: [role],
    departmentId: null,
    status: 'active',
    grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role]) as [Permission, never][]),
    ...over,
  };
}

const ID_A = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
const ID_B = '5f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
const preset = (over: Partial<TermPreset> = {}): TermPreset => ({
  id: ID_A,
  kind: 'terms_conditions',
  name: 'Standard',
  body: 'Net 30.',
  ...over,
});

interface DisplayOverrides {
  numberSystems?: NumberSystemsSetting;
  dateFormat?: DateFormatSetting;
  profile?: Partial<CompanyProfile>;
  enabledCurrencies?: string[];
}

/** An in-memory `quotation.term_presets` that records each lock, read and write, in order. */
function fakeSettings(initial: TermPreset[] = [], display: DisplayOverrides = {}) {
  const numberSystems = display.numberSystems ?? DEFAULT_NUMBER_SYSTEMS;
  const dateFormat = display.dateFormat ?? DEFAULT_DATE_FORMAT;
  const enabledCurrencies = display.enabledCurrencies ?? ['NPR', 'INR', 'USD'];
  const state = { list: initial, version: initial.length > 0 ? 1 : (null as number | null) };
  const calls: string[] = [];
  const service = {
    get: vi.fn((_scope: unknown, key: string) => {
      calls.push(`get:${key}`);
      if (key === 'entity.profile') {
        return Promise.resolve(structuredClone({ ...EMPTY_COMPANY_PROFILE, ...display.profile }));
      }
      if (key === 'format.number_systems') return Promise.resolve(structuredClone(numberSystems));
      if (key === 'format.date') return Promise.resolve(dateFormat);
      if (key === 'currency.enabled') return Promise.resolve(structuredClone(enabledCurrencies));
      return Promise.resolve(structuredClone(state.list));
    }),
    getLocked: vi.fn((_tx: unknown, key: string) => {
      calls.push(`getLocked:${key}`);
      return Promise.resolve({ value: structuredClone(state.list), version: state.version });
    }),
    set: vi.fn((_tx: unknown, key: string, value: unknown) => {
      calls.push(`set:${key}`);
      state.list = value as TermPreset[];
      state.version = (state.version ?? 0) + 1;
      return Promise.resolve({ version: state.version });
    }),
  };
  return { state, calls, service };
}

/** The logo resolver the preview reads through: answers `logo` (or throws it, when it is an Error). */
function fakeLogos(logo: string | null | Error = null) {
  const resolve = vi.fn((_documentId: string) =>
    logo instanceof Error ? Promise.reject(logo) : Promise.resolve(logo),
  );
  const forScope = vi.fn((_scope: unknown) => resolve);
  return { forScope, resolve };
}

function build(
  initial: TermPreset[] = [],
  display?: DisplayOverrides,
  logos: ReturnType<typeof fakeLogos> = fakeLogos(),
) {
  const settings = fakeSettings(initial, display);
  // Real AuthzService: assert() reads principal() (mocked above) and runs the real can().
  const authz = new AuthzService({} as Db, {} as RoleCache);
  const service = new DocumentSettingsService(
    {} as Db,
    settings.service as unknown as SettingsService,
    authz,
    { forScope: logos.forScope } as unknown as DocumentLogoResolverFactory,
  );
  return { ...settings, documentSettings: service, logos };
}

beforeEach(() => {
  currentPrincipal = principalOf('founder');
});

describe('GET settings/display', () => {
  it('returns the number systems and the date format of the acting entity for any active staff user', async () => {
    const numberSystems: NumberSystemsSetting = {
      NPR: 'international',
      INR: 'international',
      USD: 'south_asian',
    };
    for (const role of ['founder', 'sales', 'accountant', 'procurement', 'warehouse'] as const) {
      currentPrincipal = principalOf(role);
      const { documentSettings } = build([], {
        numberSystems,
        dateFormat: 'dd/MM/yyyy',
        enabledCurrencies: ['NPR', 'USD'],
      });
      await expect(documentSettings.display()).resolves.toEqual({
        numberSystems,
        dateFormat: 'dd/MM/yyyy',
        enabledCurrencies: ['NPR', 'USD'],
        sellerContact: { phones: [], email: null, signatoryName: null, signatoryTitle: null },
      });
    }
  });

  it('answers the defaults when the entity saved nothing', async () => {
    const { documentSettings } = build();
    await expect(documentSettings.display()).resolves.toEqual({
      numberSystems: DEFAULT_NUMBER_SYSTEMS,
      dateFormat: DEFAULT_DATE_FORMAT,
      enabledCurrencies: ['NPR', 'INR', 'USD'],
      sellerContact: { phones: [], email: null, signatoryName: null, signatoryTitle: null },
    });
  });

  it('returns the profile phones in print form, international for a foreign number (FX9)', async () => {
    const { documentSettings } = build([], {
      profile: {
        phones: [
          { country: 'US', e164: '+14155552671', label: 'work' },
          { country: 'NP', e164: '+97714123456' },
        ],
        email: 'hello@techrida.test',
        signatoryName: 'Asha Rai',
      },
    });
    const { sellerContact } = await documentSettings.display();
    expect(sellerContact).toEqual({
      phones: ['+1 415 555 2671', '+977 1-4123456'],
      email: 'hello@techrida.test',
      signatoryName: 'Asha Rai',
      signatoryTitle: null,
    });
  });

  it('answers an empty contact block, not a failure, for a profile that does not validate', async () => {
    const { documentSettings } = build([], {
      profile: { phones: ['01-4123456'] as unknown as CompanyProfile['phones'], email: 'a@b.test' },
    });
    await expect(documentSettings.display()).resolves.toMatchObject({
      dateFormat: DEFAULT_DATE_FORMAT,
      sellerContact: { phones: [], email: null, signatoryName: null, signatoryTitle: null },
    });
  });

  it('reads format.number_systems and format.date in the caller entity scope', async () => {
    currentPrincipal = principalOf('sales');
    const { documentSettings, service } = build();
    await documentSettings.display();
    expect(service.get).toHaveBeenCalledWith(scope, 'format.number_systems');
    expect(service.get).toHaveBeenCalledWith(scope, 'format.date');
    expect(service.get).not.toHaveBeenCalledWith(scope, 'format.number_system');
  });

  it.each(['customer_user', 'vendor_user'] as const)(
    'refuses a portal user (%s) with 403',
    async (role) => {
      currentPrincipal = principalOf(role);
      const { documentSettings, service } = build();
      await expect(documentSettings.display()).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.get).not.toHaveBeenCalled();
    },
  );

  it('refuses a staff user who is not active', async () => {
    currentPrincipal = principalOf('sales', { status: 'inactive' });
    const { documentSettings } = build();
    await expect(documentSettings.display()).rejects.toMatchObject({
      response: { reason: 'inactive_user' },
    });
  });
});

describe('GET term-presets', () => {
  const stored = [
    preset({ id: ID_B, kind: 'scope', name: 'beta', body: 'b' }),
    preset({ id: ID_A, kind: 'terms_conditions', name: 'Standard' }),
    preset({ id: '6f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f', kind: 'scope', name: 'Alpha', body: 'a' }),
  ];

  it('lets a quotation.draft holder (sales) read, sorted by kind then name', async () => {
    currentPrincipal = principalOf('sales');
    const { documentSettings } = build(stored);
    const list = await documentSettings.list({});
    expect(list.map((p) => `${p.kind}/${p.name}`)).toEqual([
      'scope/Alpha',
      'scope/beta',
      'terms_conditions/Standard',
    ]);
  });

  it('lets an admin.settings.write holder read', async () => {
    const { documentSettings } = build(stored);
    await expect(documentSettings.list({})).resolves.toHaveLength(3);
  });

  it('filters by kind', async () => {
    currentPrincipal = principalOf('sales');
    const { documentSettings } = build(stored);
    const list = await documentSettings.list({ kind: 'scope' });
    expect(list.map((p) => p.name)).toEqual(['Alpha', 'beta']);
  });

  it('answers 400 for an unknown kind', async () => {
    const { documentSettings } = build(stored);
    await expect(documentSettings.list({ kind: 'nope' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a staff user who holds neither permission (a role without quotation.draft), before reading', async () => {
    // procurement holds no quotation.draft and no admin.settings.write by default.
    currentPrincipal = principalOf('procurement');
    expect(currentPrincipal.grants.has('quotation.draft')).toBe(false);
    const { documentSettings, service } = build(stored);
    await expect(documentSettings.list({})).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.get).not.toHaveBeenCalled();
  });

  it.each(['customer_user', 'vendor_user'] as const)(
    'refuses a portal user (%s) even if a grant were present',
    async (role) => {
      // Hand the portal caller both reader permissions: only the staff check can stop them now.
      currentPrincipal = principalOf(role, {
        grants: new Map<Permission, never>([
          ['quotation.draft', 'all' as never],
          ['admin.settings.write', 'all' as never],
        ]),
      });
      const { documentSettings, service } = build(stored);
      await expect(documentSettings.list({})).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.get).not.toHaveBeenCalled();
    },
  );

  it('refuses a portal user on the default role grants too', async () => {
    currentPrincipal = principalOf('customer_user');
    const { documentSettings } = build(stored);
    await expect(documentSettings.list({})).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('POST / PATCH / DELETE term presets', () => {
  it('create: appends a preset with a server-made id, inside one read-modify-write (lock, read, then set)', async () => {
    const { documentSettings, state, calls } = build([preset()]);
    const created = await documentSettings.create({
      kind: 'scope',
      name: '  Fixed price  ',
      body: 'We build X.',
    });
    expect(created).toMatchObject({ kind: 'scope', name: 'Fixed price', body: 'We build X.' });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.id).not.toBe(ID_A);
    expect(state.list).toHaveLength(2);
    expect(state.list).toContainEqual(created);
    // The lock-taking read comes first, and the plain unlocked get is never used for a write.
    expect(calls).toEqual(['getLocked:quotation.term_presets', 'set:quotation.term_presets']);
  });

  it('create: ignores a client-sent id by refusing it (strict body)', async () => {
    const { documentSettings, service } = build();
    await expect(
      documentSettings.create({ id: ID_A, kind: 'scope', name: 'x', body: 'y' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.set).not.toHaveBeenCalled();
  });

  it('create: 409 with a clear message for a duplicate name within a kind, case-insensitive', async () => {
    const { documentSettings, service } = build([preset({ name: 'Standard' })]);
    const attempt = documentSettings.create({
      kind: 'terms_conditions',
      name: 'STANDARD',
      body: 'other',
    });
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(/already exists.*different name/i);
    expect(service.set).not.toHaveBeenCalled();
  });

  it('create: the same name in a different kind is allowed', async () => {
    const { documentSettings, state } = build([preset({ name: 'Standard' })]);
    await documentSettings.create({ kind: 'scope', name: 'Standard', body: 'x' });
    expect(state.list).toHaveLength(2);
  });

  it('create: 400 for a body over 10,000 characters, an empty name, a name over 80, and an unknown kind', async () => {
    const { documentSettings, service } = build();
    const ok = { kind: 'scope', name: 'n', body: 'b' };
    for (const bad of [
      { ...ok, body: 'x'.repeat(10_001) },
      { ...ok, name: '   ' },
      { ...ok, name: 'n'.repeat(81) },
      { ...ok, kind: 'po_terms' },
      { ...ok, body: '' },
      { kind: 'scope', name: 'n' },
    ]) {
      await expect(documentSettings.create(bad)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(service.set).not.toHaveBeenCalled();
  });

  it('create: accepts a body of exactly 10,000 characters', async () => {
    const { documentSettings } = build();
    await expect(
      documentSettings.create({ kind: 'scope', name: 'n', body: 'x'.repeat(10_000) }),
    ).resolves.toBeDefined();
  });

  it('create: 400 (not a silent drop) when the list would pass 200 presets', async () => {
    const full = Array.from({ length: 200 }, (_, i) =>
      preset({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `n${i}` }),
    );
    const { documentSettings, service } = build(full);
    await expect(
      documentSettings.create({ kind: 'scope', name: 'one more', body: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.set).not.toHaveBeenCalled();
  });

  it('patch: changes name and body, keeps kind and id, returns the preset', async () => {
    const { documentSettings, state } = build([preset(), preset({ id: ID_B, name: 'Other' })]);
    const updated = await documentSettings.update(ID_A, { name: 'Renamed', body: 'New body' });
    expect(updated).toEqual({
      id: ID_A,
      kind: 'terms_conditions',
      name: 'Renamed',
      body: 'New body',
    });
    expect(state.list.find((p) => p.id === ID_A)).toEqual(updated);
    expect(state.list.find((p) => p.id === ID_B)?.name).toBe('Other');
  });

  it('patch: body only', async () => {
    const { documentSettings, state } = build([preset()]);
    await documentSettings.update(ID_A, { body: 'Only the body' });
    expect(state.list[0]).toEqual(preset({ body: 'Only the body' }));
  });

  it('patch: renaming to its own name in another case is allowed (not a duplicate of itself)', async () => {
    const { documentSettings, state } = build([preset({ name: 'Standard' })]);
    await documentSettings.update(ID_A, { name: 'STANDARD' });
    expect(state.list[0]?.name).toBe('STANDARD');
  });

  it('patch: 409 when the new name is taken by another preset of the same kind', async () => {
    const { documentSettings, service } = build([preset(), preset({ id: ID_B, name: 'Other' })]);
    await expect(documentSettings.update(ID_B, { name: 'standard' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(service.set).not.toHaveBeenCalled();
  });

  it('patch: 404 for an unknown id, and nothing is written', async () => {
    const { documentSettings, service } = build([preset()]);
    await expect(documentSettings.update(ID_B, { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(documentSettings.update('not-a-uuid', { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(service.set).not.toHaveBeenCalled();
  });

  it('patch: 400 for an empty patch, a kind change, a body over the limit', async () => {
    const { documentSettings, service } = build([preset()]);
    for (const bad of [
      {},
      { kind: 'scope', name: 'x' },
      { body: 'x'.repeat(10_001) },
      { name: '' },
    ]) {
      await expect(documentSettings.update(ID_A, bad)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(service.set).not.toHaveBeenCalled();
  });

  it('patch: an unchanged value writes no new version', async () => {
    const { documentSettings, service } = build([preset()]);
    await expect(
      documentSettings.update(ID_A, { name: 'Standard', body: 'Net 30.' }),
    ).resolves.toEqual(preset());
    expect(service.set).not.toHaveBeenCalled();
  });

  it('delete: removes only that preset', async () => {
    const { documentSettings, state } = build([preset(), preset({ id: ID_B, name: 'Other' })]);
    await expect(documentSettings.remove(ID_A)).resolves.toBeUndefined();
    expect(state.list.map((p) => p.id)).toEqual([ID_B]);
  });

  it('delete: 404 for an unknown id, and nothing is written', async () => {
    const { documentSettings, service } = build([preset()]);
    await expect(documentSettings.remove(ID_B)).rejects.toBeInstanceOf(NotFoundException);
    expect(service.set).not.toHaveBeenCalled();
  });

  it.each(['sales', 'management', 'procurement'] as const)(
    'the service itself refuses a write from %s, who holds neither settings.finance.write nor admin.settings.write',
    async (role) => {
      currentPrincipal = principalOf(role);
      const { documentSettings, service } = build([preset()]);
      await expect(
        documentSettings.create({ kind: 'scope', name: 'n', body: 'b' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(documentSettings.update(ID_A, { name: 'n' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(documentSettings.remove(ID_A)).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.getLocked).not.toHaveBeenCalled();
      expect(service.set).not.toHaveBeenCalled();
    },
  );
});

describe('term set bodies and who may change them (real write path, fake settings)', () => {
  const dirty = '<p>ok</p><script>alert(1)</script><a href="javascript:x">l</a>';

  it('create: stores the sanitised body, not the markup that was sent', async () => {
    const { documentSettings, state } = build();
    const created = await documentSettings.create({ kind: 'scope', name: 'Dirty', body: dirty });
    // The script is dropped with its content, the link loses its tag and href, its text becomes a paragraph.
    expect(sanitizeRichText(dirty)).toBe('<p>ok</p><p>l</p>');
    expect(created.body).toBe('<p>ok</p><p>l</p>');
    expect(state.list).toEqual([created]);
    expect(JSON.stringify(state.list)).not.toMatch(/script|javascript|href|alert/);
  });

  it('patch: sanitises the new body the same way', async () => {
    const { documentSettings, state } = build([preset()]);
    const updated = await documentSettings.update(ID_A, { body: dirty });
    expect(updated.body).toBe('<p>ok</p><p>l</p>');
    expect(state.list[0]?.body).toBe('<p>ok</p><p>l</p>');
  });

  it('create: a plain-text legacy body is stored unchanged', async () => {
    const { documentSettings, state } = build();
    const body = 'Net 30 days.\n\nLate fees apply: 2% & interest < 5%.';
    const created = await documentSettings.create({ kind: 'payment_terms', name: 'Legacy', body });
    expect(created.body).toBe(body);
    expect(state.list[0]?.body).toBe(body);
  });

  it('create: a rich body whose words pass the 10,000 character cap is a 400, and nothing is written', async () => {
    const { documentSettings, service } = build();
    const over = `<p>${'x'.repeat(10_001)}</p>`;
    const attempt = documentSettings.create({ kind: 'scope', name: 'Long', body: over });
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toThrow(/at most 10000 characters/);
    await expect(documentSettings.update(ID_A, { body: over })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.set).not.toHaveBeenCalled();
  });

  it('create: the cap counts the words, not the markup around them', async () => {
    const { documentSettings } = build();
    // 70,000 characters of markup around 7,000 of words: under the cap by words, far over it by length.
    const bold = `<p>${'<em>x</em>'.repeat(7_000)}</p>`;
    await expect(
      documentSettings.create({ kind: 'scope', name: 'Marked up', body: bold }),
    ).resolves.toBeDefined();
    await expect(
      documentSettings.create({
        kind: 'scope',
        name: 'Exactly the cap',
        body: `<p>${'x'.repeat(10_000)}</p>`,
      }),
    ).resolves.toBeDefined();
  });

  it('a user holding only quotation.draft can list but gets 403 on create, patch and delete', async () => {
    currentPrincipal = principalOf('sales', {
      grants: new Map<Permission, never>([['quotation.draft', 'all' as never]]),
    });
    expect(currentPrincipal.grants.has('admin.settings.write')).toBe(false);
    const { documentSettings, service } = build([preset()]);
    await expect(documentSettings.list({})).resolves.toHaveLength(1);
    const body = { kind: 'scope', name: 'n', body: 'b' };
    await expect(documentSettings.create(body)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(documentSettings.update(ID_A, { name: 'n' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(documentSettings.remove(ID_A)).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.getLocked).not.toHaveBeenCalled();
    expect(service.set).not.toHaveBeenCalled();
  });

  it('a founder without admin.settings.write (grant removed) is refused like anyone else', async () => {
    const grants = new Map(currentPrincipal.grants);
    grants.delete('admin.settings.write');
    grants.delete('settings.finance.write');
    currentPrincipal = principalOf('founder', { grants });
    const { documentSettings, service } = build([preset()]);
    await expect(
      documentSettings.create({ kind: 'scope', name: 'n', body: 'b' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.set).not.toHaveBeenCalled();
  });
});

describe('term preset writes by Finance and Accountant (F1-Q48: settings.finance.write)', () => {
  const editors = [
    ['finance', principalWith('finance', { 'settings.finance.write': 'all' })],
    ['accountant', principalWith('accountant', { 'settings.finance.write': 'all' })],
  ] as const;

  it.each(editors)('%s may create, rename and delete a preset (200)', async (_role, caller) => {
    expect(caller.grants.has('admin.settings.write')).toBe(false);
    currentPrincipal = caller;
    const { documentSettings, state } = build([preset()]);
    const created = await documentSettings.create({ kind: 'scope', name: 'New', body: 'b' });
    expect(state.list.map((p) => p.id)).toContain(created.id);
    await expect(documentSettings.update(ID_A, { name: 'Renamed' })).resolves.toMatchObject({
      name: 'Renamed',
    });
    await expect(documentSettings.remove(ID_A)).resolves.toBeUndefined();
    expect(state.list.map((p) => p.id)).toEqual([created.id]);
    // The Terms page lists them too.
    await expect(documentSettings.list({})).resolves.toHaveLength(1);
  });

  it.each(editors)('%s is refused when inactive (403, nothing read)', async (_role, caller) => {
    currentPrincipal = { ...caller, status: 'inactive' };
    const { documentSettings, service } = build([preset()]);
    await expect(
      documentSettings.create({ kind: 'scope', name: 'n', body: 'b' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.getLocked).not.toHaveBeenCalled();
  });

  it('a portal user holding settings.finance.write is still refused (staff only)', async () => {
    currentPrincipal = principalWith('customer_user', { 'settings.finance.write': 'all' });
    const { documentSettings, service } = build([preset()]);
    await expect(documentSettings.remove(ID_A)).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.set).not.toHaveBeenCalled();
  });

  it('settings.fx_rate.write alone does not open the presets', async () => {
    currentPrincipal = principalWith('procurement', { 'settings.fx_rate.write': 'all' });
    const { documentSettings } = build([preset()]);
    await expect(
      documentSettings.create({ kind: 'scope', name: 'n', body: 'b' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('Finance with settings.finance.write still gets 403 on the document preview (Founder only)', async () => {
    currentPrincipal = principalWith('finance', { 'settings.finance.write': 'all' });
    const { documentSettings } = build([preset()]);
    await expect(
      documentSettings.previewDocument({ layout: 'classic', primaryColour: '#1F4E79' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('route guards (what the tenancy interceptor enforces before a handler runs)', () => {
  const proto = DocumentSettingsController.prototype;

  /** The interceptor's decision for one handler: @Can runs can(); @AnyAuthenticated needs an active user. */
  function routeAllows(handler: (...args: never[]) => unknown, caller: Principal): boolean {
    const action = Reflect.getMetadata(CAN_KEY, handler) as Permission | undefined;
    if (action !== undefined) return can(caller, action).allowed;
    if (Reflect.getMetadata(ANY_AUTHENTICATED_KEY, handler) === true)
      return caller.status === 'active';
    return false;
  }

  const writes = [['POST admin/settings/documents/preview', proto.preview]] as const;
  const presetWrites = [
    ['POST admin/term-presets', proto.create],
    ['PATCH admin/term-presets/:id', proto.update],
    ['DELETE admin/term-presets/:id', proto.remove],
  ] as const;

  it.each(writes)('%s is gated by admin.settings.write', (_name, handler) => {
    expect(Reflect.getMetadata(CAN_KEY, handler)).toBe('admin.settings.write');
  });

  it.each(presetWrites)(
    '%s lets an active user in and leaves the any-of check to the service',
    (_name, handler) => {
      expect(Reflect.getMetadata(CAN_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, handler)).toBe(true);
      expect(routeAllows(handler, principalOf('sales', { status: 'inactive' }))).toBe(false);
    },
  );

  it.each(writes)(
    '%s: the Founder passes; every other role and a portal user are refused',
    (_name, handler) => {
      expect(routeAllows(handler, principalOf('founder'))).toBe(true);
      const others: RoleKey[] = [
        'management',
        'finance',
        'accountant',
        'sales',
        'customer_user',
        'vendor_user',
        'pmo',
        'operations_head',
        'procurement',
        'warehouse',
        'operations_officer',
      ];
      for (const role of others) {
        expect(routeAllows(handler, principalOf(role)), role).toBe(false);
      }
    },
  );

  it('a quotation.draft holder (sales) can GET presets but is refused on POST', async () => {
    const sales = principalOf('sales');
    expect(sales.grants.has('quotation.draft')).toBe(true);
    // The GET routes are @AnyAuthenticated: the route lets an active user in and the service checks the permission.
    expect(routeAllows(proto.list, sales)).toBe(true);
    currentPrincipal = sales;
    const { documentSettings } = build([preset()]);
    await expect(documentSettings.list({})).resolves.toHaveLength(1);
    // The write route lets the active user in too; the service refuses (no settings.finance.write).
    expect(routeAllows(proto.create, sales)).toBe(true);
    await expect(
      documentSettings.create({ kind: 'scope', name: 'n', body: 'b' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the display read has no permission requirement beyond an active session; an inactive user is refused', () => {
    expect(Reflect.getMetadata(CAN_KEY, proto.display)).toBeUndefined();
    expect(routeAllows(proto.display, principalOf('warehouse'))).toBe(true);
    expect(routeAllows(proto.display, principalOf('sales', { status: 'inactive' }))).toBe(false);
  });

  it('every route is marked, so the route-policy sweep finds nothing unmarked', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DocumentSettingsController],
      providers: [{ provide: DocumentSettingsService, useValue: {} }],
    }).compile();
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    await moduleRef.close();
  });

  it('the controller passes its input to the service unchanged', async () => {
    const service = {
      display: vi.fn().mockResolvedValue({
        numberSystems: DEFAULT_NUMBER_SYSTEMS,
        dateFormat: DEFAULT_DATE_FORMAT,
      }),
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(preset()),
      update: vi.fn().mockResolvedValue(preset()),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new DocumentSettingsController(
      service as unknown as DocumentSettingsService,
    );
    await controller.list({ kind: 'scope' });
    await controller.create({ a: 1 });
    await controller.update(ID_A, { b: 2 });
    await controller.remove(ID_A);
    expect(service.list).toHaveBeenCalledWith({ kind: 'scope' });
    expect(service.create).toHaveBeenCalledWith({ a: 1 });
    expect(service.update).toHaveBeenCalledWith(ID_A, { b: 2 });
    expect(service.remove).toHaveBeenCalledWith(ID_A);
  });
});

describe('POST admin/settings/documents/preview', () => {
  it('draws the sample quotation in the chosen layout and colour for the founder', async () => {
    // The sample quotation is in NPR, so the NPR entry of the setting decides the grouping.
    const { documentSettings, service } = build([], {
      numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'south_asian' },
      dateFormat: 'dd/MM/yyyy',
    });
    const { html } = await documentSettings.previewDocument({
      layout: 'ledger',
      primaryColour: '#BE123C',
    });
    expect(html).toContain('#be123c');
    expect(html).toContain('Quotation');
    expect(html).toContain('Million');
    // The sample's issue date (2026-11-19) is drawn in the saved date format.
    expect(html).toContain('19/11/2026');
    expect(service.get).toHaveBeenCalledWith(scope, 'format.number_systems');
    expect(service.get).toHaveBeenCalledWith(scope, 'format.date');
  });

  it('draws the lakh system and the default date format when the entity saved nothing', async () => {
    const { documentSettings } = build();
    const { html } = await documentSettings.previewDocument({
      layout: 'banded',
      primaryColour: '#1d4ed8',
    });
    expect(html).not.toContain('Million');
    expect(html).toContain('19 Nov 2026');
  });

  describe('the logo', () => {
    const LOGO_DOC = '7f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
    const png = (n: number) =>
      `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]).toString('base64')}`;
    const UPLOADED = png(1);
    const LEGACY = png(2);
    const preview = (documentSettings: DocumentSettingsService) =>
      documentSettings.previewDocument({ layout: 'banded', primaryColour: '#1d4ed8' });

    it('draws the uploaded logo, read through the resolver of the request scope', async () => {
      const logos = fakeLogos(UPLOADED);
      const { documentSettings } = build(
        [],
        { profile: { logoDocumentId: LOGO_DOC, legacyLogoDataUrl: LEGACY } },
        logos,
      );
      const { html } = await preview(documentSettings);
      expect(html).toContain(UPLOADED);
      expect(html).not.toContain(LEGACY);
      expect(logos.forScope).toHaveBeenCalledWith(scope);
      expect(logos.resolve).toHaveBeenCalledWith(
        LOGO_DOC,
        expect.objectContaining({ onDarkDocumentId: null, onLightDocumentId: null }),
      );
    });

    it('falls back to the legacy logo when the document gives none', async () => {
      const { documentSettings } = build(
        [],
        { profile: { logoDocumentId: LOGO_DOC, legacyLogoDataUrl: LEGACY } },
        fakeLogos(null),
      );
      expect((await preview(documentSettings)).html).toContain(LEGACY);
    });

    it('draws the legacy logo without asking the resolver when no document is set', async () => {
      const logos = fakeLogos(UPLOADED);
      const { documentSettings } = build([], { profile: { legacyLogoDataUrl: LEGACY } }, logos);
      expect((await preview(documentSettings)).html).toContain(LEGACY);
      expect(logos.resolve).not.toHaveBeenCalled();
    });

    it('draws the legacy logo of a profile saved before logoDocumentId existed', async () => {
      // SettingsService.get returns the stored JSON as saved, without the schema's defaults.
      const logos = fakeLogos(new Error('no document id'));
      const { documentSettings } = build(
        [],
        // Cast: the type says the field is always there; the old stored row does not have it.
        {
          profile: {
            logoDocumentId: undefined,
            legacyLogoDataUrl: LEGACY,
          } as unknown as Partial<CompanyProfile>,
        },
        logos,
      );
      expect((await preview(documentSettings)).html).toContain(LEGACY);
      expect(logos.resolve).not.toHaveBeenCalled();
    });

    it('still draws the preview, without a logo and with a warning, when the resolver fails', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { documentSettings } = build(
        [],
        { profile: { logoDocumentId: LOGO_DOC, legacyLogoDataUrl: LEGACY } },
        fakeLogos(new Error('EIO')),
      );
      const { html } = await preview(documentSettings);
      expect(html).toContain('Quotation');
      expect(html).not.toContain('data:image/');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  it('refuses anyone without admin.settings.write', async () => {
    currentPrincipal = principalOf('sales');
    const { documentSettings } = build();
    await expect(
      documentSettings.previewDocument({ layout: 'banded', primaryColour: '#1d4ed8' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a bad colour or an unknown layout with 400', async () => {
    const { documentSettings } = build();
    await expect(
      documentSettings.previewDocument({ layout: 'banded', primaryColour: 'red' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      documentSettings.previewDocument({ layout: 'nope', primaryColour: '#1d4ed8' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
