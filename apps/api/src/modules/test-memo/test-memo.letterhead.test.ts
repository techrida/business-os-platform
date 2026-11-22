// The memo letterhead (U12): the directory shows the live address, logo and colour; submit freezes them. Unit level,
// on a settings fake and a resolver fake; the database wiring of directory() and submit() is the integration test's.
import {
  DEFAULT_BRAND_COLOUR,
  EMPTY_COMPANY_PROFILE,
  type MemoApproverRule,
  type MemoDirectory,
  type MemoTemplateSnapshot,
} from '@bos/contracts';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { TxScope } from '../../platform/db/tx';
import type { DocumentLogoResolverFactory } from '../images/document-logo.resolver';
import {
  DocumentLogoUnavailableError,
  type DocumentLogoResolver,
} from '../quotations/render/issuer';
import {
  buildMemoLetterhead,
  LetterheadInvalidError,
  TestMemoService,
  type LetterheadSettings,
} from './test-memo.service';
import type { TestMemoCaller } from './test-memo.caller';

const scope: TxScope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
};
const LOGO_ID = '33333333-3333-4333-8333-333333333333';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const NEW_PNG = 'data:image/png;base64,AAAAAAAA';
const LEGACY = 'data:image/jpeg;base64,/9j/4AAQ';

type Values = Record<string, unknown>;

/** A settings fake over a plain record: change `values` and the next read sees it, as a settings write would. */
function fakeSettings(values: Values): LetterheadSettings {
  return {
    get: ((_scope: TxScope, key: string) =>
      Promise.resolve(key in values ? values[key] : null)) as LetterheadSettings['get'],
  };
}

const address = { line: 'Balaju', city: 'Kathmandu', country: 'NP' };

const settingsValues = (over: Values = {}): Values => ({
  'entity.address': address,
  'entity.profile': { ...EMPTY_COMPANY_PROFILE, logoDocumentId: LOGO_ID },
  'document.style': { layout: 'banded', primaryColour: '#0f766e' },
  ...over,
});

const quietLog = () => ({ warn: vi.fn() });
const resolvesTo =
  (dataUrl: string | null): DocumentLogoResolver =>
  () =>
    Promise.resolve(dataUrl);
const failing: DocumentLogoResolver = () => Promise.reject(new Error('disk gone'));

