// The logo variants (R6AC): given the background a document prints the logo on, the resolver answers the primary when it
// is readable there (WCAG 1.4.11, 3:1), else the logo for that background, else a one-colour copy of a transparent
// primary, else the primary on a white plate. Real PNG bytes through sharp; fakes for the lookup, storage and stats.
// Run (from apps/api): pnpm exec vitest run src/modules/images/document-logo.variants.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { PAPER_LOGO_BACKGROUND, relativeLuminance } from '@bos/contracts';
import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DocumentLogoPendingError,
  DocumentLogoResolverFactory,
  type LogoDocumentRow,
  type LogoStatsLookup,
  type LogoStorage,
} from './document-logo.resolver';
import { measureLogo } from './logo-analysis';

const TENANT = randomUUID();
const ORG = randomUUID();
const scope = { tenantId: TENANT, organizationId: ORG };
const BLUE = '#1d4ed8';

const mark = async (colour: string, transparent = true) => {
  const square = await sharp({ create: { width: 20, height: 20, channels: 3, background: colour } })
    .png()
    .toBuffer();
  return await sharp({
    create: {
      width: 40,
      height: 40,
      channels: 4,
      background: transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : '#ffffff',
    },
  })
    .composite([{ input: square, left: 10, top: 10 }])
    .png()
    .toBuffer();
};

interface Doc {
  id: string;
  ownerType: string;
  bytes: Buffer;
  status?: string;
  tenantId?: string;
}

function setup(docs: Doc[], stats?: LogoStatsLookup) {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const lookup = vi.fn((_scope: unknown, id: string): Promise<LogoDocumentRow | undefined> => {
    const d = byId.get(id);
    if (d === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      tenantId: d.tenantId ?? TENANT,
      organizationId: ORG,
      ownerType: d.ownerType,
      removedAt: null,
      versions: [
        {
          version: 1,
          status: d.status ?? 'clean',
          detectedMime: 'image/png',
          sizeBytes: d.bytes.length,
          storageKey: id,
          scanEngine: null,
        },
      ],
    });
  });
  const storage: LogoStorage = {
    openClean: vi.fn((key: string) => Promise.resolve(Readable.from([byId.get(key)!.bytes]))),
  };
  const factory = new DocumentLogoResolverFactory(lookup, storage, stats);
  return factory.forScope(scope);
}

let darkBytes: Buffer;
let lightBytes: Buffer;
let opaqueDarkBytes: Buffer;
const PRIMARY = randomUUID();
const ON_DARK = randomUUID();
const ON_LIGHT = randomUUID();

beforeAll(async () => {
  darkBytes = await mark('#111111');
  lightBytes = await mark('#f5f5f5');
  opaqueDarkBytes = await mark('#111111', false);
});

const request = (colour: string, over: { dark?: string | null; light?: string | null } = {}) => ({
  colour,
  onDarkDocumentId: over.dark ?? null,
  onLightDocumentId: over.light ?? null,
});

const decode = (dataUrl: string | null) => {
  expect(dataUrl).toMatch(/^data:image\/png;base64,/);
  return Buffer.from(dataUrl!.split(',')[1]!, 'base64');
};

