import { createHash } from 'node:crypto';

import {
  CreateDocumentBodySchema,
  DOCUMENT_SETTING_DEFAULTS,
  EMPTY_SNAPSHOT_COMPANY_PROFILE,
  type DocumentStyleSnapshot,
} from '@bos/contracts';
import { BadRequestException } from '@nestjs/common';

import type { DbTransaction } from '../../../platform/db/db.module';
import type { Actor, TxScope } from '../../../platform/db/tx';
import { describe, expect, it, vi } from 'vitest';

import { GotenbergError } from './gotenberg.client';
import type { DocumentLogoResolver } from './issuer';
import { renderQuotationHtml } from './quotation-html';
import { MAX_RENDER_ATTEMPTS } from './render-retry';
import {
  failureKind,
  ORPHAN_AFTER_MS,
  PENDING_STALE_MS,
  QuotationRenderProcessor,
  QuotationRenderScheduler,
  QuotationRenderSweeper,
  SWEEP_EVERY_MS,
  type OrphanDocument,
  type RenderCandidate,
  type RenderSource,
  type RenderStore,
  type RunInTx,
} from './quotation-render.sweeper';

// The real renderer, watched: the snapshot it is handed is what these tests assert on.
vi.mock('./quotation-html', async (importActual) => {
  const actual = await importActual<typeof import('./quotation-html')>();
  return { ...actual, renderQuotationHtml: vi.fn(actual.renderQuotationHtml) };
});