describe('buildMemoLetterhead', () => {
  it('reads the live address, logo bytes and brand colour', async () => {
    const letterhead = await buildMemoLetterhead(
      fakeSettings(settingsValues()),
      scope,
      resolvesTo(PNG),
      'live',
      quietLog(),
    );
    // The footer's parts (the address line, the city, the country name), one per line.
    expect(letterhead).toEqual({
      addressLines: ['Balaju', 'Kathmandu', 'Nepal'],
      logoDataUrl: PNG,
      primaryColour: '#0f766e',
    });
  });

  it('freezes an address whose line and city are each at their cap', async () => {
    const line = 'L'.repeat(300);
    const city = 'C'.repeat(100);
    const letterhead = await buildMemoLetterhead(
      fakeSettings(settingsValues({ 'entity.address': { ...address, line, city } })),
      scope,
      resolvesTo(PNG),
      'freeze',
      quietLog(),
    );
    expect(letterhead?.addressLines).toEqual([line, city, 'Nepal']);
  });

  it('has no address lines when no address is set, and the default colour when no style is', async () => {
    const letterhead = await buildMemoLetterhead(
      fakeSettings(settingsValues({ 'entity.address': null, 'document.style': undefined })),
      scope,
      resolvesTo(PNG),
      'live',
      quietLog(),
    );
    expect(letterhead?.addressLines).toEqual([]);
    expect(letterhead?.primaryColour).toBe(DEFAULT_BRAND_COLOUR);
  });

  it('falls back to the legacy logo, then to none', async () => {
    const legacyProfile = {
      ...EMPTY_COMPANY_PROFILE,
      logoDocumentId: LOGO_ID,
      legacyLogoDataUrl: LEGACY,
    };
    const unresolved = await buildMemoLetterhead(
      fakeSettings(settingsValues({ 'entity.profile': legacyProfile })),
      scope,
      resolvesTo(null),
      'freeze',
      quietLog(),
    );
    expect(unresolved?.logoDataUrl).toBe(LEGACY);
    const noDocument = await buildMemoLetterhead(
      fakeSettings(
        settingsValues({ 'entity.profile': { ...legacyProfile, logoDocumentId: null } }),
      ),
      scope,
      failing,
      'freeze',
      quietLog(),
    );
    expect(noDocument?.logoDataUrl).toBe(LEGACY);
    const none = await buildMemoLetterhead(
      fakeSettings(settingsValues({ 'entity.profile': EMPTY_COMPANY_PROFILE })),
      scope,
      failing,
      'freeze',
      quietLog(),
    );
    expect(none?.logoDataUrl).toBeNull();
  });

  it('live: a logo that cannot be read is logged and the draft shows no logo, the rest intact', async () => {
    const log = quietLog();
    const letterhead = await buildMemoLetterhead(
      fakeSettings(settingsValues()),
      scope,
      failing,
      'live',
      log,
    );
    expect(letterhead).toMatchObject({ logoDataUrl: null, primaryColour: '#0f766e' });
    expect(letterhead?.addressLines).toHaveLength(3);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('kind=unavailable'));
    // Fixed words only: nothing from the failure reaches the log.
    expect(String(log.warn.mock.calls[0]?.[0])).not.toContain('disk gone');
  });

  it('freeze: a referenced logo that cannot be read throws instead of freezing without it', async () => {
    await expect(
      buildMemoLetterhead(fakeSettings(settingsValues()), scope, failing, 'freeze', quietLog()),
    ).rejects.toBeInstanceOf(DocumentLogoUnavailableError);
  });

  it('a profile that does not validate: live shows no logo, freeze refuses', async () => {
    const bad = settingsValues({ 'entity.profile': { logoDocumentId: 'not-a-guid' } });
    const live = await buildMemoLetterhead(
      fakeSettings(bad),
      scope,
      resolvesTo(PNG),
      'live',
      quietLog(),
    );
    expect(live?.logoDataUrl).toBeNull();
    await expect(
      buildMemoLetterhead(fakeSettings(bad), scope, resolvesTo(PNG), 'freeze', quietLog()),
    ).rejects.toBeInstanceOf(LetterheadInvalidError);
  });
});

const template: MemoTemplateSnapshot = {
  organizationId: scope.organizationId,
  organizationName: 'Acme Pvt. Ltd.',
  departmentId: '44444444-4444-4444-8444-444444444444',
  departmentName: 'Sales',
  date: '2026-11-19',
  closing: 'Regards',
  preparedBy: {
    userId: '55555555-5555-4555-8555-555555555555',
    name: 'Asha',
    jobTitle: null,
    department: null,
  },
  recommenders: [],
  approvedBy: {
    userId: '66666666-6666-4666-8666-666666666666',
    name: 'Bikash',
    jobTitle: null,
    department: null,
  },
};

/**
 * The service with only what the letterhead reads: settings, the logo factory (none: `resolve` is null) and the
 * caller's scope. Everything else is null; the tests never reach it.
 */
function serviceWith(
  settings: LetterheadSettings,
  resolve: { current: DocumentLogoResolver } | null,
): TestMemoService {
  const logos =
    resolve === null
      ? undefined
      : ({
          forScope: () => (documentId: string) => resolve.current(documentId),
        } as unknown as DocumentLogoResolverFactory);
  const caller = {
    current: () => ({ scope, principal: { userId: template.preparedBy.userId } }),
  } as unknown as TestMemoCaller;
  const n = null as never;
  return new TestMemoService(n, n, n, n, n, n, n, caller, n, settings as never, undefined, logos);
}

const freezer =
  (settings: LetterheadSettings, resolve: { current: DocumentLogoResolver } | null) =>
  (t: MemoTemplateSnapshot) =>
    serviceWith(settings, resolve)['frozenTemplate'](scope, t);

const people: MemoDirectory = {
  organizationId: scope.organizationId,
  organizationName: 'Acme Pvt. Ltd.',
  currentUserId: template.preparedBy.userId,
  departmentId: null,
  departments: [],
  people: [],
};

