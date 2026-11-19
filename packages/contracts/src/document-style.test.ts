import { describe, expect, it } from 'vitest';

import {
  contrastRatio,
  DEFAULT_DOCUMENT_STYLE,
  deriveBrandPalette,
  DOCUMENT_LAYOUTS,
  DocumentStyleSnapshotSchema,
  EMPTY_COMPANY_PROFILE,
  HexColourSchema,
  PRESET_BRAND_COLOURS,
  snapshotNumberSystems,
  TermPresetListSchema,
} from './document-style.js';
import { DOCUMENT_SETTING_DEFAULTS, SETTINGS } from './settings.js';

const sample = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => {
    const h = (i * 2654435761) >>> 0;
    return `#${h.toString(16).padStart(8, '0').slice(0, 6)}`;
  });

describe('deriveBrandPalette', () => {
  it.each([
    ...PRESET_BRAND_COLOURS.map((c) => c.hex),
    '#000000',
    '#ffffff',
    '#ffff00',
    '#808080',
    ...sample(200),
  ])('keeps text readable for %s', (hex) => {
    const p = deriveBrandPalette(hex);
    expect(contrastRatio(p.primary, p.onPrimary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.tint, p.onTint)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', p.accentText)).toBeGreaterThanOrEqual(4.5);
  });

  it('is deterministic and lower-cases the input', () => {
    expect(deriveBrandPalette('#1D4ED8')).toEqual(deriveBrandPalette('#1d4ed8'));
    expect(deriveBrandPalette('#1D4ED8').primary).toBe('#1d4ed8');
  });

  it('picks ink on a light colour and white on a dark one', () => {
    expect(deriveBrandPalette('#ffff00').onPrimary).toBe('#111827');
    expect(deriveBrandPalette('#1d4ed8').onPrimary).toBe('#ffffff');
  });

  it('rejects bad hex', () => {
    expect(HexColourSchema.safeParse('blue').success).toBe(false);
    expect(HexColourSchema.safeParse('#fff').success).toBe(false);
  });
});

describe('document settings', () => {
  it('has at least 4 layouts', () => expect(DOCUMENT_LAYOUTS.length).toBeGreaterThanOrEqual(4));

  it('defaults satisfy their schemas', () => {
    for (const [key, value] of Object.entries(DOCUMENT_SETTING_DEFAULTS)) {
      expect(SETTINGS[key as keyof typeof DOCUMENT_SETTING_DEFAULTS].safeParse(value).success).toBe(
        true,
      );
    }
  });

  it('rejects duplicate preset names within a kind but allows them across kinds', () => {
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    const a = { id: id(1), kind: 'scope', name: 'Standard', body: 'x' } as const;
    expect(TermPresetListSchema.safeParse([a, { ...a, id: id(2), name: 'standard' }]).success).toBe(
      false,
    );
    expect(
      TermPresetListSchema.safeParse([a, { ...a, id: id(2), kind: 'exclusions' }]).success,
    ).toBe(true);
  });

  it('rejects a script-bearing logo', () => {
    expect(
      SETTINGS['entity.profile'].safeParse({
        displayName: null,
        logoDataUrl: 'data:text/html;base64,AAAA',
        phones: [],
        email: null,
        website: null,
        panVatNo: null,
        signatoryName: null,
        signatoryTitle: null,
      }).success,
    ).toBe(false);
  });
});

describe('snapshot readers (D30)', () => {
  const base = {
    style: DEFAULT_DOCUMENT_STYLE,
    profile: EMPTY_COMPANY_PROFILE,
    capturedAt: '2026-11-18T10:00:00.000Z',
  };

  it('still parses a snapshot taken with one number system and applies it to every currency', () => {
    const parsed = DocumentStyleSnapshotSchema.parse({ ...base, numberSystem: 'international' });
    expect(snapshotNumberSystems(parsed)).toEqual({
      NPR: 'international',
      INR: 'international',
      USD: 'international',
    });
  });

  it('reads the per-currency map of a new snapshot and its date format', () => {
    const parsed = DocumentStyleSnapshotSchema.parse({
      ...base,
      numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'south_asian' },
      dateFormat: 'dd/MM/yyyy',
    });
    expect(snapshotNumberSystems(parsed).NPR).toBe('international');
    expect(parsed.dateFormat).toBe('dd/MM/yyyy');
  });

  it('refuses a snapshot with neither shape', () => {
    expect(DocumentStyleSnapshotSchema.safeParse(base).success).toBe(false);
  });
});
