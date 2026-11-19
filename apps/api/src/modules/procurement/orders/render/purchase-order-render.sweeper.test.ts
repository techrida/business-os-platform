import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../../../../platform/db/db.module';
import type { TxScope } from '../../../../platform/db/tx';
import { EMPTY_COMPANY_PROFILE } from '@bos/contracts';

import { GotenbergError } from '../../../quotations/render/gotenberg.client';
import type { DocumentLogoResolver } from '../../../quotations/render/issuer';
import type { RenderSettings, RunInTx } from '../../../quotations/render/quotation-render.sweeper';
import {
  failureKind,
  FAILED_RETRY_MS,
  PurchaseOrderRenderSweeper,
  RenderSourceMissingError,
  type RenderCandidate,
  type RenderSource,
  type RenderStore,
} from './purchase-order-render.sweeper';
import { PurchaseOrderNotRenderableError } from './purchase-order-view';

const NOW = new Date('2026-11-09T06:00:00.000Z');
const TX = { marker: 'tx' } as unknown as DbTransaction;
const PDF = Buffer.from('%PDF-1.4 fake');
const VAT = '6f1a0c7e-0000-4000-8000-000000000001';

const STORED_SYSTEMS = { NPR: 'south_asian', INR: 'south_asian', USD: 'international' };

const candidate = (n: number): RenderCandidate => ({
  tenantId: 'tenant-1',
  organizationId: 'org-1',
  versionId: `00000000-0000-4000-8000-00000000000${n}`,
});

const source = (version = 1, currency: 'NPR' | 'USD' = 'NPR'): RenderSource => ({
  buyerLegalName: 'Techrida Pvt. Ltd.',
  version: {
    version,
    createdAt: NOW,
    total: '2124400.00',
    snapshot: {
      purchaseOrder: {
        number: 'PO-2083/84-00007',
        currency,
        paymentTermsDays: 30,
        advancePercent: '0.00',
      },
      lines: [
        {
          lineNo: 1,
          description: 'Solar panel',
          uom: 'pcs',
          orderedQuantity: '12.5000',
          unitPrice: '150400.00',
          taxCodeId: VAT,
          gross: '1880000.00',
          taxAmount: '244400.00',
        },
      ],
    },
  },
  vendor: { legalName: 'Himal Solar Pvt. Ltd.', pan: '600123456' },
  delivery: { requiredBy: null, deliveryLocation: null },
  taxCodes: new Map([[VAT, 'VAT13']]),
});

