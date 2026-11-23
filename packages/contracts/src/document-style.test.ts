import { describe, expect, it } from 'vitest';

import {
  contrastRatio,
  DEFAULT_DOCUMENT_STYLE,
  DocumentFormatSnapshotSchema,
  deriveBrandPalette,
  documentSellerContact,
  DOCUMENT_LAYOUTS,
  DocumentStyleSnapshotSchema,
  EMPTY_COMPANY_PROFILE,
  EMPTY_SNAPSHOT_COMPANY_PROFILE,
  HexColourSchema,
  LogoDataUrlSchema,
  PRESET_BRAND_COLOURS,
  snapshotNumberSystems,
  SnapshotCompanyProfileSchema,
  snapshotProfileFrom,
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

  it('allows one default per kind and rejects a second default of the same kind', () => {
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    const a = { id: id(1), kind: 'scope', name: 'A', body: 'x', isDefault: true } as const;
    expect(
      TermPresetListSchema.safeParse([a, { ...a, id: id(2), name: 'B', isDefault: false }]).success,
    ).toBe(true);
    expect(
      TermPresetListSchema.safeParse([a, { ...a, id: id(3), kind: 'exclusions' }]).success,
    ).toBe(true);
    expect(TermPresetListSchema.safeParse([a, { ...a, id: id(2), name: 'B' }]).success).toBe(false);
  });

  it('rejects a script-bearing legacy logo', () => {
    expect(
      SETTINGS['entity.profile'].safeParse({
        ...EMPTY_COMPANY_PROFILE,
        legacyLogoDataUrl: 'data:text/html;base64,AAAA',
      }).success,
    ).toBe(false);
  });
});

describe('company profile: the setting references a document, the snapshot holds bytes (U12)', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const DOC_ID = '0b8f7c1e-3d2a-4f5b-9c6d-7e8f9a0b1c2d';
  const setting = SETTINGS['entity.profile'];

  it('accepts a document id, no logo, and a not-yet-migrated legacy logo', () => {
    expect(setting.safeParse(EMPTY_COMPANY_PROFILE).success).toBe(true);
    expect(setting.safeParse({ ...EMPTY_COMPANY_PROFILE, logoDocumentId: DOC_ID }).success).toBe(
      true,
    );
    expect(setting.safeParse({ ...EMPTY_COMPANY_PROFILE, legacyLogoDataUrl: PNG }).success).toBe(
      true,
    );
    expect(setting.safeParse({ ...EMPTY_COMPANY_PROFILE, legacyLogoDataUrl: null }).success).toBe(
      true,
    );
  });

  it('refuses a data URL (or any non-id) as the logo document id', () => {
    for (const bad of [PNG, 'logo.png', '', 42]) {
      expect(setting.safeParse({ ...EMPTY_COMPANY_PROFILE, logoDocumentId: bad }).success).toBe(
        false,
      );
    }
  });

  it('refuses the old setting shape: the bytes no longer live in the setting', () => {
    expect(setting.safeParse({ ...EMPTY_SNAPSHOT_COMPANY_PROFILE, logoDataUrl: PNG }).success).toBe(
      false,
    );
    expect(setting.safeParse({ ...EMPTY_COMPANY_PROFILE, logoDataUrl: PNG }).success).toBe(false);
  });

  it('caps a logo at 720,000 characters (a 512 KiB image)', () => {
    const body = (chars: number) => 'A'.repeat(chars - 'data:image/png;base64,'.length);
    expect(LogoDataUrlSchema.safeParse(`data:image/png;base64,${body(720_000)}`).success).toBe(
      true,
    );
    expect(LogoDataUrlSchema.safeParse(`data:image/png;base64,${body(720_001)}`).success).toBe(
      false,
    );
    // 512 KiB of bytes, base64 encoded, fits.
    const kib512 = 'A'.repeat(Math.ceil((512 * 1024) / 3) * 4);
    expect(LogoDataUrlSchema.safeParse(`data:image/png;base64,${kib512}`).success).toBe(true);
  });

  it('still parses a snapshot stored before U12, with its logo bytes', () => {
    const stored = {
      style: DEFAULT_DOCUMENT_STYLE,
      profile: {
        displayName: 'Techrida',
        logoDataUrl: PNG,
        phones: ['+977 1 5551234'],
        email: 'sales@techrida.example',
        website: null,
        panVatNo: '301234567',
        signatoryName: null,
        signatoryTitle: null,
      },
      numberSystem: 'international',
      capturedAt: '2026-11-01T05:00:00.000Z',
    };
    expect(DocumentStyleSnapshotSchema.parse(stored)).toEqual(stored);
  });

  it('refuses a snapshot whose profile is the setting shape (a reference is not frozen bytes)', () => {
    expect(
      SnapshotCompanyProfileSchema.safeParse({ ...EMPTY_COMPANY_PROFILE, logoDocumentId: DOC_ID })
        .success,
    ).toBe(false);
  });

  it('snapshotProfileFrom copies the company fields and the resolved bytes, never the reference', () => {
    const profile = {
      ...EMPTY_COMPANY_PROFILE,
      displayName: 'Techrida',
      phones: [
        { country: 'NP' as const, e164: '+97714000000' },
        { country: 'US' as const, e164: '+14155552671', label: 'work' as const },
      ],
      logoDocumentId: DOC_ID,
      legacyLogoDataUrl: PNG,
    };
    const snapshot = snapshotProfileFrom(profile, PNG);
    expect(snapshot).toEqual({
      ...EMPTY_SNAPSHOT_COMPANY_PROFILE,
      displayName: 'Techrida',
      phones: ['+97714000000', '+14155552671'],
      logoDataUrl: PNG,
    });
    expect(SnapshotCompanyProfileSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshotProfileFrom(EMPTY_COMPANY_PROFILE, null)).toEqual(
      EMPTY_SNAPSHOT_COMPANY_PROFILE,
    );
  });
});

