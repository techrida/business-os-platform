import { DOCUMENT_SETTING_DEFAULTS, EMPTY_SNAPSHOT_COMPANY_PROFILE } from '@bos/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  buildDocumentStyleSnapshot,
  buildIssuer,
  DocumentLogoUnavailableError,
  DocumentStyleInvalidError,
  IssuerIncompleteError,
  parseStoredDocumentStyle,
  type IssuerSettings,
} from './issuer';
import { renderQuotationHtml } from './quotation-html';
import { sampleQuotationView } from './sample-view';

const scope = { tenantId: 't-1', organizationId: 'o-1' };
const address = { line: 'Kupondole', city: 'Lalitpur', country: 'NP' };

function fakeSettings(values: Record<string, unknown>) {
  const asked: { scope: unknown; key: string }[] = [];
  const settings = {
    get: (s: unknown, key: string) => {
      asked.push({ scope: s, key });
      return Promise.resolve(values[key]);
    },
  } as unknown as IssuerSettings;
  return { settings, asked };
}

describe('buildIssuer', () => {
  it('joins the legal name with the entity settings, read for the entity scope', async () => {
    const { settings, asked } = fakeSettings({
      'entity.pan_vat_no': '301234567',
      'entity.address': address,
    });
    await expect(buildIssuer(settings, scope, 'Techrida Pvt. Ltd.')).resolves.toEqual({
      legalName: 'Techrida Pvt. Ltd.',
      panVatNo: '301234567',
      address,
    });
    expect(asked.map((a) => a.key).sort()).toEqual(['entity.address', 'entity.pan_vat_no']);
    expect(asked.every((a) => a.scope === scope)).toBe(true);
  });

  it('prints no number when none is set, and still builds the block', async () => {
    const { settings } = fakeSettings({ 'entity.pan_vat_no': null, 'entity.address': address });
    await expect(buildIssuer(settings, scope, 'Techrida')).resolves.toMatchObject({
      panVatNo: null,
    });
  });

  it.each([
    null,
    undefined,
    {},
    { line: 'x', city: 'y', country: 'Nepal' },
    { line1: 'x', city: 'y', country: 'NP' },
  ])('refuses with a typed error when the address is %j', async (bad) => {
    const { settings } = fakeSettings({ 'entity.pan_vat_no': null, 'entity.address': bad });
    const error = await buildIssuer(settings, scope, 'Techrida').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IssuerIncompleteError);
    expect(error).toMatchObject({ kind: 'issuer_incomplete', missing: 'address' });
  });
});