// The `entity.address` setting: street lines, city and the entity's own country (FX9).
const address = { line: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' };
const NOW = new Date('2026-11-09T06:00:00.000Z');
const TX = { marker: 'tx' } as unknown as DbTransaction;

const candidate = (n: number): RenderCandidate => ({
  tenantId: 'tenant-1',
  organizationId: 'org-1',
  versionId: `00000000-0000-4000-8000-00000000000${n}`,
});

/** Rows of an approved version, as the store's `load` returns them. */
const source = (versionId: string, number = 'QT-2082-0042'): RenderSource => ({
  version: {
    id: versionId,
    revisionNo: 2,
    status: 'approved',
    rejectionSource: null,
    currency: 'NPR',
    issueDate: '2026-11-08',
    validUntil: '2026-11-23',
    scope: 'Supply and install 12 panels',
    assumptions: null,
    exclusions: null,
    termsAndConditions: null,
    deliveryTimeline: '6 weeks',
    paymentSchedule: [{ label: 'Advance', percent: '100' }],
    subtotal: '1000.00',
    discountAmount: '0.00',
    taxableAmount: '1000.00',
    taxAmount: '130.00',
    total: '1130.00',
    renderState: 'pending',
    renderedDocumentId: null,
    renderedSha256: null,
  },
  quotation: { number },
  customer: {
    legalName: 'Himal Traders Pvt. Ltd.',
    panVatNo: null,
    country: 'NP',
    addressLine: '1 Durbar Marg',
    addressCity: 'Kathmandu',
  },
  contact: null,
  paymentTerm: null,
  lines: [
    {
      lineNo: 1,
      description: 'Panel',
      uom: 'pcs',
      quantity: '1.0000',
      unitPrice: '1000.00',
      gross: '1000.00',
    },
  ],
  taxSummary: [{ label: 'VAT', rate: '13.0000', base: '1000.00', tax: '130.00' }],
  issuerLegalName: 'Techrida Pvt. Ltd.',
  documentStyle: null,
});

/** A snapshot as the version row would hold it. */
const storedStyle = (over: Partial<DocumentStyleSnapshot> = {}): DocumentStyleSnapshot => ({
  style: { layout: 'ledger', primaryColour: '#0f766e' },
  profile: {
    displayName: 'Techrida',
    logoDataUrl: null,
    phones: ['+977 1 5551234'],
    email: 'sales@techrida.example',
    website: null,
    panVatNo: '301234567',
    signatoryName: null,
    signatoryTitle: null,
  },
  numberSystem: 'international',
  capturedAt: '2026-11-01T05:00:00.000Z',
  ...over,
});

const PDF = Buffer.from('%PDF-1.7 fake');

function setup(
  opts: {
    candidates?: RenderCandidate[];
    claims?: Record<string, boolean>;
    orphans?: OrphanDocument[];
    pdf?: () => Promise<Buffer>;
    settings?: Record<string, unknown>;
    missing?: boolean;
    /** The quotation number `load` returns; default QT-2082-0042. */
    number?: string;
    /** The `document_style` the version row already holds, by version id: set by an earlier render. */
    styles?: Record<string, unknown>;
    /** What the logo resolver answers for the profile's logo document; default: no bytes (null). */
    logo?: DocumentLogoResolver;
    /** The attempts markFailed reports after counting the failure; default 1 (tries left). */
    attemptsAfterFailure?: number;
    /** Claims left by a worker that died, as the store finds them; default none. */
    abandoned?: RenderCandidate[];
  } = {},
) {
  const calls: string[] = [];
  // The version rows' document_style: a stateful stand-in for the column, written once like the real store.
  const styles = new Map<string, unknown>(Object.entries(opts.styles ?? {}));
  const claimed = opts.claims ?? {};
  const store: RenderStore = {
    candidates: vi.fn((now: Date, limit: number) => {
      calls.push(`candidates(${now.toISOString()},${limit})`);
      return Promise.resolve(opts.candidates ?? []);
    }),
    abandoned: vi.fn((staleBefore: Date, limit: number) => {
      calls.push(`abandoned(${staleBefore.toISOString()},${limit})`);
      return Promise.resolve(opts.abandoned ?? []);
    }),
    markAbandoned: vi.fn((_tx: DbTransaction, c: RenderCandidate) => {
      calls.push(`abandoned:${c.versionId}`);
      return Promise.resolve({
        attempts: opts.attemptsAfterFailure ?? 1,
        quotationId: `quotation-of-${c.versionId}`,
      });
    }),
    claim: vi.fn((_tx: DbTransaction, c: RenderCandidate) => {
      calls.push(`claim:${c.versionId}`);
      return Promise.resolve(claimed[c.versionId] ?? true);
    }),
    load: vi.fn((_tx: DbTransaction, c: RenderCandidate) => {
      calls.push(`load:${c.versionId}`);
      if (opts.missing === true) return Promise.resolve(undefined);
      return Promise.resolve({
        ...source(c.versionId, opts.number),
        documentStyle: styles.get(c.versionId) ?? null,
      });
    }),
    saveDocumentStyle: vi.fn(
      (_tx: DbTransaction, c: RenderCandidate, style: DocumentStyleSnapshot) => {
        calls.push(`style:${c.versionId}`);
        if (!styles.has(c.versionId)) styles.set(c.versionId, style);
        return Promise.resolve(styles.get(c.versionId));
      },
    ),
    markRendered: vi.fn((_tx: DbTransaction, c: RenderCandidate) => {
      calls.push(`rendered:${c.versionId}`);
      return Promise.resolve();
    }),
    markFailed: vi.fn((_tx: DbTransaction, c: RenderCandidate) => {
      calls.push(`failed:${c.versionId}`);
      return Promise.resolve({
        attempts: opts.attemptsAfterFailure ?? 1,
        quotationId: `quotation-of-${c.versionId}`,
      });
    }),
    orphans: vi.fn(() => Promise.resolve(opts.orphans ?? [])),
    removeOrphan: vi.fn((_tx: DbTransaction, o: OrphanDocument) => {
      calls.push(`orphan:${o.documentId}`);
      return Promise.resolve();
    }),
  };
  const txs: { scope: TxScope; actor: Actor }[] = [];
  const runTx: RunInTx = (scope, actor, fn) => {
    txs.push({ scope, actor });
    return fn(TX);
  };
  const documents = {
    createGenerated: vi.fn(
      (
        _tx: DbTransaction,
        owner: { ownerType: string; ownerId: string },
        file: { filename: string; declaredMime: string; bytes: Buffer },
      ) => {
        calls.push(`create:${owner.ownerId}`);
        // The schema the real createGenerated parses before it writes (documents.service.ts), with the same
        // exception: a file the documents module refuses is refused here too.
        const parsed = CreateDocumentBodySchema.safeParse({
          ...owner,
          filename: file.filename,
          declaredMime: file.declaredMime,
          sizeBytes: file.bytes.length,
        });
        if (!parsed.success) {
          return Promise.reject(new BadRequestException('Invalid generated file'));
        }
        return Promise.resolve({ documentId: 'doc-1', versionId: 'docver-1' });
      },
    ),
    receiveGenerated: vi.fn(() => {
      calls.push('receive');
      return Promise.resolve({} as never);
    }),
  };
  const htmlToPdf = vi.fn((html: string) => {
    calls.push(`pdf:${html.includes('QT-2082-0042') ? 'html' : 'empty'}`);
    return (opts.pdf ?? (() => Promise.resolve(PDF)))();
  });
  // What the real SettingsService answers for a key nobody wrote: the default.
  const settingValues = {
    ...DOCUMENT_SETTING_DEFAULTS,
    'entity.pan_vat_no': '301234567',
    'entity.address': address,
    ...opts.settings,
  } as Record<string, unknown>;
  const settings = {
    get: vi.fn((_scope: TxScope, key: string) => Promise.resolve(settingValues[key])),
  };
  // A watched resolver per scope, standing in for DocumentLogoResolverFactory.
  const resolveLogo = vi.fn<DocumentLogoResolver>(opts.logo ?? (() => Promise.resolve(null)));
  const logos = { forScope: vi.fn((_scope: TxScope) => resolveLogo) };
  const audit = {
    record: vi.fn((_tx: DbTransaction, _e: unknown) => {
      calls.push('audit');
      return Promise.resolve();
    }),
  };
  const sweeper = new QuotationRenderSweeper(
    store,
    runTx,
    documents,
    settings as never,
    { htmlToPdf },
    () => NOW,
    logos,
    audit,
  );
  return {
    sweeper,
    audit,
    store,
    documents,
    htmlToPdf,
    calls,
    txs,
    settingValues,
    styles,
    logos,
    resolveLogo,
  };
}

describe('QuotationRenderSweeper', () => {
  it('renders an approved version: claim, load, PDF, document, receive, then marks it rendered', async () => {
    const c = candidate(1);
    const { sweeper, calls, documents, store, txs } = setup({ candidates: [c] });
    await expect(sweeper.sweep()).resolves.toEqual({
      rendered: 1,
      failed: 0,
      skipped: 0,
      orphansRemoved: 0,
      failures: [],
    });
    expect(calls.filter((x) => !x.startsWith('candidates') && !x.startsWith('abandoned('))).toEqual(
      [
        `claim:${c.versionId}`,
        `load:${c.versionId}`,
        `style:${c.versionId}`,
        'pdf:html',
        `create:${c.versionId}`,
        'receive',
        `rendered:${c.versionId}`,
      ],
    );
    expect(documents.createGenerated).toHaveBeenCalledWith(
      TX,
      { ownerType: 'quotation_version', ownerId: c.versionId },
      { filename: 'QT-2082-0042-R2.pdf', declaredMime: 'application/pdf', bytes: PDF },
    );
    // The receive step gets the same scope and the render job's actor, which the owner policy checks by prefix.
    const [, , who] = documents.receiveGenerated.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { scope: TxScope; actor: Actor },
    ];
    expect(who.scope).toEqual({ tenantId: c.tenantId, organizationId: c.organizationId });
    expect(who.actor).toMatchObject({ kind: 'system', id: 'system:quotation-render' });
    expect(txs.every((t) => t.actor.id === 'system:quotation-render')).toBe(true);
    // The sha256 is the 32-byte digest of the bytes.
    const [, , rendered] = (store.markRendered as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      unknown,
      { documentId: string; sha256: Buffer },
    ];
    expect(rendered.documentId).toBe('doc-1');
    expect(rendered.sha256).toEqual(createHash('sha256').update(PDF).digest());
    expect(rendered.sha256.length).toBe(32);
  });

  it('asks the store only for work due, with a bounded batch', async () => {
    const { sweeper, store } = setup();
    await sweeper.sweep();
    expect(store.candidates).toHaveBeenCalledWith(NOW, 10);
    expect(store.orphans).toHaveBeenCalledWith(new Date(NOW.getTime() - ORPHAN_AFTER_MS), 50);
  });

  it('skips a version it could not claim (already rendered, or another worker has it)', async () => {
    const taken = candidate(1);
    const free = candidate(2);
    const { sweeper, calls, htmlToPdf } = setup({
      candidates: [taken, free],
      claims: { [taken.versionId]: false },
    });
    await expect(sweeper.sweep()).resolves.toMatchObject({ rendered: 1, skipped: 1, failed: 0 });
    expect(calls).not.toContain(`load:${taken.versionId}`);
    expect(calls).not.toContain(`create:${taken.versionId}`);
    expect(htmlToPdf).toHaveBeenCalledTimes(1);
  });

  it('marks the version failed on a Gotenberg error, logs the kind only, and goes on', async () => {
    const bad = candidate(1);
    const good = candidate(2);
    let n = 0;
    const secret = 'http://gotenberg:3000/forms/chromium Himal Traders';
    const { sweeper, calls, documents } = setup({
      candidates: [bad, good],
      pdf: () => {
        n += 1;
        return n === 1
          ? Promise.reject(new GotenbergError(secret, 'timeout'))
          : Promise.resolve(PDF);
      },
    });
    const warn = vi.spyOn(
      (sweeper as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    );
    await expect(sweeper.sweep()).resolves.toMatchObject({ rendered: 1, failed: 1 });
    expect(calls).toContain(`failed:${bad.versionId}`);
    expect(calls).not.toContain(`rendered:${bad.versionId}`);
    expect(documents.createGenerated).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `quotation render failed: version=${bad.versionId} kind=gotenberg_timeout`,
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Himal');
  });

  it('writes no admin entry for a failure with tries left', async () => {
    const c = candidate(1);
    const { sweeper, audit, store } = setup({
      candidates: [c],
      pdf: () => Promise.reject(new GotenbergError('boom', 'http', 500)),
    });
    await sweeper.sweep();
    expect(store.markFailed).toHaveBeenCalledWith(TX, c, NOW);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('writes one admin entry on the quotation, in the failure transaction, when the last try fails', async () => {
    const c = candidate(1);
    const { sweeper, audit, calls, txs } = setup({
      candidates: [c],
      pdf: () => Promise.reject(new GotenbergError('boom', 'http', 500)),
      attemptsAfterFailure: MAX_RENDER_ATTEMPTS,
    });
    await expect(sweeper.sweep()).resolves.toMatchObject({ failed: 1 });
    expect(audit.record).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(TX, {
      action: 'quotation.pdf_render_failed',
      entityType: 'quotations',
      entityId: `quotation-of-${c.versionId}`,
      after: {
        versionId: c.versionId,
        attempts: MAX_RENDER_ATTEMPTS,
        failureKind: 'gotenberg_http',
      },
    });
    // Recorded right after the failure, by the render job, in the same transaction (the last one opened).
    expect(calls.slice(-2)).toEqual([`failed:${c.versionId}`, 'audit']);
    expect(txs.at(-1)?.actor.id).toBe('system:quotation-render');
  });

  it('writes no admin entry when the version was no longer pending (another worker finished it)', async () => {
    const c = candidate(1);
    const { sweeper, audit, store } = setup({
      candidates: [c],
      pdf: () => Promise.reject(new GotenbergError('boom', 'timeout')),
    });
    vi.mocked(store.markFailed).mockResolvedValueOnce(undefined);
    await expect(sweeper.sweep()).resolves.toMatchObject({ failed: 1 });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('counts a dead worker claim once: no failure and no admin entry when another worker counted it first', async () => {
    const mine = candidate(1);
    const theirs = candidate(2);
    const { sweeper, audit, store } = setup({
      abandoned: [mine, theirs],
      attemptsAfterFailure: MAX_RENDER_ATTEMPTS,
    });
    vi.mocked(store.markAbandoned).mockImplementation((_tx, c) =>
      Promise.resolve(
        c.versionId === theirs.versionId
          ? undefined
          : { attempts: MAX_RENDER_ATTEMPTS, quotationId: `quotation-of-${c.versionId}` },
      ),
    );
    await expect(sweeper.sweep()).resolves.toMatchObject({
      failed: 1,
      failures: [{ versionId: mine.versionId, kind: 'abandoned' }],
    });
    expect(store.abandoned).toHaveBeenCalledWith(new Date(NOW.getTime() - PENDING_STALE_MS), 50);
    expect(audit.record).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(TX, {
      action: 'quotation.pdf_render_failed',
      entityType: 'quotations',
      entityId: `quotation-of-${mine.versionId}`,
      after: { versionId: mine.versionId, attempts: MAX_RENDER_ATTEMPTS, failureKind: 'abandoned' },
    });
  });

  it('fails the version, not the sweep, when the issuing entity has no address', async () => {
    const c = candidate(1);
    const { sweeper, calls, htmlToPdf } = setup({
      candidates: [c],
      settings: { 'entity.address': null },
    });
    await expect(sweeper.sweep()).resolves.toMatchObject({ failed: 1, rendered: 0 });
    expect(calls).toContain(`failed:${c.versionId}`);
    expect(htmlToPdf).not.toHaveBeenCalled();
  });

  it('renders a version whose number carries the fiscal year (QT-2083/84-00001): the PDF name has no slash', async () => {
    const c = candidate(1);
    const { sweeper, documents } = setup({ candidates: [c], number: 'QT-2083/84-00001' });
    await expect(sweeper.sweep()).resolves.toEqual({
      rendered: 1,
      failed: 0,
      skipped: 0,
      orphansRemoved: 0,
      failures: [],
    });
    expect(documents.createGenerated).toHaveBeenCalledWith(
      TX,
      { ownerType: 'quotation_version', ownerId: c.versionId },
      { filename: 'QT-2083-84-00001-R2.pdf', declaredMime: 'application/pdf', bytes: PDF },
    );
  });

  it('reports each failed version with its kind in the result, so a caller need not read the log', async () => {
    const noAddress = candidate(1);
    const { sweeper } = setup({ candidates: [noAddress], settings: { 'entity.address': null } });
    await expect(sweeper.sweep()).resolves.toMatchObject({
      failed: 1,
      failures: [{ versionId: noAddress.versionId, kind: 'issuer_incomplete' }],
    });
  });

  it('fails the version when its rows are gone', async () => {
    const c = candidate(1);
    const { sweeper, calls } = setup({ candidates: [c], missing: true });
    await expect(sweeper.sweep()).resolves.toMatchObject({ failed: 1 });
    expect(calls).toContain(`failed:${c.versionId}`);
  });

  it('leaves the version recoverable when the documents step is refused', async () => {
    const c = candidate(1);
    const { sweeper, calls, documents } = setup({ candidates: [c] });
    documents.createGenerated.mockRejectedValueOnce(new Error('forbidden'));
    await expect(sweeper.sweep()).resolves.toMatchObject({ failed: 1 });
    expect(calls).not.toContain('receive');
    expect(calls).not.toContain(`rendered:${c.versionId}`);
    expect(calls).toContain(`failed:${c.versionId}`);
  });

  describe('the document style frozen with the version', () => {
    const htmlOptions = () =>
      vi.mocked(renderQuotationHtml).mock.calls.map((call) => call[1] as { snapshot: unknown });

    it('captures the style from settings at the first render, stores it, and renders with it', async () => {
      vi.mocked(renderQuotationHtml).mockClear();
      const c = candidate(1);
      const { sweeper, settingValues, styles, store } = setup({ candidates: [c] });
      settingValues['document.style'] = { layout: 'tinted', primaryColour: '#B45309' };
      settingValues['entity.profile'] = {
        ...DOCUMENT_SETTING_DEFAULTS['entity.profile'],
        displayName: 'Techrida Nepal',
        panVatNo: null,
      };
      settingValues['format.number_systems'] = {
        NPR: 'international',
        INR: 'international',
        USD: 'international',
      };
      settingValues['format.date'] = 'yyyy-MM-dd';
      await expect(sweeper.sweep()).resolves.toMatchObject({ rendered: 1, failed: 0 });
      const expected = {
        style: { layout: 'tinted', primaryColour: '#b45309' },
        // The profile has no number of its own, so the entity's PAN/VAT setting fills it.
        profile: {
          ...EMPTY_SNAPSHOT_COMPANY_PROFILE,
          displayName: 'Techrida Nepal',
          panVatNo: '301234567',
        },
        numberSystems: { NPR: 'international', INR: 'international', USD: 'international' },
        dateFormat: 'yyyy-MM-dd',
        capturedAt: NOW.toISOString(),
      };
      expect(styles.get(c.versionId)).toEqual(expected);
      expect(store.saveDocumentStyle).toHaveBeenCalledTimes(1);
      expect(htmlOptions()).toEqual([{ snapshot: expected }]);
    });

    it('keeps a PAN/VAT number the profile carries itself over the entity setting', async () => {
      const c = candidate(1);
      const { sweeper, settingValues, styles } = setup({ candidates: [c] });
      settingValues['entity.profile'] = {
        ...DOCUMENT_SETTING_DEFAULTS['entity.profile'],
        panVatNo: '999999999',
      };
      await sweeper.sweep();
      expect(styles.get(c.versionId)).toMatchObject({ profile: { panVatNo: '999999999' } });
    });

    it('renders a retry with the stored style although settings changed since (a sent document never drifts)', async () => {
      vi.mocked(renderQuotationHtml).mockClear();
      const c = candidate(1);
      let n = 0;
      const { sweeper, settingValues, styles, store } = setup({
        candidates: [c],
        pdf: () => {
          n += 1;
          return n === 1
            ? Promise.reject(new GotenbergError('down', 'timeout'))
            : Promise.resolve(PDF);
        },
      });
      settingValues['document.style'] = { layout: 'ledger', primaryColour: '#0f766e' };
      await expect(sweeper.renderOne(c)).resolves.toBe('failed');
      const first = styles.get(c.versionId);
      expect(first).toMatchObject({ style: { layout: 'ledger', primaryColour: '#0f766e' } });

      // The admin changes the look between the failed attempt and the retry.
      settingValues['document.style'] = { layout: 'banded', primaryColour: '#be123c' };
      settingValues['format.number_systems'] = {
        NPR: 'international',
        INR: 'international',
        USD: 'international',
      };
      settingValues['entity.profile'] = {
        ...DOCUMENT_SETTING_DEFAULTS['entity.profile'],
        displayName: 'Renamed Co',
      };
      await expect(sweeper.renderOne(c)).resolves.toBe('rendered');

      expect(styles.get(c.versionId)).toBe(first);
      // Nothing was captured or stored the second time: the stored value was used as it is.
      expect(store.saveDocumentStyle).toHaveBeenCalledTimes(1);
      const [a, b] = htmlOptions();
      expect(a?.snapshot).toEqual(first);
      expect(b?.snapshot).toEqual(first);
    });

    it('uses the style a version already holds without reading or storing anything', async () => {
      vi.mocked(renderQuotationHtml).mockClear();
      const c = candidate(1);
      const held = storedStyle();
      const { sweeper, store, settingValues } = setup({
        candidates: [c],
        styles: { [c.versionId]: held },
      });
      settingValues['document.style'] = { layout: 'banded', primaryColour: '#be123c' };
      await expect(sweeper.sweep()).resolves.toMatchObject({ rendered: 1 });
      expect(store.saveDocumentStyle).not.toHaveBeenCalled();
      expect(htmlOptions()).toEqual([{ snapshot: held }]);
    });

    it('renders with the style the version holds when another worker stored one first', async () => {
      vi.mocked(renderQuotationHtml).mockClear();
      const c = candidate(1);
      const winner = storedStyle({ numberSystem: 'south_asian' });
      const { sweeper, store } = setup({ candidates: [c] });
      // The version had none when this worker loaded it, but the racing worker's write landed before ours.
      vi.mocked(store.saveDocumentStyle).mockResolvedValueOnce(winner);
      await expect(sweeper.sweep()).resolves.toMatchObject({ rendered: 1 });
      expect(htmlOptions()).toEqual([{ snapshot: winner }]);
    });

    it.each([
      ['a stored style that is not a snapshot', { style: 'banded' }],
      [
        'a stored style with a colour that is not a hex colour',
        storedStyle({ style: { layout: 'ledger', primaryColour: 'blue' } as never }),
      ],
      ['a stored style of the wrong type', 'ledger'],
    ])('fails the version with a fixed kind for %s, and renders nothing', async (_name, bad) => {
      const c = candidate(1);
      const { sweeper, calls, htmlToPdf, store } = setup({
        candidates: [c],
        styles: { [c.versionId]: bad },
      });
      await expect(sweeper.sweep()).resolves.toMatchObject({
        failed: 1,
        rendered: 0,
        failures: [{ versionId: c.versionId, kind: 'document_style_invalid' }],
      });
      expect(calls).toContain(`failed:${c.versionId}`);
      expect(htmlToPdf).not.toHaveBeenCalled();
      expect(store.saveDocumentStyle).not.toHaveBeenCalled();
    });

    describe('the logo, frozen as bytes', () => {
      const LOGO_DOC = '11111111-1111-4111-8111-111111111111';
      const LOGO_A = 'data:image/png;base64,QUFBQQ==';
      const LOGO_B = 'data:image/jpeg;base64,QkJCQg==';
      const withLogo = (settingValues: Record<string, unknown>) => {
        settingValues['entity.profile'] = {
          ...DOCUMENT_SETTING_DEFAULTS['entity.profile'],
          logoDocumentId: LOGO_DOC,
        };
      };

      it('never asks for a logo when the profile references none (no change for an entity without a logo)', async () => {
        const c = candidate(1);
        const { sweeper, styles, resolveLogo } = setup({ candidates: [c] });
        await expect(sweeper.sweep()).resolves.toMatchObject({ rendered: 1 });
        expect(resolveLogo).not.toHaveBeenCalled();
        expect(styles.get(c.versionId)).toMatchObject({ profile: { logoDataUrl: null } });
      });

      it("freezes the logo document's bytes, read in the version's own scope, and renders them", async () => {
        vi.mocked(renderQuotationHtml).mockClear();
        const c = candidate(1);
        const { sweeper, settingValues, styles, logos, resolveLogo, htmlToPdf } = setup({
          candidates: [c],
          logo: () => Promise.resolve(LOGO_A),
        });
        withLogo(settingValues);
        await expect(sweeper.sweep()).resolves.toMatchObject({ rendered: 1 });
        expect(logos.forScope).toHaveBeenCalledWith({
          tenantId: c.tenantId,
          organizationId: c.organizationId,
        });
        expect(resolveLogo).toHaveBeenCalledWith(LOGO_DOC);
        expect(styles.get(c.versionId)).toMatchObject({ profile: { logoDataUrl: LOGO_A } });
        expect(htmlToPdf.mock.calls[0]?.[0]).toContain(LOGO_A);
      });

      it('keeps the bytes a sent version froze when the logo changes afterwards', async () => {
        const v1 = candidate(1);
        const v2 = candidate(2);
        let current = LOGO_A;
        const { sweeper, settingValues, styles } = setup({
          logo: () => Promise.resolve(current),
        });
        withLogo(settingValues);
        await expect(sweeper.renderOne(v1)).resolves.toBe('rendered');
        const first = styles.get(v1.versionId);
        const firstCopy = structuredClone(first);

        // The admin uploads a new logo; the next version freezes the new bytes.
        current = LOGO_B;
        await expect(sweeper.renderOne(v2)).resolves.toBe('rendered');

        expect(styles.get(v1.versionId)).toBe(first);
        expect(first).toEqual(firstCopy);
        expect(first).toMatchObject({ profile: { logoDataUrl: LOGO_A } });
        expect(styles.get(v2.versionId)).toMatchObject({ profile: { logoDataUrl: LOGO_B } });
      });

      it('renders an older snapshot that carries its logo as a data URL, without asking for a logo', async () => {
        const c = candidate(1);
        const held = storedStyle();
        const old = { ...held, profile: { ...held.profile, logoDataUrl: LOGO_A } };
        const { sweeper, settingValues, resolveLogo, htmlToPdf, store } = setup({
          candidates: [c],
          styles: { [c.versionId]: old },
          logo: () => Promise.resolve(LOGO_B),
        });
        withLogo(settingValues);
        await expect(sweeper.sweep()).resolves.toMatchObject({ rendered: 1 });
        expect(resolveLogo).not.toHaveBeenCalled();
        expect(store.saveDocumentStyle).not.toHaveBeenCalled();
        const html = htmlToPdf.mock.calls[0]?.[0] ?? '';
        expect(html).toContain(LOGO_A);
        expect(html).not.toContain(LOGO_B);
      });

      it('fails the version, and stores no style, when the referenced logo cannot be read (a retry reads it again)', async () => {
        const c = candidate(1);
        const { sweeper, settingValues, styles, store, htmlToPdf } = setup({
          candidates: [c],
          logo: () => Promise.reject(new Error('EIO')),
        });
        withLogo(settingValues);
        await expect(sweeper.sweep()).resolves.toMatchObject({
          failed: 1,
          failures: [{ versionId: c.versionId, kind: 'document_logo_unavailable' }],
        });
        expect(store.saveDocumentStyle).not.toHaveBeenCalled();
        expect(styles.has(c.versionId)).toBe(false);
        expect(htmlToPdf).not.toHaveBeenCalled();
      });
    });

    it('fails, and stores nothing, when the settings hold a value that does not validate', async () => {
      const c = candidate(1);
      const { sweeper, settingValues, styles, htmlToPdf } = setup({ candidates: [c] });
      settingValues['document.style'] = { layout: 'banded', primaryColour: 'red' };
      await expect(sweeper.sweep()).resolves.toMatchObject({
        failed: 1,
        failures: [{ versionId: c.versionId, kind: 'document_style_invalid' }],
      });
      expect(styles.has(c.versionId)).toBe(false);
      expect(htmlToPdf).not.toHaveBeenCalled();
    });
  });

  it('removes orphan generated documents, and one failing removal does not stop the others', async () => {
    const orphans: OrphanDocument[] = [
      { tenantId: 't', organizationId: 'o', documentId: 'd1' },
      { tenantId: 't', organizationId: 'o', documentId: 'd2' },
    ];
    const { sweeper, calls, store } = setup({ orphans });
    (store.removeOrphan as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'));
    await expect(sweeper.sweep()).resolves.toMatchObject({ orphansRemoved: 1 });
    expect(calls).toContain('orphan:d2');
  });
});

describe('failureKind', () => {
  it('maps errors to fixed words', () => {
    expect(failureKind(new GotenbergError('x', 'too_large'))).toBe('gotenberg_too_large');
    expect(failureKind(new Error('secret'))).toBe('error');
    expect(failureKind(new BadRequestException('Invalid generated file: QT-1'))).toBe('http_400');
  });
});

describe('the stale and orphan windows', () => {
  it('counts an abandoned claim as failed after 10 minutes and removes an orphan after an hour', () => {
    // The retry of a failure follows render-retry.ts (render-retry.test.ts).
    expect(PENDING_STALE_MS).toBe(10 * 60_000);
    expect(ORPHAN_AFTER_MS).toBe(60 * 60_000);
  });
});

describe('QuotationRenderProcessor and scheduler', () => {
  it('runs the sweep for its job and refuses a job nobody handles', async () => {
    const sweep = vi.fn(() => Promise.resolve({} as never));
    const processor = new QuotationRenderProcessor({ sweep } as never);
    await processor.process({ name: 'quotation.render.sweep' } as never);
    expect(sweep).toHaveBeenCalledTimes(1);
    await expect(processor.process({ name: 'other' } as never)).rejects.toThrow(
      'Unknown quotation render job',
    );
  });

  it('routes quotation.render.one to renderOne with the job data, and refuses data that is not ids', async () => {
    const renderOne = vi.fn(() => Promise.resolve('rendered' as const));
    const processor = new QuotationRenderProcessor({ renderOne } as never);
    const data = {
      tenantId: '00000000-0000-4000-8000-0000000000a1',
      organizationId: '00000000-0000-4000-8000-0000000000b1',
      id: '00000000-0000-4000-8000-0000000000c1',
    };
    await processor.process({ name: 'quotation.render.one', data } as never);
    expect(renderOne).toHaveBeenCalledWith({
      tenantId: data.tenantId,
      organizationId: data.organizationId,
      versionId: data.id,
    });
    await expect(
      processor.process({ name: 'quotation.render.one', data: { id: 'x' } } as never),
    ).rejects.toThrow();
    expect(renderOne).toHaveBeenCalledTimes(1);
  });

  it('registers one repeatable job, idempotently, through upsertJobScheduler', async () => {
    const upsertJobScheduler = vi.fn(() => Promise.resolve());
    await new QuotationRenderScheduler({ upsertJobScheduler } as never).onApplicationBootstrap();
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      'quotation.render.sweep',
      { every: SWEEP_EVERY_MS },
      expect.objectContaining({ name: 'quotation.render.sweep' }),
    );
  });
});
