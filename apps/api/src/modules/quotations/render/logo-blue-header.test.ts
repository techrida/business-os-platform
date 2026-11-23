// R6AC proof: the first document template (banded, the default blue) frozen and rendered for a company whose only logo
// is a dark mark on transparency shows a WHITE logo on the blue band, end to end: settings -> resolver -> snapshot ->
// HTML. Real PNG bytes through sharp; the lookup, storage and settings are fakes.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { DOCUMENT_SETTING_DEFAULTS } from '@bos/contracts';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { DocumentLogoResolverFactory } from '../../images/document-logo.resolver';
import { measureLogo } from '../../images/logo-analysis';
import { buildDocumentStyleSnapshot } from './issuer';
import { renderQuotationHtml } from './quotation-html';
import { sampleQuotationView } from './sample-view';

const TENANT = randomUUID();
const ORG = randomUUID();
const scope = { tenantId: TENANT, organizationId: ORG };
const LOGO = randomUUID();

async function darkMark(): Promise<Buffer> {
  const square = await sharp({
    create: { width: 20, height: 20, channels: 3, background: '#111111' },
  })
    .png()
    .toBuffer();
  return await sharp({
    create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: square, left: 10, top: 10 }])
    .png()
    .toBuffer();
}

async function renderBand(layout: 'banded' | 'tinted' | 'ledger') {
  const bytes = await darkMark();
  const factory = new DocumentLogoResolverFactory(
    () =>
      Promise.resolve({
        tenantId: TENANT,
        organizationId: ORG,
        ownerType: 'entity_logo',
        removedAt: null,
        versions: [
          {
            version: 1,
            status: 'clean',
            detectedMime: 'image/png',
            sizeBytes: bytes.length,
            storageKey: 'k',
            scanEngine: null,
          },
        ],
      }),
    { openClean: () => Promise.resolve(Readable.from([bytes])) },
  );
  const values: Record<string, unknown> = {
    ...DOCUMENT_SETTING_DEFAULTS,
    'entity.profile': { ...DOCUMENT_SETTING_DEFAULTS['entity.profile'], logoDocumentId: LOGO },
    'document.style': { layout, primaryColour: '#1d4ed8' },
  };
  const settings = { get: (_s: unknown, key: string) => Promise.resolve(values[key]) };
  const snapshot = await buildDocumentStyleSnapshot(
    settings as never,
    scope,
    new Date('2026-11-23T00:00:00Z'),
    factory.forScope(scope),
  );
  const html = renderQuotationHtml(sampleQuotationView(), { snapshot });
  return { html, snapshot, original: bytes };
}

describe('the first template (banded, blue) with a dark transparent logo', () => {
  it('freezes and prints a white logo, not the dark one and not on a white plate', async () => {
    const { html, snapshot, original } = await renderBand('banded');
    const frozen = snapshot.profile.logoDataUrl!;
    const bytes = Buffer.from(frozen.split(',')[1]!, 'base64');
    expect(bytes.equals(original)).toBe(false);
    expect((await measureLogo(bytes)).luminance).toBeGreaterThan(0.99);
    expect(html).toContain(frozen);
    expect(html).not.toMatch(/\.brand--logo \{[^}]*background/);
  });

  it('keeps the dark logo on a layout whose logo sits on white paper', async () => {
    const { snapshot, original } = await renderBand('ledger');
    const bytes = Buffer.from(snapshot.profile.logoDataUrl!.split(',')[1]!, 'base64');
    expect(bytes.equals(original)).toBe(true);
  });
});