describe('buildDocumentStyleSnapshot', () => {
  const at = new Date('2026-11-09T06:00:00.000Z');
  const settingsOf = (over: Record<string, unknown> = {}) =>
    fakeSettings({ ...DOCUMENT_SETTING_DEFAULTS, 'entity.pan_vat_no': '301234567', ...over });

  it('reads the five settings for the entity scope and stamps the capture time', async () => {
    const { settings, asked } = settingsOf({
      'document.style': { layout: 'ledger', primaryColour: '#0F766E' },
      'format.number_systems': { NPR: 'international', INR: 'south_asian', USD: 'south_asian' },
      'format.date': 'dd/MM/yyyy',
    });
    await expect(buildDocumentStyleSnapshot(settings, scope, at)).resolves.toEqual({
      style: { layout: 'ledger', primaryColour: '#0f766e' },
      profile: { ...EMPTY_SNAPSHOT_COMPANY_PROFILE, panVatNo: '301234567' },
      numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'south_asian' },
      dateFormat: 'dd/MM/yyyy',
      capturedAt: '2026-11-09T06:00:00.000Z',
    });
    expect(asked.map((a) => a.key).sort()).toEqual([
      'document.style',
      'entity.pan_vat_no',
      'entity.profile',
      'format.date',
      'format.number_systems',
    ]);
    expect(asked.every((a) => a.scope === scope)).toBe(true);
  });

  it('carries the profile display name, and prefers the profile PAN/VAT number to the entity setting', async () => {
    const { settings } = settingsOf({
      'entity.profile': {
        ...DOCUMENT_SETTING_DEFAULTS['entity.profile'],
        displayName: 'Techrida Nepal',
        panVatNo: '999999999',
      },
    });
    const snapshot = await buildDocumentStyleSnapshot(settings, scope, at);
    expect(snapshot.profile).toMatchObject({
      displayName: 'Techrida Nepal',
      panVatNo: '999999999',
    });
  });

  it('refuses a profile saved before phones carried their country (FX9: no tolerant read)', async () => {
    const { settings } = settingsOf({
      'entity.profile': {
        ...DOCUMENT_SETTING_DEFAULTS['entity.profile'],
        phones: ['01-4123456', 'main office'],
      },
    });
    const error = await buildDocumentStyleSnapshot(settings, scope, at).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentStyleInvalidError);
  });

  it('prints no number for an entity PAN that is not nine digits, rather than freezing it', async () => {
    const { settings } = settingsOf({ 'entity.pan_vat_no': '12-34567' });
    const snapshot = await buildDocumentStyleSnapshot(settings, scope, at);
    expect(snapshot.profile.panVatNo).toBeNull();
  });

  it('freezes each phone as its E.164 number, and the issuer block prints it for its country (FX9)', async () => {
    const { settings } = settingsOf({
      'entity.profile': {
        ...DOCUMENT_SETTING_DEFAULTS['entity.profile'],
        phones: [
          { country: 'US', e164: '+14155552671', label: 'work' },
          { country: 'NP', e164: '+97714123456', label: 'landline' },
          { country: 'NP', e164: '+9779812345678' },
        ],
      },
    });
    const snapshot = await buildDocumentStyleSnapshot(settings, scope, at);
    expect(snapshot.profile.phones).toEqual(['+14155552671', '+97714123456', '+9779812345678']);
    const html = renderQuotationHtml(sampleQuotationView(), { snapshot });
    const tel = /<div class="foot-col foot-col--tel">[\s\S]*?<\/div><\/div>/.exec(html)?.[0] ?? '';
    // A foreign number prints in international format; Nepal keeps FX8's mobile and area-code forms.
    expect(tel).toContain('<div>+1 415 555 2671</div>');
    expect(tel).toContain('<div>+977 1-4123456</div>');
    expect(tel).toContain('<div>+977 9812345678</div>');
    expect(tel).not.toContain('+14155552671');
  });

  it('leaves the number empty when neither the profile nor the entity has one', async () => {
    const { settings } = settingsOf({ 'entity.pan_vat_no': null });
    const snapshot = await buildDocumentStyleSnapshot(settings, scope, at);
    expect(snapshot.profile.panVatNo).toBeNull();
  });

  it.each([
    ['document.style', { layout: 'banded', primaryColour: 'red' }],
    ['document.style', null],
    ['entity.profile', { displayName: 'x' }],
    ['entity.profile', undefined],
    ['format.number_systems', { NPR: 'metric', INR: 'south_asian', USD: 'south_asian' }],
    ['format.date', 'yy-dd'],
  ])('refuses with a typed error when %s is %j', async (key, bad) => {
    const { settings } = settingsOf({ [key]: bad });
    const error = await buildDocumentStyleSnapshot(settings, scope, at).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DocumentStyleInvalidError);
    expect(error).toMatchObject({ kind: 'document_style_invalid' });
  });

  describe('freezes the logo as bytes (U12)', () => {
    const DOC_ID = '0b8f7c1e-3d2a-4f5b-9c6d-7e8f9a0b1c2d';
    const RESOLVED = 'data:image/png;base64,UkVTT0xWRUQ=';
    const LEGACY = 'data:image/jpeg;base64,TEVHQUNZ';
    const profileWith = (over: Record<string, unknown>) =>
      settingsOf({ 'entity.profile': { ...DOCUMENT_SETTING_DEFAULTS['entity.profile'], ...over } });

    it('freezes the bytes the resolver returns for the referenced document', async () => {
      const { settings } = profileWith({ logoDocumentId: DOC_ID, legacyLogoDataUrl: LEGACY });
      const resolveLogo = vi.fn(() => Promise.resolve(RESOLVED));
      const snapshot = await buildDocumentStyleSnapshot(settings, scope, at, resolveLogo);
      expect(resolveLogo).toHaveBeenCalledWith(DOC_ID);
      expect(snapshot.profile.logoDataUrl).toBe(RESOLVED);
      expect(snapshot.profile).not.toHaveProperty('logoDocumentId');
      expect(snapshot.profile).not.toHaveProperty('legacyLogoDataUrl');
    });

    it('falls back to the legacy logo when the resolver finds nothing', async () => {
      const { settings } = profileWith({ logoDocumentId: DOC_ID, legacyLogoDataUrl: LEGACY });
      const snapshot = await buildDocumentStyleSnapshot(settings, scope, at, () =>
        Promise.resolve(null),
      );
      expect(snapshot.profile.logoDataUrl).toBe(LEGACY);
    });

    it('freezes no logo when neither the document nor a legacy logo has bytes', async () => {
      const { settings } = profileWith({ logoDocumentId: DOC_ID });
      const snapshot = await buildDocumentStyleSnapshot(settings, scope, at, () =>
        Promise.resolve(null),
      );
      expect(snapshot.profile.logoDataUrl).toBeNull();
    });

    it('uses the legacy logo without calling the resolver when no document is referenced', async () => {
      const { settings } = profileWith({ legacyLogoDataUrl: LEGACY });
      const resolveLogo = vi.fn(() => Promise.reject(new Error('must not be called')));
      const snapshot = await buildDocumentStyleSnapshot(settings, scope, at, resolveLogo);
      expect(resolveLogo).not.toHaveBeenCalled();
      expect(snapshot.profile.logoDataUrl).toBe(LEGACY);
    });

    it('uses the legacy logo with the default resolver (nothing wired yet)', async () => {
      const { settings } = profileWith({ logoDocumentId: DOC_ID, legacyLogoDataUrl: LEGACY });
      const snapshot = await buildDocumentStyleSnapshot(settings, scope, at);
      expect(snapshot.profile.logoDataUrl).toBe(LEGACY);
    });

    it('refuses with a typed error, carrying nothing of the cause, when the resolver throws for a referenced logo', async () => {
      const { settings } = profileWith({ logoDocumentId: DOC_ID, legacyLogoDataUrl: LEGACY });
      const error = await buildDocumentStyleSnapshot(settings, scope, at, () =>
        Promise.reject(new Error('s3://secret-bucket/key denied')),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DocumentLogoUnavailableError);
      expect(error).toMatchObject({ kind: 'document_logo_unavailable' });
      expect(String((error as Error).message)).not.toContain('secret');
      expect((error as Error).cause).toBeUndefined();
    });

    it('refuses a resolved value that is not a logo data URL rather than freezing it', async () => {
      const { settings } = profileWith({ logoDocumentId: DOC_ID });
      const error = await buildDocumentStyleSnapshot(settings, scope, at, () =>
        Promise.resolve('https://example.com/logo.png'),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DocumentStyleInvalidError);
    });
  });
});

describe('parseStoredDocumentStyle', () => {
  it('returns a valid snapshot and refuses anything else with the typed error', () => {
    const ok = {
      style: { layout: 'banded', primaryColour: '#1d4ed8' },
      profile: EMPTY_SNAPSHOT_COMPANY_PROFILE,
      numberSystem: 'south_asian',
      capturedAt: '2026-11-09T06:00:00.000Z',
    };
    expect(parseStoredDocumentStyle(ok)).toEqual(ok);
    // A snapshot stored before U12 holds its logo bytes and still reads back unchanged.
    const withLogo = {
      ...ok,
      profile: { ...ok.profile, logoDataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    };
    expect(parseStoredDocumentStyle(withLogo)).toEqual(withLogo);
    // The setting shape (a document reference) is not a frozen profile.
    expect(() =>
      parseStoredDocumentStyle({ ...ok, profile: DOCUMENT_SETTING_DEFAULTS['entity.profile'] }),
    ).toThrow(DocumentStyleInvalidError);
    for (const bad of [null, 'x', {}, { ...ok, extra: 1 }, { ...ok, capturedAt: 'yesterday' }]) {
      expect(() => parseStoredDocumentStyle(bad)).toThrow(DocumentStyleInvalidError);
    }
  });
});