function fixture(
  over: {
    src?: RenderSource | undefined;
    hasDocument?: boolean;
    candidates?: RenderCandidate[];
    pan?: unknown;
    /** The raw `format.number_systems` value; an omitted key reads as the stored default. */
    numberSystems?: unknown;
    /** The raw `format.date` value; an omitted key reads as the stored default. */
    dateFormat?: unknown;
    /** The raw `entity.profile` value; omitted, the key is unset (no logo). */
    profile?: unknown;
    /** What the logo document resolves to; omitted, nothing (null). */
    logo?: DocumentLogoResolver;
  } = {},
) {
  let now = NOW;
  const live: { profile: unknown } = { profile: over.profile };
  const store = {
    candidates: vi.fn().mockResolvedValue(over.candidates ?? []),
    load: vi.fn().mockResolvedValue('src' in over ? over.src : source()),
    lockAndHasDocument: vi.fn().mockResolvedValue(over.hasDocument ?? false),
    orphans: vi.fn().mockResolvedValue([]),
    removeOrphan: vi.fn().mockResolvedValue(undefined),
  } satisfies RenderStore;
  const documents = {
    createGenerated: vi.fn().mockResolvedValue({ documentId: 'doc-1', versionId: 'ver-1' }),
    receiveGenerated: vi.fn().mockResolvedValue({}),
  };
  const settings = {
    get: vi.fn((_scope: TxScope, key: string) => {
      if (key === 'format.number_systems') {
        return Promise.resolve('numberSystems' in over ? over.numberSystems : STORED_SYSTEMS);
      }
      if (key === 'format.date') {
        return Promise.resolve('dateFormat' in over ? over.dateFormat : 'dd MMM yyyy');
      }
      if (key === 'entity.profile') return Promise.resolve(live.profile);
      return Promise.resolve('pan' in over ? over.pan : '301234567');
    }),
  } as unknown as RenderSettings;
  const pdf = { htmlToPdf: vi.fn().mockResolvedValue(PDF) };
  const runTx: RunInTx = (_scope, _actor, fn) => fn(TX);
  // A watched resolver per scope, standing in for DocumentLogoResolverFactory.
  const resolveLogo = vi.fn<DocumentLogoResolver>(over.logo ?? (() => Promise.resolve(null)));
  const logos = { forScope: vi.fn((_scope: TxScope) => resolveLogo) };
  const sweeper = new PurchaseOrderRenderSweeper(
    store,
    runTx,
    documents,
    settings,
    pdf,
    () => now,
    logos,
  );
  return {
    store,
    documents,
    settings,
    pdf,
    sweeper,
    live,
    logos,
    resolveLogo,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe('PurchaseOrderRenderSweeper.renderOne', () => {
  it('renders a version: a version-owned document under the render job', async () => {
    const f = fixture();
    const c = candidate(1);
    await expect(f.sweeper.renderOne(c)).resolves.toBe('rendered');

    const html = f.pdf.htmlToPdf.mock.calls[0]?.[0] as string;
    expect(html).toContain('<h1>Purchase Order</h1>');
    expect(html).toContain('NPR 21,24,400.00');
    expect(html).toContain('PAN/VAT 301234567');

    expect(f.documents.createGenerated).toHaveBeenCalledWith(
      TX,
      { ownerType: 'purchase_order_version', ownerId: c.versionId },
      { filename: 'PO-2083-84-00007-v1.pdf', declaredMime: 'application/pdf', bytes: PDF },
    );
    const who = f.documents.receiveGenerated.mock.calls[0]?.[2] as {
      actor: { kind: string; id: string };
    };
    expect(who.actor).toMatchObject({ kind: 'system', id: 'system:purchase-order-render' });
    expect(f.settings.get).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', organizationId: 'org-1' },
      'entity.pan_vat_no',
    );
  });

  it('reads the per-currency number systems and the date format for the version scope', async () => {
    const f = fixture();
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    const scope = { tenantId: 'tenant-1', organizationId: 'org-1' };
    expect(f.settings.get).toHaveBeenCalledWith(scope, 'format.number_systems');
    expect(f.settings.get).toHaveBeenCalledWith(scope, 'format.date');
  });

  it('groups each currency by its own system: lakh for NPR, thousands for USD, in one setting', async () => {
    const npr = fixture();
    await npr.sweeper.renderOne(candidate(1));
    expect(npr.pdf.htmlToPdf.mock.calls[0]?.[0]).toContain('NPR 21,24,400.00');

    const usd = fixture({ src: source(1, 'USD') });
    await usd.sweeper.renderOne(candidate(1));
    const html = usd.pdf.htmlToPdf.mock.calls[0]?.[0] as string;
    expect(html).toContain('USD 2,124,400.00');
    expect(html).not.toContain('21,24,400');
  });

  it('follows a changed setting: USD on lakh grouping, NPR on international grouping', async () => {
    const swapped = { NPR: 'international', INR: 'south_asian', USD: 'south_asian' };
    const usd = fixture({ src: source(1, 'USD'), numberSystems: swapped });
    await usd.sweeper.renderOne(candidate(1));
    expect(usd.pdf.htmlToPdf.mock.calls[0]?.[0]).toContain('USD 21,24,400.00');
    const npr = fixture({ numberSystems: swapped });
    await npr.sweeper.renderOne(candidate(1));
    expect(npr.pdf.htmlToPdf.mock.calls[0]?.[0]).toContain('NPR 2,124,400.00');
  });

  it('prints the issue date in the chosen pattern', async () => {
    const def = fixture();
    await def.sweeper.renderOne(candidate(1));
    expect(def.pdf.htmlToPdf.mock.calls[0]?.[0]).toContain('09 Nov 2026');

    const chosen = fixture({ dateFormat: 'dd/MM/yyyy' });
    await expect(chosen.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    const html = chosen.pdf.htmlToPdf.mock.calls[0]?.[0] as string;
    expect(html).toContain('09/11/2026');
    expect(html).not.toContain('09 Nov 2026');
  });

  it.each([['metric'], [null], [undefined], [42], [{ NPR: 'metric' }]])(
    'falls back to the default grouping, and still renders, when number_systems is %j',
    async (bad) => {
      const f = fixture({ numberSystems: bad });
      await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
      expect(f.pdf.htmlToPdf.mock.calls[0]?.[0]).toContain('NPR 21,24,400.00');
      const usd = fixture({ src: source(1, 'USD'), numberSystems: bad });
      await usd.sweeper.renderOne(candidate(1));
      expect(usd.pdf.htmlToPdf.mock.calls[0]?.[0]).toContain('USD 2,124,400.00');
    },
  );

  it.each([['yyyy'], [null], [undefined], [42]])(
    'falls back to the default date pattern, and still renders, when format.date is %j',
    async (bad) => {
      const f = fixture({ dateFormat: bad });
      await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
      expect(f.pdf.htmlToPdf.mock.calls[0]?.[0]).toContain('09 Nov 2026');
    },
  );

  it('names the file after the version of an amendment', async () => {
    const f = fixture({ src: source(2) });
    await f.sweeper.renderOne(candidate(1));
    expect(f.documents.createGenerated.mock.calls[0]?.[2]).toMatchObject({
      filename: 'PO-2083-84-00007-v2.pdf',
    });
  });

  it('renders without a buyer PAN when the entity has none set', async () => {
    const f = fixture({ pan: null });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    expect(f.pdf.htmlToPdf.mock.calls[0]?.[0]).not.toContain('PAN/VAT');
  });

  it('skips when a racing render already stored a document: no second file', async () => {
    const f = fixture({ hasDocument: true });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('skipped');
    expect(f.documents.createGenerated).not.toHaveBeenCalled();
    expect(f.documents.receiveGenerated).not.toHaveBeenCalled();
  });

  it('fails without a document when Gotenberg fails', async () => {
    const f = fixture({ candidates: [candidate(1)] });
    f.pdf.htmlToPdf.mockRejectedValue(new GotenbergError('boom', 'http', 500));
    const result = await f.sweeper.sweep();
    expect(result).toMatchObject({ rendered: 0, failed: 1 });
    expect(result.failures).toEqual([
      { versionId: candidate(1).versionId, kind: 'gotenberg_http' },
    ]);
    expect(f.documents.createGenerated).not.toHaveBeenCalled();
  });

  it('fails with source_missing when the version rows are gone', async () => {
    const f = fixture({ src: undefined });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('failed');
    expect(f.pdf.htmlToPdf).not.toHaveBeenCalled();
  });
});

describe('PurchaseOrderRenderSweeper.sweep', () => {
  it('leaves a failed version out of the query for the retry window, then tries it again', async () => {
    const f = fixture({ candidates: [candidate(1)] });
    f.pdf.htmlToPdf.mockRejectedValueOnce(new GotenbergError('boom', 'timeout'));
    await f.sweeper.sweep();
    expect(f.store.candidates).toHaveBeenLastCalledWith(10, [], undefined);

    f.advance(FAILED_RETRY_MS - 1_000);
    await f.sweeper.sweep();
    expect(f.store.candidates).toHaveBeenLastCalledWith(
      10,
      [candidate(1).versionId],
      candidate(1).versionId,
    );

    f.advance(2_000);
    await f.sweeper.sweep();
    expect(f.store.candidates).toHaveBeenLastCalledWith(10, [], candidate(1).versionId);
  });

  it('advances past failed candidates and keeps its position across an empty tick', async () => {
    const f = fixture();
    f.pdf.htmlToPdf.mockRejectedValue(new GotenbergError('boom', 'timeout'));
    f.store.candidates.mockResolvedValueOnce([candidate(1), candidate(2)]).mockResolvedValue([]);
    await f.sweeper.sweep();
    f.advance(FAILED_RETRY_MS + 1);
    await f.sweeper.sweep();
    expect(f.store.candidates).toHaveBeenLastCalledWith(10, [], candidate(2).versionId);
    await f.sweeper.sweep();
    expect(f.store.candidates).toHaveBeenLastCalledWith(10, [], candidate(2).versionId);
  });

  it('removes orphans an hour old and counts them', async () => {
    const f = fixture();
    f.store.orphans.mockResolvedValue([
      { tenantId: 'tenant-1', organizationId: 'org-1', documentId: 'doc-9' },
    ]);
    const result = await f.sweeper.sweep();
    expect(result.orphansRemoved).toBe(1);
    expect(f.store.removeOrphan).toHaveBeenCalledOnce();
    const cutoff = f.store.orphans.mock.calls[0]?.[0] as Date;
    expect(NOW.getTime() - cutoff.getTime()).toBe(60 * 60_000);
  });
});

describe('failureKind', () => {
  it('names a kind, never a message', () => {
    expect(failureKind(new GotenbergError('secret url', 'too_large'))).toBe('gotenberg_too_large');
    expect(failureKind(new RenderSourceMissingError())).toBe('source_missing');
    expect(failureKind(new PurchaseOrderNotRenderableError('x'))).toBe('not_renderable');
    expect(failureKind(new BadRequestException('x'))).toBe('http_400');
    expect(failureKind(new Error('vendor data'))).toBe('error');
  });
});

describe('PurchaseOrderRenderSweeper: the company logo', () => {
  const scope = { tenantId: 'tenant-1', organizationId: 'org-1' };
  const LOGO_A = 'data:image/png;base64,TE9HT0E=';
  const LOGO_B = 'data:image/png;base64,TE9HT0I=';
  const DOC_A = '0b6c2a10-0000-4000-8000-00000000000a';
  const DOC_B = '0b6c2a10-0000-4000-8000-00000000000b';
  const profile = (over: Record<string, unknown> = {}) => ({ ...EMPTY_COMPANY_PROFILE, ...over });
  const htmlOf = (f: ReturnType<typeof fixture>, n = 0) =>
    f.pdf.htmlToPdf.mock.calls[n]?.[0] as string;

  it('freezes the logo into the render and draws it, resolved in the version scope', async () => {
    const f = fixture({
      profile: profile({ logoDocumentId: DOC_A }),
      logo: (id) => Promise.resolve(id === DOC_A ? LOGO_A : null),
    });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    expect(f.logos.forScope).toHaveBeenCalledWith(scope);
    expect(f.resolveLogo).toHaveBeenCalledWith(DOC_A);
    expect(htmlOf(f)).toContain(`<img class="logo" src="${LOGO_A}" alt="Techrida Pvt. Ltd.">`);
    expect(htmlOf(f)).toContain('img-src data:');
  });

  it.each([
    ['the profile has no logo', profile()],
    ['the profile is unset', undefined],
    ['the profile no longer parses', { displayName: 42 }],
  ])('prints no logo, and never calls the resolver, when %s', async (_name, value) => {
    const f = fixture({ profile: value });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    expect(f.logos.forScope).not.toHaveBeenCalled();
    expect(f.resolveLogo).not.toHaveBeenCalled();
    expect(htmlOf(f)).not.toContain('<img');
  });

  it('falls back to the legacy logo when the document resolves to nothing', async () => {
    const f = fixture({ profile: profile({ logoDocumentId: DOC_A, legacyLogoDataUrl: LOGO_B }) });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    expect(f.resolveLogo).toHaveBeenCalledWith(DOC_A);
    expect(htmlOf(f)).toContain(`src="${LOGO_B}"`);
  });

  it('fails, without storing a document, when a referenced logo cannot be read', async () => {
    const f = fixture({
      profile: profile({ logoDocumentId: DOC_A, legacyLogoDataUrl: LOGO_B }),
      logo: () => Promise.reject(new Error('disk gone: /srv/files/secret')),
      candidates: [candidate(1)],
    });
    const swept = await f.sweeper.sweep();
    expect(swept.rendered).toBe(0);
    expect(swept.failures).toEqual([
      { versionId: candidate(1).versionId, kind: 'document_logo_unavailable' },
    ]);
    expect(f.pdf.htmlToPdf).not.toHaveBeenCalled();
    expect(f.documents.createGenerated).not.toHaveBeenCalled();
  });

  it('prints each version with the logo in force at its render', async () => {
    const f = fixture({
      profile: profile({ logoDocumentId: DOC_A }),
      logo: (id) => Promise.resolve(id === DOC_A ? LOGO_A : LOGO_B),
    });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    f.live.profile = profile({ logoDocumentId: DOC_B });
    await expect(f.sweeper.renderOne(candidate(2))).resolves.toBe('rendered');
    expect(htmlOf(f, 0)).toContain(`src="${LOGO_A}"`);
    expect(htmlOf(f, 1)).toContain(`src="${LOGO_B}"`);
    expect(htmlOf(f, 1)).not.toContain(LOGO_A);
  });
});