/** The approver rule is the integration test's (it plans the real workflow); here it is a fixed answer. */
const approverRule: MemoApproverRule = {
  basis: 'department_head',
  departmentId: null,
  departmentName: null,
  eligibleUserIds: [],
  defaultUserId: null,
};

describe('directory carries the live letterhead', () => {
  const directoryOf = (service: TestMemoService) => {
    vi.spyOn(
      service as unknown as { people: () => Promise<MemoDirectory> },
      'people',
    ).mockResolvedValue(people);
    vi.spyOn(
      service as unknown as { approverRule: () => Promise<MemoApproverRule> },
      'approverRule',
    ).mockResolvedValue(approverRule);
    return service.directory();
  };

  it('adds the letterhead from the settings now to the people directory', async () => {
    const values = settingsValues();
    const service = serviceWith(fakeSettings(values), { current: resolvesTo(PNG) });
    expect(await directoryOf(service)).toEqual({
      ...people,
      approverRule,
      letterhead: {
        addressLines: ['Balaju', 'Kathmandu', 'Nepal'],
        logoDataUrl: PNG,
        primaryColour: '#0f766e',
      },
    });
    values['document.style'] = { layout: 'ledger', primaryColour: '#be123c' };
    expect((await service.directory()).letterhead?.primaryColour).toBe('#be123c');
  });

  it('still answers when the logo cannot be read: no logo, the rest of the letterhead intact', async () => {
    const service = serviceWith(fakeSettings(settingsValues()), { current: failing });
    const directory = await directoryOf(service);
    expect(directory.people).toEqual([]);
    expect(directory.letterhead).toMatchObject({ logoDataUrl: null, primaryColour: '#0f766e' });
  });

  it('without a logo factory wired, a set logo is unreadable: the directory shows none', async () => {
    const service = serviceWith(fakeSettings(settingsValues()), null);
    expect((await directoryOf(service)).letterhead?.logoDataUrl).toBeNull();
  });
});

describe('submit freezes the letterhead (frozenTemplate)', () => {
  it('keeps the frozen values after the settings and the logo change', async () => {
    const values = settingsValues();
    const resolve = { current: resolvesTo(PNG) };
    const freeze = freezer(fakeSettings(values), resolve);
    const frozen = await freeze(template);
    const before = structuredClone(frozen);
    expect(frozen.letterhead).toEqual({
      addressLines: ['Balaju', 'Kathmandu', 'Nepal'],
      logoDataUrl: PNG,
      primaryColour: '#0f766e',
    });
    // The rest of the template is carried unchanged.
    expect({ ...frozen, letterhead: undefined }).toEqual({ ...template, letterhead: undefined });

    values['entity.address'] = { line: 'Lalitpur', city: 'Lalitpur', country: 'NP' };
    values['document.style'] = { layout: 'ledger', primaryColour: '#be123c' };
    resolve.current = resolvesTo(NEW_PNG);
    expect(frozen).toEqual(before);
    // A later submit (a returned memo sent again) freezes that day's letterhead, replacing the old one.
    const again = await freeze(frozen);
    expect(again.letterhead).toEqual({
      addressLines: ['Lalitpur', 'Lalitpur', 'Nepal'],
      logoDataUrl: NEW_PNG,
      primaryColour: '#be123c',
    });
    expect(frozen).toEqual(before);
  });

  it('fails the submit visibly (503) when a set logo cannot be read', async () => {
    const freeze = freezer(fakeSettings(settingsValues()), { current: failing });
    await expect(freeze(template)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('refuses the submit (409) when the letterhead settings are not valid', async () => {
    const freeze = freezer(
      fakeSettings(settingsValues({ 'entity.profile': { logoDocumentId: 'not-a-guid' } })),
      { current: resolvesTo(PNG) },
    );
    await expect(freeze(template)).rejects.toBeInstanceOf(ConflictException);
  });

  it('fails the submit (503) when no logo factory is wired but a logo is set', async () => {
    const freeze = freezer(fakeSettings(settingsValues()), null);
    await expect(freeze(template)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