describe('logo for a background', () => {
  it('keeps the primary when it is readable on the background', async () => {
    const resolve = setup([{ id: PRIMARY, ownerType: 'entity_logo', bytes: darkBytes }]);
    const out = await resolve(PRIMARY, request(PAPER_LOGO_BACKGROUND));
    expect(decode(out).equals(darkBytes)).toBe(true);
  });

  it('first template: a dark logo on the blue header comes out white', async () => {
    const resolve = setup([{ id: PRIMARY, ownerType: 'entity_logo', bytes: darkBytes }]);
    const out = decode(await resolve(PRIMARY, request(BLUE)));
    const stats = await measureLogo(out);
    expect(stats.luminance).toBeGreaterThan(0.99);
    expect(stats.hasTransparency).toBe(true);
  });

  it('uses the logo for dark backgrounds on blue when one was uploaded', async () => {
    const resolve = setup([
      { id: PRIMARY, ownerType: 'entity_logo', bytes: darkBytes },
      { id: ON_DARK, ownerType: 'entity_logo_on_dark', bytes: lightBytes },
    ]);
    const out = decode(await resolve(PRIMARY, request(BLUE, { dark: ON_DARK })));
    expect(out.equals(lightBytes)).toBe(true);
  });

  it('uses the logo for light backgrounds for a light primary on white', async () => {
    const resolve = setup([
      { id: PRIMARY, ownerType: 'entity_logo', bytes: lightBytes },
      { id: ON_LIGHT, ownerType: 'entity_logo_on_light', bytes: darkBytes },
    ]);
    const out = decode(await resolve(PRIMARY, request(PAPER_LOGO_BACKGROUND, { light: ON_LIGHT })));
    expect(out.equals(darkBytes)).toBe(true);
  });

  it('draws a light primary black on white when there is no variant', async () => {
    const resolve = setup([{ id: PRIMARY, ownerType: 'entity_logo', bytes: lightBytes }]);
    const stats = await measureLogo(decode(await resolve(PRIMARY, request(PAPER_LOGO_BACKGROUND))));
    expect(stats.luminance).toBeLessThan(0.01);
  });

  it('puts an opaque dark logo that fails on blue on a white plate', async () => {
    const resolve = setup([{ id: PRIMARY, ownerType: 'entity_logo', bytes: opaqueDarkBytes }]);
    const out = decode(await resolve(PRIMARY, request(BLUE)));
    const stats = await measureLogo(out);
    expect(stats.luminance).toBeGreaterThan(0.5);
    expect(relativeLuminance(BLUE)).toBeLessThan(0.2);
  });

  it('uses recorded stats instead of decoding the bytes', async () => {
    const stats = vi.fn(() => Promise.resolve({ luminance: 0.9, hasTransparency: true }));
    // Dark bytes, but stats say light: on a white page the choice is a black copy, proving the stats were read.
    const resolve = setup([{ id: PRIMARY, ownerType: 'entity_logo', bytes: darkBytes }], stats);
    const out = decode(await resolve(PRIMARY, request(PAPER_LOGO_BACKGROUND)));
    expect(stats).toHaveBeenCalled();
    expect((await measureLogo(out)).luminance).toBeLessThan(0.01);
  });

  it('answers the primary as before when no background is given', async () => {
    const resolve = setup([{ id: PRIMARY, ownerType: 'entity_logo', bytes: darkBytes }]);
    const out = decode(await resolve(PRIMARY));
    expect(out.equals(darkBytes)).toBe(true);
  });

  it('ignores a variant whose document is another owner type (a forged pointer)', async () => {
    const resolve = setup([
      { id: PRIMARY, ownerType: 'entity_logo', bytes: darkBytes },
      { id: ON_DARK, ownerType: 'customer_logo', bytes: lightBytes },
    ]);
    const out = decode(await resolve(PRIMARY, request(BLUE, { dark: ON_DARK })));
    expect(out.equals(lightBytes)).toBe(false);
    expect((await measureLogo(out)).luminance).toBeGreaterThan(0.99);
  });

  it('ignores a variant of another tenant', async () => {
    const resolve = setup([
      { id: PRIMARY, ownerType: 'entity_logo', bytes: darkBytes },
      { id: ON_DARK, ownerType: 'entity_logo_on_dark', bytes: lightBytes, tenantId: randomUUID() },
    ]);
    const out = decode(await resolve(PRIMARY, request(BLUE, { dark: ON_DARK })));
    expect(out.equals(lightBytes)).toBe(false);
  });

  it('does not wait for a variant still being scanned when the primary prints fine', async () => {
    const resolve = setup([
      { id: PRIMARY, ownerType: 'entity_logo', bytes: darkBytes },
      { id: ON_DARK, ownerType: 'entity_logo_on_dark', bytes: lightBytes, status: 'quarantined' },
    ]);
    const out = decode(await resolve(PRIMARY, request(PAPER_LOGO_BACKGROUND, { dark: ON_DARK })));
    expect(out.equals(darkBytes)).toBe(true);
  });

  it('plates a multi-colour transparent logo on blue instead of painting it a white blob', async () => {
    const glyph = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const navy = await sharp({
      create: { width: 30, height: 30, channels: 3, background: '#0b1f4d' },
    })
      .png()
      .toBuffer();
    const badge = await sharp({
      create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        { input: navy, left: 5, top: 5 },
        { input: glyph, left: 15, top: 15 },
      ])
      .png()
      .toBuffer();
    const resolve = setup([{ id: PRIMARY, ownerType: 'entity_logo', bytes: badge }]);
    const out = decode(await resolve(PRIMARY, request(BLUE)));
    const meta = await sharp(out).metadata();
    expect(meta.width).toBeGreaterThan(40);
    expect((await measureLogo(out)).luminance).toBeGreaterThan(0.5);
  });

  it('keeps a mid-tone transparent logo on white as uploaded', async () => {
    const orange = await mark('#e8590c');
    const resolve = setup([{ id: PRIMARY, ownerType: 'entity_logo', bytes: orange }]);
    expect(decode(await resolve(PRIMARY, request(PAPER_LOGO_BACKGROUND))).equals(orange)).toBe(
      true,
    );
  });

  it('retries (pending) while a variant still awaits its scan, rather than freezing without it', async () => {
    const resolve = setup([
      { id: PRIMARY, ownerType: 'entity_logo', bytes: darkBytes },
      { id: ON_DARK, ownerType: 'entity_logo_on_dark', bytes: lightBytes, status: 'quarantined' },
    ]);
    await expect(resolve(PRIMARY, request(BLUE, { dark: ON_DARK }))).rejects.toBeInstanceOf(
      DocumentLogoPendingError,
    );
  });
});
