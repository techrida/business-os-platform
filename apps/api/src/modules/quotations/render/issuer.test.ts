import { DOCUMENT_SETTING_DEFAULTS } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildDocumentStyleSnapshot,
  buildIssuer,
  DocumentStyleInvalidError,
  IssuerIncompleteError,
  parseStoredDocumentStyle,
  type IssuerSettings,
} from './issuer';

const scope = { tenantId: 't-1', organizationId: 'o-1' };
const address = { line1: 'Kupondole', city: 'Lalitpur', country: 'NP' };

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

  it.each([null, undefined, {}, { line1: 'x', city: 'y', country: 'Nepal' }])(
    'refuses with a typed error when the address is %j',
    async (bad) => {
      const { settings } = fakeSettings({ 'entity.pan_vat_no': null, 'entity.address': bad });
      const error = await buildIssuer(settings, scope, 'Techrida').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IssuerIncompleteError);
      expect(error).toMatchObject({ kind: 'issuer_incomplete', missing: 'address' });
    },
  );
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
      profile: { ...DOCUMENT_SETTING_DEFAULTS['entity.profile'], panVatNo: '301234567' },
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
});

describe('parseStoredDocumentStyle', () => {
  it('returns a valid snapshot and refuses anything else with the typed error', () => {
    const ok = {
      style: { layout: 'banded', primaryColour: '#1d4ed8' },
      profile: DOCUMENT_SETTING_DEFAULTS['entity.profile'],
      numberSystem: 'south_asian',
      capturedAt: '2026-11-09T06:00:00.000Z',
    };
    expect(parseStoredDocumentStyle(ok)).toEqual(ok);
    for (const bad of [null, 'x', {}, { ...ok, extra: 1 }, { ...ok, capturedAt: 'yesterday' }]) {
      expect(() => parseStoredDocumentStyle(bad)).toThrow(DocumentStyleInvalidError);
    }
  });
});