describe('snapshot readers (D30)', () => {
  const base = {
    style: DEFAULT_DOCUMENT_STYLE,
    profile: EMPTY_SNAPSHOT_COMPANY_PROFILE,
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

describe('DocumentFormatSnapshotSchema', () => {
  const printed = {
    numberSystems: { NPR: 'south_asian', INR: 'south_asian', USD: 'international' },
    dateFormat: 'dd MMM yyyy',
    capturedAt: '2026-11-09T06:00:00.000Z',
  };
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';

  it('parses a format stored before logos were frozen, unchanged and without a logo', () => {
    const parsed = DocumentFormatSnapshotSchema.parse(printed);
    expect(parsed).toEqual(printed);
    expect(parsed.logoDataUrl).toBeUndefined();
  });

  it('keeps a frozen logo, or an explicit null for none', () => {
    expect(DocumentFormatSnapshotSchema.parse({ ...printed, logoDataUrl: PNG }).logoDataUrl).toBe(
      PNG,
    );
    expect(
      DocumentFormatSnapshotSchema.parse({ ...printed, logoDataUrl: null }).logoDataUrl,
    ).toBeNull();
  });

  it.each([
    ['an SVG', 'data:image/svg+xml;base64,PHN2Zz4='],
    ['a URL', 'https://example.com/logo.png'],
    ['an oversize image', `data:image/png;base64,${'A'.repeat(720_000)}`],
  ])('refuses %s as the logo', (_name, logoDataUrl) => {
    expect(DocumentFormatSnapshotSchema.safeParse({ ...printed, logoDataUrl }).success).toBe(false);
  });

  it('keeps a frozen seller contact, an explicit null, or none on an older print', () => {
    const contact = {
      phones: ['+977 1 4000000'],
      email: 'billing@example.com',
      signatoryName: 'Sita Sharma',
      signatoryTitle: 'Finance Manager',
    };
    expect(
      DocumentFormatSnapshotSchema.parse({ ...printed, sellerContact: contact }).sellerContact,
    ).toEqual(contact);
    expect(
      DocumentFormatSnapshotSchema.parse({ ...printed, sellerContact: null }).sellerContact,
    ).toBeNull();
    expect(DocumentFormatSnapshotSchema.parse(printed).sellerContact).toBeUndefined();
    expect(
      DocumentFormatSnapshotSchema.safeParse({
        ...printed,
        sellerContact: { ...contact, website: 'https://example.com' },
      }).success,
    ).toBe(false);
  });
});

describe('documentSellerContact', () => {
  it('names the four contact keys of a profile and nothing else', () => {
    expect(
      documentSellerContact({
        ...EMPTY_COMPANY_PROFILE,
        displayName: 'Acme',
        website: 'https://acme.example',
        phones: [
          { country: 'NP', e164: '+97714000000' },
          { country: 'NP', e164: '+9779800000000', label: 'mobile' },
          { country: 'US', e164: '+14155552671' },
        ],
        email: 'hello@acme.example',
        signatoryName: 'Ram Thapa',
        signatoryTitle: 'Director',
      }),
    ).toEqual({
      phones: ['+977 1-4000000', '+977 9800000000', '+1 415 555 2671'],
      email: 'hello@acme.example',
      signatoryName: 'Ram Thapa',
      signatoryTitle: 'Director',
    });
  });

  it('is null for a profile that does not validate', () => {
    expect(documentSellerContact({ phones: 'not a list' })).toBeNull();
    expect(documentSellerContact({ ...EMPTY_COMPANY_PROFILE, phones: ['01-4000000'] })).toBeNull();
    expect(
      documentSellerContact({
        ...EMPTY_COMPANY_PROFILE,
        phones: [{ country: 'NP', e164: '+14155552671' }],
      }),
    ).toBeNull();
    expect(documentSellerContact(undefined)).toBeNull();
  });
});
