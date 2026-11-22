import { EMPTY_COMPANY_PROFILE, type DocumentFormatSnapshot } from '@bos/contracts';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import { GotenbergError } from '../../quotations/render/gotenberg.client';
import type { DocumentLogoResolver } from '../../quotations/render/issuer';
import type { RenderSettings, RunInTx } from '../../quotations/render/quotation-render.sweeper';
import {
  failureKind,
  InvoiceRenderProcessor,
  InvoiceRenderSweeper,
  RenderSourceMissingError,
  type RenderCandidate,
  type RenderSource,
  type RenderStore,
} from './invoice-render.sweeper';
import { InvoiceNotRenderableError } from './invoice-view';

const NOW = new Date('2026-11-09T06:00:00.000Z');
const TX = { marker: 'tx' } as unknown as DbTransaction;
const PDF = Buffer.from('%PDF-1.4 fake');

const candidate = (n: number): RenderCandidate => ({
  tenantId: 'tenant-1',
  organizationId: 'org-1',
  invoiceId: `00000000-0000-4000-8000-00000000000${n}`,
});

const party = { legalName: 'Himal Traders Pvt. Ltd.', panVatNo: 'ABC-12345', address: 'Thamel 4' };
const source = (
  nextPrintNo = 1,
  currency: 'NPR' | 'USD' = 'NPR',
  originalFormat: unknown = null,
): RenderSource => ({
  invoice: {
    kind: 'tax_invoice',
    status: 'issued',
    number: 'INV-2083/84-00001',
    issueDate: '2026-11-09',
    issueDateBs: '2083-07-24',
    dueDate: null,
    currency,
    subtotal: '1880000.00',
    discountAmount: '94000.00',
    taxableVatAmount: '1786000.00',
    exemptAmount: '0.00',
    zeroRatedAmount: '0.00',
    taxAmount: '232180.00',
    total: '2018180.00',
    sellerSnapshot: { ...party, legalName: 'Techrida Pvt. Ltd.' },
    buyerSnapshot: party,
  },
  lines: [
    {
      lineNo: 1,
      description: 'Solar panel',
      uom: 'pcs',
      quantity: '1.0000',
      unitPrice: '1880000.00',
      gross: '1880000.00',
    },
  ],
  taxSummary: [{ label: 'VAT 13%', rate: '13.0000', base: '1786000.00', tax: '232180.00' }],
  nextPrintNo,
  originalFormat,
});

const SOUTH_ASIAN = { NPR: 'south_asian', INR: 'south_asian', USD: 'south_asian' } as const;
const INTERNATIONAL = { NPR: 'international', INR: 'international', USD: 'international' } as const;

