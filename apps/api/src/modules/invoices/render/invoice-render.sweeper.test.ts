import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import { GotenbergError } from '../../quotations/render/gotenberg.client';
import type { RenderSettings, RunInTx } from '../../quotations/render/quotation-render.sweeper';
import {
  failureKind,
  FAILED_RETRY_MS,
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
const source = (nextPrintNo = 1, currency: 'NPR' | 'USD' = 'NPR'): RenderSource => ({
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
});

function fixture(
  over: {
    src?: RenderSource | undefined;
    hasDocument?: boolean;
    candidates?: RenderCandidate[];
    /** The raw `format.number_system` value; an omitted key reads as the stored default. */
    numberSystem?: unknown;
  } = {},
) {
  let now = NOW;
  const store = {
    candidates: vi.fn().mockResolvedValue(over.candidates ?? []),
    load: vi.fn().mockResolvedValue('src' in over ? over.src : source()),
    lockAndHasDocument: vi.fn().mockResolvedValue(over.hasDocument ?? false),
    recordPrint: vi.fn().mockResolvedValue(undefined),
    orphans: vi.fn().mockResolvedValue([]),
    removeOrphan: vi.fn().mockResolvedValue(undefined),
  } satisfies RenderStore;
  const documents = {
    createGenerated: vi.fn().mockResolvedValue({ documentId: 'doc-1', versionId: 'ver-1' }),
    receiveGenerated: vi.fn().mockResolvedValue({}),
  };
  const settings = {
    get: vi.fn((_scope: TxScope, key: string) =>
      Promise.resolve(
        key === 'format.number_system'
          ? 'numberSystem' in over
            ? over.numberSystem
            : 'south_asian'
          : undefined,
      ),
    ),
  } as unknown as RenderSettings;
  const pdf = { htmlToPdf: vi.fn().mockResolvedValue(PDF) };
  const runTx: RunInTx = (_scope, _actor, fn) => fn(TX);
  const sweeper = new InvoiceRenderSweeper(store, runTx, documents, settings, pdf, () => now);
  return {
    store,
    documents,
    settings,
    pdf,
    runTx,
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
    expect(f.store.recordPrint).toHaveBeenCalledWith(TX, c, 1, NOW);
  });

  it('reads the number system for the invoice scope and groups by it', async () => {
    const intl = fixture({ numberSystem: 'international' });
    await expect(intl.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
    expect(intl.settings.get).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', organizationId: 'org-1' },
      'format.number_system',
    );
    const html = intl.pdf.htmlToPdf.mock.calls[0]?.[0] as string;
    expect(html).toContain('NPR 2,018,180.00');
    expect(html).not.toContain('20,18,180');
  });

  it('groups a USD invoice by the setting, lakh under south_asian', async () => {
    const usd = source(1, 'USD');
    const south = fixture({ src: usd, numberSystem: 'south_asian' });
    await south.sweeper.renderOne(candidate(1));
    expect(south.pdf.htmlToPdf.mock.calls[0]?.[0]).toContain('USD 20,18,180.00');
    const intl = fixture({ src: usd, numberSystem: 'international' });
    await intl.sweeper.renderOne(candidate(1));
    expect(intl.pdf.htmlToPdf.mock.calls[0]?.[0]).toContain('USD 2,018,180.00');
  });

  it.each([['metric'], [null], [undefined], [42]])(
    'falls back to south_asian grouping, and still renders, when the setting is %j',
    async (bad) => {
      const f = fixture({ numberSystem: bad });
      await expect(f.sweeper.renderOne(candidate(1))).resolves.toBe('rendered');
      expect(f.pdf.htmlToPdf.mock.calls[0]?.[0]).toContain('NPR 20,18,180.00');
    },
  );

  it('prints "Copy of original (n)" from the print log and names the file after the copy', async () => {
    const f = fixture({ src: source(3) });
    await f.sweeper.renderOne(candidate(1));
    expect(f.pdf.htmlToPdf.mock.calls[0]?.[0]).toContain('Copy of original (2)');
    expect(f.documents.createGenerated.mock.calls[0]?.[2]).toMatchObject({
      filename: 'INV-2083-84-00001-copy2.pdf',
    });
    expect(f.store.recordPrint).toHaveBeenCalledWith(TX, candidate(1), 3, NOW);
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
  it('leaves a failed invoice out of the query for the retry window, then tries it again', async () => {
    const f = fixture({ candidates: [candidate(1)] });
    f.pdf.htmlToPdf.mockRejectedValueOnce(new GotenbergError('boom', 'timeout'));
    await f.sweeper.sweep();
    expect(f.store.candidates).toHaveBeenLastCalledWith(10, [], undefined);

    f.advance(FAILED_RETRY_MS - 1_000);
    await f.sweeper.sweep();
    expect(f.store.candidates).toHaveBeenLastCalledWith(
      10,
      [candidate(1).invoiceId],
      candidate(1).invoiceId,
    );

    f.advance(2_000);
    await f.sweeper.sweep();
    expect(f.store.candidates).toHaveBeenLastCalledWith(10, [], candidate(1).invoiceId);
  });

  it('advances past failed candidates and keeps its position across an empty tick', async () => {
    const f = fixture();
    f.pdf.htmlToPdf.mockRejectedValue(new GotenbergError('boom', 'timeout'));
    f.store.candidates.mockResolvedValueOnce([candidate(1), candidate(2)]).mockResolvedValue([]);
    await f.sweeper.sweep();
    f.advance(FAILED_RETRY_MS + 1);
    await f.sweeper.sweep();
    expect(f.store.candidates).toHaveBeenLastCalledWith(10, [], candidate(2).invoiceId);
    await f.sweeper.sweep();
    expect(f.store.candidates).toHaveBeenLastCalledWith(10, [], candidate(2).invoiceId);
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
    expect(failureKind(new InvoiceNotRenderableError('x'))).toBe('not_renderable');
    expect(failureKind(new BadRequestException('x'))).toBe('http_400');
    expect(failureKind(new Error('customer data'))).toBe('error');
  });
});
