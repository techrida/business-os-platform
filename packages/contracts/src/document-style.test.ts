import { describe, expect, it } from 'vitest';

import {
  contrastRatio,
  deriveBrandPalette,
  DOCUMENT_LAYOUTS,
  HexColourSchema,
  PRESET_BRAND_COLOURS,
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