function fixture(
  over: {
    src?: RenderSource | undefined;
    hasDocument?: boolean;
    candidates?: RenderCandidate[];
    /** What the store answers for one invoice's eligibility (renderNow); omitted, a candidate. */
    isCandidate?: boolean;
    /** The raw `format.number_systems` value; an omitted key reads as lakh grouping for every currency. */
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
  const store = {
    candidates: vi.fn().mockResolvedValue(over.candidates ?? []),
    isCandidate: vi.fn().mockResolvedValue(over.isCandidate ?? true),
    load: vi.fn().mockResolvedValue('src' in over ? over.src : source()),
    lockAndHasDocument: vi.fn().mockResolvedValue(over.hasDocument ?? false),
    recordPrint: vi.fn().mockResolvedValue(undefined),
    orphans: vi.fn().mockResolvedValue([]),
    removeOrphan: vi.fn().mockResolvedValue(undefined),
    discardUnfilled: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue({ attempts: 1, givenUp: false }),
    clearFailure: vi.fn().mockResolvedValue(undefined),
    savePendingPrint: vi.fn().mockResolvedValue(undefined),
    clearPendingPrint: vi.fn().mockResolvedValue(undefined),
    owedPrints: vi.fn().mockResolvedValue([]),
  } satisfies RenderStore;
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const documents = {
    createGenerated: vi.fn().mockResolvedValue({ documentId: 'doc-1', versionId: 'ver-1' }),
    receiveGenerated: vi.fn().mockResolvedValue({}),
  };
  const live: Record<string, unknown> = {
    'format.number_systems': 'numberSystems' in over ? over.numberSystems : SOUTH_ASIAN,
    'format.date': 'dateFormat' in over ? over.dateFormat : 'dd MMM yyyy',
    'entity.profile': over.profile,
  };
  const settings = {
    get: vi.fn((_scope: TxScope, key: string) => Promise.resolve(live[key])),
  } as unknown as RenderSettings;
  const pdf = { htmlToPdf: vi.fn().mockResolvedValue(PDF) };
  const runTx: RunInTx = (_scope, _actor, fn) => fn(TX);
  // A watched resolver per scope, standing in for DocumentLogoResolverFactory.
  const resolveLogo = vi.fn<DocumentLogoResolver>(over.logo ?? (() => Promise.resolve(null)));
  const logos = { forScope: vi.fn((_scope: TxScope) => resolveLogo) };
  const sweeper = new InvoiceRenderSweeper(
    store,
    runTx,
    documents,
    settings,
    pdf,
    () => now,
    logos,
    audit,
  );
  return {
    store,
    audit,
    documents,
    settings,
    live,
    pdf,
    runTx,
    logos,
    resolveLogo,
    sweeper,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

describe('InvoiceRenderSweeper.renderOne', () => {
  it('renders the original: an invoice-owned document under the render job, then print 1', async () => {
    const f = fixture();
    const c = candidate(1);
    await expect(f.sweeper.renderOne(c)).resolves.toBe('rendered');

    const html = f.pdf.htmlToPdf.mock.calls[0]?.[0] as string;
    expect(html).toContain('<h1>Tax Invoice</h1>');
    expect(html).toContain('NPR 20,18,180.00');
    expect(html).not.toContain('Copy of original');

    expect(f.documents.createGenerated).toHaveBeenCalledWith(
      TX,
      { ownerType: 'invoice', ownerId: c.invoiceId },
      { filename: 'INV-2083-84-00001.pdf', declaredMime: 'application/pdf', bytes: PDF },
    );
    const who = f.documents.receiveGenerated.mock.calls[0]?.[2] as {
      actor: { kind: string; id: string };
    };
    expect(who.actor).toMatchObject({ kind: 'system', id: 'system:invoice-render' });
    // Print 1 keeps the format it printed with.
    expect(f.store.recordPrint).toHaveBeenCalledWith(TX, c, 1, NOW, {
      numberSystems: SOUTH_ASIAN,
      dateFormat: 'dd MMM yyyy',
      logoDataUrl: null,
      sellerContact: null,
      capturedAt: NOW.toISOString(),
    });
  });

  it('reads the number systems and date format for the invoice scope and prints by them', async () => {
    const intl = fixture({ numberSystems: INTERNATIONAL, dateFormat: 'dd/MM/yyyy' });
    await expect(intl.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    const scope = { tenantId: 'tenant-1', organizationId: 'org-1' };
    expect(intl.settings.get).toHaveBeenCalledWith(scope, 'format.number_systems');
    expect(intl.settings.get).toHaveBeenCalledWith(scope, 'format.date');
    const html = intl.pdf.htmlToPdf.mock.calls[0]?.[0] as string;
    expect(html).toContain('NPR 2,018,180.00');
    expect(html).not.toContain('20,18,180');
    expect(html).toContain('09/11/2026');
    expect(html).not.toContain('09 Nov 2026');
  });

  it('groups a USD invoice by its own currency entry, lakh under south_asian', async () => {
    const usd = source(1, 'USD');
    const south = fixture({ src: usd, numberSystems: { ...INTERNATIONAL, USD: 'south_asian' } });
    await south.sweeper.renderOne(candidate(1));
    expect(south.pdf.htmlToPdf.mock.calls[0]?.[0]).toContain('USD 20,18,180.00');
    const intl = fixture({ src: usd, numberSystems: { ...SOUTH_ASIAN, USD: 'international' } });
    await intl.sweeper.renderOne(candidate(1));
    expect(intl.pdf.htmlToPdf.mock.calls[0]?.[0]).toContain('USD 2,018,180.00');
  });

  it.each([['metric'], [null], [undefined], [42], [{ NPR: 'international' }]])(
    'falls back to the default format, and still renders, when the settings are %j',
    async (bad) => {
      const f = fixture({ numberSystems: bad, dateFormat: bad });
      await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
      const html = f.pdf.htmlToPdf.mock.calls[0]?.[0] as string;
      expect(html).toContain('NPR 20,18,180.00');
      expect(html).toContain('09 Nov 2026');
      expect(f.store.recordPrint).toHaveBeenCalledWith(TX, candidate(1), 1, NOW, {
        numberSystems: { NPR: 'south_asian', INR: 'south_asian', USD: 'international' },
        dateFormat: 'dd MMM yyyy',
        logoDataUrl: null,
        sellerContact: null,
        capturedAt: NOW.toISOString(),
      });
    },
  );

  it('prints a copy with the grouping and date of print 1, not the settings changed since', async () => {
    // A store that remembers print 1's format and hands it back on the next load, as the print log does.
    const f = fixture();
    const c = candidate(1);
    let printed = 0;
    let stored: DocumentFormatSnapshot | null = null;
    f.store.load.mockImplementation(() => Promise.resolve(source(printed + 1, 'NPR', stored)));
    f.store.recordPrint.mockImplementation(
      (_tx, _c, printNo: number, _now, format: DocumentFormatSnapshot | null) => {
        printed = printNo;
        if (printNo === 1) stored = format;
        return Promise.resolve();
      },
    );

    await expect(f.sweeper.renderOne(c)).resolves.toBe('rendered');
    const original = f.pdf.htmlToPdf.mock.calls[0]?.[0] as string;
    expect(original).toContain('NPR 20,18,180.00');
    expect(original).toContain('09 Nov 2026');

    // The company changes both settings before the copy is printed.
    f.live['format.number_systems'] = INTERNATIONAL;
    f.live['format.date'] = 'yyyy-MM-dd';
    f.advance(24 * 60 * 60_000);

    await expect(f.sweeper.renderOne(c)).resolves.toBe('rendered');
    const copy = f.pdf.htmlToPdf.mock.calls[1]?.[0] as string;
    expect(copy).toContain('Copy of original (1)');
    expect(copy).toContain('NPR 20,18,180.00');
    expect(copy).not.toContain('NPR 2,018,180.00');
    expect(copy).toContain('09 Nov 2026');
    expect(copy).not.toContain('2026-11-09 <span');
    // Only print 1 stores a format; the copy does not overwrite or add one.
    expect(f.store.recordPrint).toHaveBeenLastCalledWith(TX, c, 2, expect.any(Date), null);
    expect(stored).toMatchObject({ numberSystems: SOUTH_ASIAN, dateFormat: 'dd MMM yyyy' });
  });

  it.each([[null], [{ numberSystems: 'south_asian' }]])(
    'prints a copy with the live settings when print 1 has no usable stored format (%j)',
    async (stored) => {
      const f = fixture({
        src: source(2, 'NPR', stored),
        numberSystems: INTERNATIONAL,
        dateFormat: 'yyyy-MM-dd',
      });
      await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
      const html = f.pdf.htmlToPdf.mock.calls[0]?.[0] as string;
      expect(html).toContain('Copy of original (1)');
      expect(html).toContain('NPR 2,018,180.00');
      expect(html).toContain('2026-11-09 <span class="bs">');
      expect(html).not.toContain('09 Nov 2026');
      expect(f.store.recordPrint).toHaveBeenCalledWith(TX, candidate(1), 2, NOW, null);
    },
  );

  it('prints "Copy of original (n)" from the print log and names the file after the copy', async () => {
    const f = fixture({ src: source(3) });
    await f.sweeper.renderOne(candidate(1));
    expect(f.pdf.htmlToPdf.mock.calls[0]?.[0]).toContain('Copy of original (2)');
    expect(f.documents.createGenerated.mock.calls[0]?.[2]).toMatchObject({
      filename: 'INV-2083-84-00001-copy2.pdf',
    });
    expect(f.store.recordPrint).toHaveBeenCalledWith(TX, candidate(1), 3, NOW, null);
  });

  it('skips when a racing render already stored a document: no second file, no print', async () => {
    const f = fixture({ hasDocument: true });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('skipped');
    expect(f.documents.createGenerated).not.toHaveBeenCalled();
    expect(f.documents.receiveGenerated).not.toHaveBeenCalled();
    expect(f.store.recordPrint).not.toHaveBeenCalled();
  });

  it('fails without a document or a print when Gotenberg fails', async () => {
    const f = fixture({ candidates: [candidate(1)] });
    f.pdf.htmlToPdf.mockRejectedValue(new GotenbergError('boom', 'http', 500));
    const result = await f.sweeper.sweep();
    expect(result).toMatchObject({ rendered: 0, failed: 1 });
    expect(result.failures).toEqual([
      { invoiceId: candidate(1).invoiceId, kind: 'gotenberg_http' },
    ]);
    expect(f.documents.createGenerated).not.toHaveBeenCalled();
    expect(f.store.recordPrint).not.toHaveBeenCalled();
  });

  it('fails with source_missing when the invoice rows are gone', async () => {
    const f = fixture({ src: undefined });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('failed');
    expect(f.pdf.htmlToPdf).not.toHaveBeenCalled();
  });
});

describe('InvoiceRenderSweeper.sweep', () => {
  it('asks the store for the invoices due now, and counts a failure with its kind', async () => {
    const f = fixture({ candidates: [candidate(1)] });
    f.pdf.htmlToPdf.mockRejectedValueOnce(new GotenbergError('boom', 'timeout'));
    await f.sweeper.sweep();
    expect(f.store.candidates).toHaveBeenLastCalledWith(NOW, 10, undefined);
    expect(f.store.recordFailure).toHaveBeenCalledWith(TX, candidate(1), 'gotenberg_timeout', NOW);
    // Not the last try: no admin entry, nothing to discard.
    expect(f.audit.record).not.toHaveBeenCalled();
    expect(f.store.discardUnfilled).not.toHaveBeenCalled();

    f.advance(60_000);
    await f.sweeper.sweep();
    expect(f.store.candidates).toHaveBeenLastCalledWith(
      new Date(NOW.getTime() + 60_000),
      10,
      candidate(1).invoiceId,
    );
  });

  it('writes one admin entry, in the failure transaction, when the last try fails', async () => {
    const f = fixture({ candidates: [candidate(1)] });
    f.pdf.htmlToPdf.mockRejectedValue(new GotenbergError('boom', 'http', 500));
    f.store.recordFailure.mockResolvedValue({ attempts: 4, givenUp: true });
    const result = await f.sweeper.sweep();
    expect(result.failures).toEqual([
      { invoiceId: candidate(1).invoiceId, kind: 'gotenberg_http' },
    ]);
    expect(f.audit.record).toHaveBeenCalledOnce();
    expect(f.audit.record).toHaveBeenCalledWith(TX, {
      action: 'invoice.pdf_render_failed',
      entityType: 'invoices',
      entityId: candidate(1).invoiceId,
      after: { attempts: 4, failureKind: 'gotenberg_http' },
    });
  });

  it('forgets earlier failures in the transaction that records the print', async () => {
    const f = fixture();
    const order: string[] = [];
    f.store.recordPrint.mockImplementation(() => {
      order.push('print');
      return Promise.resolve();
    });
    f.store.clearFailure.mockImplementation(() => {
      order.push('clear');
      return Promise.resolve();
    });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    expect(f.store.clearFailure).toHaveBeenCalledWith(TX, candidate(1));
    expect(order).toEqual(['print', 'clear']);
    expect(f.store.recordFailure).not.toHaveBeenCalled();
  });

  it('discards the document a failed try created before its bytes were stored', async () => {
    const f = fixture();
    f.documents.receiveGenerated.mockRejectedValue(new Error('disk full'));
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('failed');
    expect(f.store.discardUnfilled).toHaveBeenCalledWith(TX, candidate(1), 'doc-1', NOW);
    expect(f.store.recordFailure).toHaveBeenCalledWith(TX, candidate(1), 'error', NOW);
    expect(f.store.recordPrint).not.toHaveBeenCalled();
  });

  it('records print 1 on a second try, with the same format, when the first print write fails after the PDF was stored', async () => {
    const f = fixture();
    const c = candidate(1);
    const format = {
      numberSystems: SOUTH_ASIAN,
      dateFormat: 'dd MMM yyyy',
      logoDataUrl: null,
      sellerContact: null,
      capturedAt: NOW.toISOString(),
    };
    // The settings change while the first write fails: the retry must still store what the stored PDF printed with.
    f.store.recordPrint.mockImplementationOnce(() => {
      f.live['format.number_systems'] = INTERNATIONAL;
      return Promise.reject(new Error('db hiccup'));
    });
    await expect(f.sweeper.renderOne(c)).resolves.toBe('rendered');
    expect(f.store.recordPrint).toHaveBeenCalledTimes(2);
    expect(f.store.recordPrint).toHaveBeenNthCalledWith(1, TX, c, 1, NOW, format);
    expect(f.store.recordPrint).toHaveBeenNthCalledWith(2, TX, c, 1, NOW, format);
    expect(f.store.clearFailure).toHaveBeenCalledWith(TX, c);
    // One render, one document: the stored PDF is the original, never removed or rendered again.
    expect(f.pdf.htmlToPdf).toHaveBeenCalledOnce();
    expect(f.documents.createGenerated).toHaveBeenCalledOnce();
    expect(f.store.discardUnfilled).not.toHaveBeenCalled();
    expect(f.store.recordFailure).not.toHaveBeenCalled();
  });

  it('keeps the stored PDF and counts no failure when print 1 cannot be recorded on the retry either', async () => {
    const f = fixture({ candidates: [candidate(1)] });
    f.store.recordPrint.mockRejectedValue(new Error('print log down'));
    const result = await f.sweeper.sweep();
    expect(result).toMatchObject({ rendered: 1, failed: 0, failures: [] });
    expect(f.store.recordPrint).toHaveBeenCalledTimes(2);
    expect(f.store.discardUnfilled).not.toHaveBeenCalled();
    expect(f.store.recordFailure).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
    expect(Object.keys(f.store)).not.toContain('discardUnprinted');
  });

  it('counts the failure even when the document of the failed try cannot be removed', async () => {
    const f = fixture();
    f.documents.receiveGenerated.mockRejectedValue(new Error('disk full'));
    f.store.discardUnfilled.mockRejectedValue(new Error('db hiccup'));
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('failed');
    expect(f.store.recordFailure).toHaveBeenCalledWith(TX, candidate(1), 'error', NOW);
  });

  it('removes the document of the failed try even when the failure cannot be counted', async () => {
    const f = fixture();
    f.documents.receiveGenerated.mockRejectedValue(new Error('disk full'));
    f.store.recordFailure.mockRejectedValue(new Error('db hiccup'));
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('failed');
    expect(f.store.discardUnfilled).toHaveBeenCalledWith(TX, candidate(1), 'doc-1', NOW);
  });

  it('logs, and does not throw, when the failure itself cannot be recorded', async () => {
    const f = fixture({ candidates: [candidate(1), candidate(2)] });
    f.pdf.htmlToPdf.mockRejectedValueOnce(new GotenbergError('boom', 'timeout'));
    f.store.recordFailure.mockRejectedValueOnce(new Error('db down'));
    const result = await f.sweeper.sweep();
    expect(result).toMatchObject({ rendered: 1, failed: 1 });
  });

  it('advances past failed candidates and keeps its position across an empty tick', async () => {
    const f = fixture();
    f.pdf.htmlToPdf.mockRejectedValue(new GotenbergError('boom', 'timeout'));
    f.store.candidates.mockResolvedValueOnce([candidate(1), candidate(2)]).mockResolvedValue([]);
    await f.sweeper.sweep();
    await f.sweeper.sweep();
    expect(f.store.candidates).toHaveBeenLastCalledWith(NOW, 10, candidate(2).invoiceId);
    await f.sweeper.sweep();
    expect(f.store.candidates).toHaveBeenLastCalledWith(NOW, 10, candidate(2).invoiceId);
  });

  it('removes orphans ten minutes old and counts them', async () => {
    const f = fixture();
    f.store.orphans.mockResolvedValue([
      { tenantId: 'tenant-1', organizationId: 'org-1', documentId: 'doc-9' },
    ]);
    f.store.removeOrphan.mockResolvedValue({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      invoiceId: 'inv-9',
    });
    const result = await f.sweeper.sweep();
    expect(result.orphansRemoved).toBe(1);
    expect(f.store.removeOrphan).toHaveBeenCalledOnce();
    // The crashed render's try is counted once, as `abandoned`.
    expect(f.store.recordFailure).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: 'tenant-1', organizationId: 'org-1', invoiceId: 'inv-9' },
      'abandoned',
      NOW,
    );
    const cutoff = f.store.orphans.mock.calls[0]?.[0] as Date;
    expect(NOW.getTime() - cutoff.getTime()).toBe(10 * 60_000);
  });
});

describe('failureKind', () => {
  it('names a kind, never a message', () => {
    expect(failureKind(new GotenbergError('secret url', 'too_large'))).toBe('gotenberg_too_large');
    expect(failureKind(new RenderSourceMissingError())).toBe('source_missing');
    expect(failureKind(new InvoiceNotRenderableError('x'))).toBe('not_renderable');
    expect(failureKind(new BadRequestException('x'))).toBe('http_400');
    expect(failureKind(new Error('customer data'))).toBe('error');
  });
});

describe('InvoiceRenderSweeper: the company logo', () => {
  const scope = { tenantId: 'tenant-1', organizationId: 'org-1' };
  const LOGO_A = 'data:image/png;base64,TE9HT0E=';
  const LOGO_B = 'data:image/png;base64,TE9HT0I=';
  const DOC_A = '0b6c2a10-0000-4000-8000-00000000000a';
  const DOC_B = '0b6c2a10-0000-4000-8000-00000000000b';
  const profile = (over: Record<string, unknown> = {}) => ({ ...EMPTY_COMPANY_PROFILE, ...over });
  const htmlOf = (f: ReturnType<typeof fixture>, n = 0) =>
    f.pdf.htmlToPdf.mock.calls[n]?.[0] as string;
  const storedLogo = (f: ReturnType<typeof fixture>) =>
    (f.store.recordPrint.mock.calls[0]?.[4] as DocumentFormatSnapshot | null)?.logoDataUrl;

  it('freezes the logo into print 1 and draws it, resolved in the invoice scope', async () => {
    const f = fixture({
      profile: profile({ logoDocumentId: DOC_A }),
      logo: (id) => Promise.resolve(id === DOC_A ? LOGO_A : null),
    });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    expect(f.logos.forScope).toHaveBeenCalledWith(scope);
    expect(f.resolveLogo).toHaveBeenCalledWith(DOC_A);
    expect(htmlOf(f)).toContain(`<img class="logo" src="${LOGO_A}" alt="Techrida Pvt. Ltd.">`);
    expect(htmlOf(f)).toContain('img-src data:');
    expect(storedLogo(f)).toBe(LOGO_A);
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
    expect(storedLogo(f)).toBeNull();
  });

  it('falls back to the legacy logo when the document resolves to nothing', async () => {
    const f = fixture({ profile: profile({ logoDocumentId: DOC_A, legacyLogoDataUrl: LOGO_B }) });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    expect(f.resolveLogo).toHaveBeenCalledWith(DOC_A);
    expect(storedLogo(f)).toBe(LOGO_B);
    expect(htmlOf(f)).toContain(`src="${LOGO_B}"`);
  });

  it('fails, without storing a print, when a referenced logo cannot be read', async () => {
    const f = fixture({
      profile: profile({ logoDocumentId: DOC_A, legacyLogoDataUrl: LOGO_B }),
      logo: () => Promise.reject(new Error('disk gone: /srv/files/secret')),
      candidates: [candidate(1)],
    });
    const swept = await f.sweeper.sweep();
    expect(swept.rendered).toBe(0);
    expect(swept.failures).toEqual([
      { invoiceId: candidate(1).invoiceId, kind: 'document_logo_unavailable' },
    ]);
    expect(f.pdf.htmlToPdf).not.toHaveBeenCalled();
    expect(f.documents.createGenerated).not.toHaveBeenCalled();
    expect(f.store.recordPrint).not.toHaveBeenCalled();
  });

  it('prints a copy with the logo of print 1, after the logo changed, without resolving again', async () => {
    // A store that remembers print 1's format and hands it back on the next load, as the print log does.
    const f = fixture({
      profile: profile({ logoDocumentId: DOC_A }),
      logo: (id) => Promise.resolve(id === DOC_A ? LOGO_A : LOGO_B),
    });
    const c = candidate(1);
    let printed = 0;
    let stored: DocumentFormatSnapshot | null = null;
    f.store.load.mockImplementation(() => Promise.resolve(source(printed + 1, 'NPR', stored)));
    f.store.recordPrint.mockImplementation(
      (_tx, _c, printNo: number, _now, format: DocumentFormatSnapshot | null) => {
        printed = printNo;
        if (printNo === 1) stored = format;
        return Promise.resolve();
      },
    );

    await expect(f.sweeper.renderOne(c)).resolves.toBe('rendered');
    f.live['entity.profile'] = profile({ logoDocumentId: DOC_B });
    f.advance(24 * 60 * 60_000);
    await expect(f.sweeper.renderOne(c)).resolves.toBe('rendered');

    const copy = htmlOf(f, 1);
    expect(copy).toContain('Copy of original (1)');
    expect(copy).toContain(`src="${LOGO_A}"`);
    expect(copy).not.toContain(LOGO_B);
    expect(f.resolveLogo).toHaveBeenCalledTimes(1);
    expect(stored).toMatchObject({ logoDataUrl: LOGO_A });
  });

  it.each([
    [
      'a print stored before logos were frozen',
      { numberSystems: SOUTH_ASIAN, dateFormat: 'dd MMM yyyy', capturedAt: NOW.toISOString() },
    ],
    ['a print with no stored format', null],
  ])('prints a copy of %s without a logo, even with one set now', async (_name, original) => {
    const f = fixture({
      src: source(2, 'NPR', original),
      profile: profile({ logoDocumentId: DOC_A }),
      logo: () => Promise.resolve(LOGO_A),
    });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    expect(htmlOf(f)).toContain('Copy of original (1)');
    expect(htmlOf(f)).not.toContain('<img');
    expect(f.resolveLogo).not.toHaveBeenCalled();
  });
});

describe('InvoiceRenderSweeper: amount in words, signatory and seller contact (U16-Q4)', () => {
  const profile = (over: Record<string, unknown> = {}) => ({ ...EMPTY_COMPANY_PROFILE, ...over });
  // The profile stores each phone as its country and E.164 number (FX9); the print and its frozen copy carry the
  // formatted number.
  const CONTACT_A = {
    phones: [
      { country: 'NP', e164: '+97714000000', label: 'landline' },
      { country: 'NP', e164: '+9779800000000', label: 'mobile' },
    ],
    email: 'billing@techrida.example',
    signatoryName: 'Sita Sharma',
    signatoryTitle: 'Finance Manager',
  };
  const PRINTED_CONTACT_A = { ...CONTACT_A, phones: ['+977 1-4000000', '+977 9800000000'] };
  const htmlOf = (f: ReturnType<typeof fixture>, n = 0) =>
    f.pdf.htmlToPdf.mock.calls[n]?.[0] as string;

  it('prints the words, the signatory and the contact of the profile on print 1, and freezes them', async () => {
    const f = fixture({ profile: profile({ ...CONTACT_A, website: 'https://techrida.example' }) });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    const html = htmlOf(f);
    expect(html).toContain(
      'Amount in words: Twenty Lakh Eighteen Thousand One Hundred Eighty Rupees Only',
    );
    expect(html).toContain('<span class="name">Sita Sharma</span>');
    expect(html).toContain('<span>Finance Manager</span>');
    expect(html).toContain('Authorised signatory');
    expect(html).toContain('Phones +977 1-4000000, +977 9800000000');
    expect(html).toContain('Email billing@techrida.example');
    // Only the four contact keys: never the website.
    expect(html).not.toContain('techrida.example"');
    expect(html).not.toContain('https://techrida.example');
    const stored = f.store.recordPrint.mock.calls[0]?.[4] as DocumentFormatSnapshot;
    expect(stored.sellerContact).toEqual(PRINTED_CONTACT_A);
  });

  it('prints a copy with the contact of print 1 after the profile changed', async () => {
    const f = fixture({ profile: profile(CONTACT_A) });
    const c = candidate(1);
    let printed = 0;
    let stored: DocumentFormatSnapshot | null = null;
    f.store.load.mockImplementation(() => Promise.resolve(source(printed + 1, 'NPR', stored)));
    f.store.recordPrint.mockImplementation(
      (_tx, _c, printNo: number, _now, format: DocumentFormatSnapshot | null) => {
        printed = printNo;
        if (printNo === 1) stored = format;
        return Promise.resolve();
      },
    );

    await expect(f.sweeper.renderOne(c)).resolves.toBe('rendered');
    f.live['entity.profile'] = profile({
      phones: [{ country: 'NP', e164: '+97715999999', label: null }],
      email: 'new@techrida.example',
      signatoryName: 'Hari Rai',
      signatoryTitle: 'Director',
    });
    await expect(f.sweeper.renderOne(c)).resolves.toBe('rendered');

    const copy = htmlOf(f, 1);
    expect(copy).toContain('Copy of original (1)');
    expect(copy).toContain('Sita Sharma');
    expect(copy).toContain('Email billing@techrida.example');
    expect(copy).not.toContain('Hari Rai');
    expect(copy).not.toContain('5999999');
  });

  it('prints a copy of an original printed before contacts were frozen without one, but with the words', async () => {
    const f = fixture({
      src: source(2, 'NPR', {
        numberSystems: SOUTH_ASIAN,
        dateFormat: 'dd MMM yyyy',
        logoDataUrl: null,
        capturedAt: NOW.toISOString(),
      }),
      profile: profile(CONTACT_A),
    });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    const html = htmlOf(f);
    expect(html).toContain('Copy of original (1)');
    expect(html).not.toContain('Sita Sharma');
    expect(html).not.toContain('billing@techrida.example');
    expect(html).toContain('Amount in words: Twenty Lakh');
    expect(html).toContain('Authorised signatory');
  });

  it('prints no contact, and still renders, when the profile no longer parses', async () => {
    const f = fixture({ profile: { phones: 'not a list' } });
    await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    expect(htmlOf(f)).not.toContain('Email ');
    expect(htmlOf(f)).toContain('Authorised signatory');
    const stored = f.store.recordPrint.mock.calls[0]?.[4] as DocumentFormatSnapshot;
    expect(stored.sellerContact).toBeNull();
  });
});

describe('InvoiceRenderSweeper.renderNow and the invoice.render.one job (render on commit)', () => {
  it('renders an invoice that is still a candidate, checking it by the candidate rule first', async () => {
    const f = fixture();
    const c = candidate(1);
    await expect(f.sweeper.renderNow(c)).resolves.toBe('rendered');
    expect(f.store.isCandidate).toHaveBeenCalledWith(c, NOW);
    expect(f.pdf.htmlToPdf).toHaveBeenCalledTimes(1);
    expect(f.store.recordPrint).toHaveBeenCalledTimes(1);
  });

  it('skips, without rendering or counting a failure, an invoice that is no longer a candidate', async () => {
    const f = fixture({ isCandidate: false });
    await expect(f.sweeper.renderNow(candidate(1))).resolves.toBe('skipped');
    expect(f.store.load).not.toHaveBeenCalled();
    expect(f.pdf.htmlToPdf).not.toHaveBeenCalled();
    expect(f.store.recordFailure).not.toHaveBeenCalled();
  });

  it('routes invoice.render.one to renderNow with the job data, and still runs the sweep', async () => {
    const renderNow = vi.fn(() => Promise.resolve('rendered' as const));
    const sweep = vi.fn(() => Promise.resolve({} as never));
    const processor = new InvoiceRenderProcessor({ renderNow, sweep } as never);
    const data = {
      tenantId: '00000000-0000-4000-8000-0000000000a1',
      organizationId: '00000000-0000-4000-8000-0000000000b1',
      id: '00000000-0000-4000-8000-0000000000c1',
    };
    await processor.process({ name: 'invoice.render.one', data } as never);
    expect(renderNow).toHaveBeenCalledWith({
      tenantId: data.tenantId,
      organizationId: data.organizationId,
      invoiceId: data.id,
    });
    await processor.process({ name: 'invoice.render.sweep' } as never);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('fails a one-render job whose data is not ids, and a job nobody handles', async () => {
    const renderNow = vi.fn();
    const processor = new InvoiceRenderProcessor({ renderNow } as never);
    await expect(
      processor.process({ name: 'invoice.render.one', data: { id: 'x' } } as never),
    ).rejects.toThrow();
    expect(renderNow).not.toHaveBeenCalled();
    await expect(processor.process({ name: 'other' } as never)).rejects.toThrow(
      'Unknown invoice render job',
    );
  });
});
