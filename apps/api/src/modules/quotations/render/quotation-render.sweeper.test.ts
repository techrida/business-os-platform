import { createHash } from 'node:crypto';

import type { DbTransaction } from '../../../platform/db/db.module';
import type { Actor, TxScope } from '../../../platform/db/tx';
import { describe, expect, it, vi } from 'vitest';

import { GotenbergError } from './gotenberg.client';
import {
  failureKind,
  FAILED_RETRY_MS,
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

const address = { line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' };
const NOW = new Date('2026-11-09T06:00:00.000Z');
const TX = { marker: 'tx' } as unknown as DbTransaction;

const candidate = (n: number): RenderCandidate => ({
  tenantId: 'tenant-1',
  organizationId: 'org-1',
  versionId: `00000000-0000-4000-8000-00000000000${n}`,
});

/** Rows of an approved version, as the store's `load` returns them. */
const source = (versionId: string): RenderSource => ({
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
  quotation: { number: 'QT-2082-0042' },
  customer: { legalName: 'Himal Traders Pvt. Ltd.', panVatNo: null, address },
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
  } = {},
) {
  const calls: string[] = [];
  const claimed = opts.claims ?? {};
  const store: RenderStore = {
    candidates: vi.fn((now: Date, limit: number) => {
      calls.push(`candidates(${now.toISOString()},${limit})`);
      return Promise.resolve(opts.candidates ?? []);
    }),
    claim: vi.fn((_tx: DbTransaction, c: RenderCandidate) => {
      calls.push(`claim:${c.versionId}`);
      return Promise.resolve(claimed[c.versionId] ?? true);
    }),
    load: vi.fn((_tx: DbTransaction, c: RenderCandidate) => {
      calls.push(`load:${c.versionId}`);
      return Promise.resolve(opts.missing === true ? undefined : source(c.versionId));
    }),
    markRendered: vi.fn((_tx: DbTransaction, c: RenderCandidate) => {
      calls.push(`rendered:${c.versionId}`);
      return Promise.resolve();
    }),
    markFailed: vi.fn((_tx: DbTransaction, c: RenderCandidate) => {
      calls.push(`failed:${c.versionId}`);
      return Promise.resolve();
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
    createGenerated: vi.fn((_tx: DbTransaction, owner: { ownerId: string }) => {
      calls.push(`create:${owner.ownerId}`);
      return Promise.resolve({ documentId: 'doc-1', versionId: 'docver-1' });
    }),
    receiveGenerated: vi.fn(() => {
      calls.push('receive');
      return Promise.resolve({} as never);
    }),
  };
  const htmlToPdf = vi.fn((html: string) => {
    calls.push(`pdf:${html.includes('QT-2082-0042') ? 'html' : 'empty'}`);
    return (opts.pdf ?? (() => Promise.resolve(PDF)))();
  });
  const settingValues = {
    'entity.pan_vat_no': '301234567',
    'entity.address': address,
    ...opts.settings,
  } as Record<string, unknown>;
  const settings = {
    get: vi.fn((_scope: TxScope, key: string) => Promise.resolve(settingValues[key])),
  };
  const sweeper = new QuotationRenderSweeper(
    store,
    runTx,
    documents,
    settings as never,
    { htmlToPdf },
    () => NOW,
  );
  return { sweeper, store, documents, htmlToPdf, calls, txs };
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
    });
    expect(calls.filter((x) => !x.startsWith('candidates'))).toEqual([
      `claim:${c.versionId}`,
      `load:${c.versionId}`,
      'pdf:html',
      `create:${c.versionId}`,
      'receive',
      `rendered:${c.versionId}`,
    ]);
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
  });
});

describe('the stale and retry windows', () => {
  it('re-takes an abandoned claim after 10 minutes and a failure after 5', () => {
    expect(PENDING_STALE_MS).toBe(10 * 60_000);
    expect(FAILED_RETRY_MS).toBe(5 * 60_000);
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
