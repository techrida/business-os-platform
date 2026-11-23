// Unit tests of PortalService with fakes for the caller, the store, documents and settings. They pin the portal's
// visibility rules: only a customer principal with a party gets past the door (403 before any query), only
// customer-visible versions are listed or shown (anything else, and anything the store does not return, is a
// 404), the list shows the newest customer-visible version of each quotation (never a draft), and nothing in the
// JSON is named like an internal field. The SQL scoping itself is the drizzle store's job; the integration test
// covers it against a real database.
import {
  CUSTOMER_VIEW_FORBIDDEN_WORDS,
  CustomerQuotationViewSchema,
  DEFAULT_DOCUMENT_STYLE,
  EMPTY_SNAPSHOT_COMPANY_PROFILE,
  PortalDisplaySchema,
  type PortalDisplay,
} from '@bos/contracts';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import { PortalService } from './portal.service';
import type { PortalQuotationStore, PortalVersionHead, PortalViewSource } from './portal.store';

const TENANT = '0a000000-0000-4000-8000-000000000001';
const ENTITY = '0a000000-0000-4000-8000-000000000002';
const PARTY = '0a000000-0000-4000-8000-000000000003';
const OTHER_PARTY = '0a000000-0000-4000-8000-000000000004';
const DOC = '0a000000-0000-4000-8000-000000000005';
/** The entity address setting (`entity.address`): the lines, city and country together. */
const address = { line: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' } as const;

const vid = (n: number) => `1b000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const qid = (n: number) => `2c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function principalOf(over: Partial<Principal> = {}): Principal {
  return {
    userId: '0a000000-0000-4000-8000-000000000009',
    zitadelUserId: 'zitadel-sub-1',
    tenantId: TENANT,
    organizationId: ENTITY,
    orgKind: 'customer',
    partyId: PARTY,
    idpOrgId: '0a000000-0000-4000-8000-00000000000a',
    roles: ['customer_user'],
    departmentId: null,
    status: 'active',
    grants: new Map([['portal.quotation.read', 'customer_org']]),
    ...over,
  };
}

type Status = PortalVersionHead['status'];

interface Seed {
  versionId: string;
  quotationId: string;
  number: string;
  revisionNo: number;
  status: Status;
  rejectionSource?: 'customer' | 'internal' | null;
  partyId?: string;
  rendered?: boolean;
  /** The version's stored document_style; absent means never rendered (null). */
  documentStyle?: unknown;
  /** On an accepted seed: staff have confirmed the portal acceptance's evidence (F1-Q28). */
  evidenceConfirmed?: boolean;
  /** When it was sent; absent means sent for a status only a sent version reaches, never sent otherwise. */
  sentAt?: Date | null;
  /** The quotation's newest version is cancelled (a Lost deal). */
  quotationCancelled?: boolean;
}

/** A whole internal source; internal columns ride along so a leak shows up in the output. */
function sourceOf(s: Seed): PortalViewSource {
  return {
    version: {
      id: s.versionId,
      revisionNo: s.revisionNo,
      status: s.status,
      rejectionSource: s.rejectionSource ?? null,
      currency: 'USD',
      issueDate: '2026-11-08',
      validUntil: '2026-11-23',
      scope: 'Supply and install 12 panels',
      assumptions: null,
      exclusions: null,
      termsAndConditions: null,
      deliveryTimeline: '6 weeks',
      paymentSchedule: [{ label: 'Advance', percent: '60' }],
      subtotal: '540000.00',
      discountAmount: '0.00',
      taxableAmount: '540000.00',
      taxAmount: '70200.00',
      total: '610200.00',
      renderState: s.rendered === true ? 'rendered' : 'none',
      renderedDocumentId: s.rendered === true ? DOC : null,
      renderedSha256: s.rendered === true ? Buffer.alloc(32, 7) : null,
      fxRate: '133.500000',
      amountNpr: '81463700.00',
      internalCostTotal: '400000.00',
      marginPct: '25.9259',
    } as PortalViewSource['version'],
    quotation: { number: s.number },
    customer: {
      legalName: 'Himal Traders Pvt. Ltd.',
      panVatNo: 'ABC-12345',
      country: 'NP',
      addressLine: address.line,
      addressCity: address.city,
    },
    contact: { fullName: 'Sita Rai', emailNorm: 'sita@himal.example' },
    paymentTerm: { name: 'Net 30' },
    lines: [
      {
        lineNo: 1,
        description: 'Solar panel 550W',
        uom: 'pcs',
        quantity: '12.0000',
        unitPrice: '45000.00',
        gross: '540000.00',
        unitCost: '30000.00',
      } as PortalViewSource['lines'][number],
    ],
    taxSummary: [{ label: 'VAT', rate: '13.0000', base: '540000.00', tax: '70200.00' }],
    issuerLegalName: 'Techrida Pvt. Ltd.',
    documentStyle: s.documentStyle ?? null,
    renderAttempts: 0,
    quotationCancelled: s.quotationCancelled ?? false,
    sentAt:
      s.sentAt !== undefined
        ? s.sentAt
        : ['sent', 'accepted', 'expired'].includes(s.status) || s.rejectionSource === 'customer'
          ? new Date('2026-11-08T10:00:00Z')
          : null,
  };
}

/** The live settings in these tests: unlike the defaults on purpose, so a test can tell live from default. */
const LIVE: PortalDisplay = {
  numberSystems: { NPR: 'south_asian', INR: 'south_asian', USD: 'south_asian' },
  dateFormat: 'yyyy-MM-dd',
};

/** The saved `currency.enabled` in these tests: INR switched off, so a test can tell it from the default. */
const LIVE_CURRENCIES = ['NPR', 'USD'];

/** A stored document_style as the render job freezes it, with the given number and date fields. */
const snapshotWith = (fields: Record<string, unknown>) => ({
  style: DEFAULT_DOCUMENT_STYLE,
  profile: EMPTY_SNAPSHOT_COMPANY_PROFILE,
  capturedAt: '2026-11-08T10:00:00.000Z',
  ...fields,
});

/** Mimics the drizzle store's scope: rows of the caller's tenant, acting entity and party only. */
function fakeStore(seeds: Seed[]) {
  const mine = (p: Principal) => seeds.filter((s) => (s.partyId ?? PARTY) === p.partyId);
  const store: PortalQuotationStore = {
    listVersions: vi.fn((p: Principal) =>
      Promise.resolve(
        mine(p).map((s): PortalVersionHead => ({
          versionId: s.versionId,
          quotationId: s.quotationId,
          number: s.number,
          revisionNo: s.revisionNo,
          status: s.status,
          rejectionSource: s.rejectionSource ?? null,
          issueDate: '2026-11-08',
          validUntil: '2026-11-23',
          currency: 'USD',
          total: '610200.00',
          sentAt: sourceOf(s).sentAt,
          quotationCancelled: s.quotationCancelled ?? false,
        })),
      ),
    ),
    loadView: vi.fn((p: Principal, versionId: string) => {
      const s = mine(p).find((x) => x.versionId === versionId);
      return Promise.resolve(s === undefined ? undefined : sourceOf(s));
    }),
    // The row's own tenant and entity, not the caller's: the service must scope the link by these.
    loadDocumentHead: vi.fn((p: Principal, versionId: string) => {
      const s = mine(p).find((x) => x.versionId === versionId);
      return Promise.resolve(
        s === undefined
          ? undefined
          : {
              tenantId: TENANT,
              organizationId: ENTITY,
              status: s.status,
              rejectionSource: s.rejectionSource ?? null,
              renderState: s.rendered === true ? ('rendered' as const) : ('none' as const),
              renderAttempts: 0,
              renderedDocumentId: s.rendered === true ? DOC : null,
              sentAt: sourceOf(s).sentAt,
              quotationCancelled: s.quotationCancelled ?? false,
            },
      );
    }),
    // F1-Q28: an accepted seed was accepted in the portal with a signed quote, unless it says otherwise.
    loadAcceptance: vi.fn((p: Principal, versionId: string) => {
      const s = mine(p).find((x) => x.versionId === versionId && x.status === 'accepted');
      return Promise.resolve(
        s === undefined
          ? undefined
          : {
              actorKind: 'customer_user' as const,
              evidenceKinds: ['signed_quote' as const],
              confirmed: s.evidenceConfirmed === true,
            },
      );
    }),
  };
  return store;
}

function setup(
  seeds: Seed[],
  opts: {
    caller?: Principal;
    docStatus?: string;
    address?: unknown;
    live?: { numberSystems?: unknown; dateFormat?: unknown; enabledCurrencies?: unknown };
    evidencePolicy?: string;
  } = {},
) {
  const store = fakeStore(seeds);
  const caller = { current: () => opts.caller ?? principalOf() };
  const documents = {
    listForOwner: vi.fn(() =>
      Promise.resolve([{ documentId: DOC, version: 1, status: opts.docStatus ?? 'clean' }]),
    ),
    issueLinkForOwner: vi.fn(() =>
      Promise.resolve({ url: '/v1/files/tok.en', expiresAt: 'later' }),
    ),
  };
  const settings = {
    get: vi.fn((_scope: unknown, key: string): Promise<unknown> => {
      if (key === 'entity.address')
        return Promise.resolve('address' in opts ? opts.address : address);
      if (key === 'format.number_systems') {
        return Promise.resolve(
          opts.live && 'numberSystems' in opts.live ? opts.live.numberSystems : LIVE.numberSystems,
        );
      }
      if (key === 'format.date') {
        return Promise.resolve(
          opts.live && 'dateFormat' in opts.live ? opts.live.dateFormat : LIVE.dateFormat,
        );
      }
      if (key === 'currency.enabled') {
        return Promise.resolve(
          opts.live && 'enabledCurrencies' in opts.live
            ? opts.live.enabledCurrencies
            : LIVE_CURRENCIES,
        );
      }
      if (key === 'sales.evidence_policy') {
        return Promise.resolve(opts.evidencePolicy ?? 'signed_quote');
      }
      return Promise.resolve('301234567');
    }),
  };
  const service = new PortalService(caller, store, documents as never, settings as never);
  const formatReads = () =>
    settings.get.mock.calls.filter(
      ([, key]) => key === 'format.number_systems' || key === 'format.date',
    );
  return { service, store, documents, settings, formatReads };
}

/** Every key of a JSON value, split into lower-case words (camelCase and snake_case). */
function keyWords(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keyWords(v, out));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(
        ...k
          .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
          .toLowerCase()
          .split('_'),
      );
      keyWords(v, out);
    }
  }
  return out;
}

const SENT: Seed = {
  versionId: vid(1),
  quotationId: qid(1),
  number: 'QT-1',
  revisionNo: 1,
  status: 'sent',
};

describe('PortalService: who may call', () => {
  const refused: [string, Partial<Principal>][] = [
    [
      'a staff founder (portal grants at all)',
      { orgKind: 'staff', partyId: null, grants: new Map([['portal.quotation.read', 'all']]) },
    ],
    ['a staff user who somehow has a party', { orgKind: 'staff' }],
    ['a vendor', { orgKind: 'vendor' }],
    ['a customer with no party', { partyId: null }],
    ['a customer with an empty party', { partyId: '' }],
  ];

  for (const [name, over] of refused) {
    it(`answers 403 to ${name}, before any query`, async () => {
      const { service, store, documents } = setup([SENT], { caller: principalOf(over) });
      await expect(service.list()).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.get(SENT.versionId)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.quotationPdfLink(SENT.versionId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(store.listVersions).not.toHaveBeenCalled();
      expect(store.loadView).not.toHaveBeenCalled();
      expect(store.loadDocumentHead).not.toHaveBeenCalled();
      expect(documents.listForOwner).not.toHaveBeenCalled();
      expect(documents.issueLinkForOwner).not.toHaveBeenCalled();
    });
  }
});

describe('PortalService.list', () => {
  it('lists the newest customer-visible version of each quotation, never a draft or an internal rejection', async () => {
    const { service } = setup([
      SENT,
      // Draft only: invisible.
      { versionId: vid(2), quotationId: qid(2), number: 'QT-2', revisionNo: 1, status: 'draft' },
      // Approved but never sent: invisible.
      { versionId: vid(3), quotationId: qid(3), number: 'QT-3', revisionNo: 1, status: 'approved' },
      // Rejected internally: invisible.
      {
        versionId: vid(4),
        quotationId: qid(4),
        number: 'QT-4',
        revisionNo: 1,
        status: 'rejected',
        rejectionSource: 'internal',
      },
      // Rejected by the customer: visible.
      {
        versionId: vid(5),
        quotationId: qid(5),
        number: 'QT-5',
        revisionNo: 1,
        status: 'rejected',
        rejectionSource: 'customer',
      },
      // Revised and re-sent: only R2 shows.
      {
        versionId: vid(6),
        quotationId: qid(6),
        number: 'QT-6',
        revisionNo: 1,
        status: 'superseded',
        sentAt: new Date('2026-11-08T10:00:00Z'),
      },
      { versionId: vid(7), quotationId: qid(6), number: 'QT-6', revisionNo: 2, status: 'sent' },
      // Revised, new draft not sent yet: the last sent version (now superseded) shows, never the draft.
      {
        versionId: vid(8),
        quotationId: qid(7),
        number: 'QT-7',
        revisionNo: 1,
        status: 'superseded',
        sentAt: new Date('2026-11-08T10:00:00Z'),
      },
      { versionId: vid(9), quotationId: qid(7), number: 'QT-7', revisionNo: 2, status: 'draft' },
      // Another customer's quotation: the store never returns it.
      {
        versionId: vid(10),
        quotationId: qid(8),
        number: 'QT-8',
        revisionNo: 1,
        status: 'sent',
        partyId: OTHER_PARTY,
      },
    ]);
    const items = await service.list();
    const byNumber = Object.fromEntries(items.map((i) => [i.number, i]));
    expect(Object.keys(byNumber).sort()).toEqual(['QT-1', 'QT-5', 'QT-6', 'QT-7']);
    expect(byNumber['QT-6']).toMatchObject({ id: vid(7), revisionNo: 2, status: 'sent' });
    expect(byNumber['QT-7']).toMatchObject({ id: vid(8), revisionNo: 1, status: 'superseded' });
    expect(byNumber['QT-5']).toMatchObject({ id: vid(5), status: 'rejected' });
    expect(byNumber['QT-1']).toEqual({
      id: vid(1),
      number: 'QT-1',
      revisionNo: 1,
      status: 'sent',
      issueDate: '2026-11-08',
      validUntil: '2026-11-23',
      currency: 'USD',
      total: '610200.00',
    });
  });

  it('names no field with a forbidden word', async () => {
    const { service } = setup([SENT]);
    const words = keyWords(JSON.parse(JSON.stringify(await service.list())));
    for (const word of CUSTOMER_VIEW_FORBIDDEN_WORDS) expect(words).not.toContain(word);
  });
});

describe('PortalService.get', () => {
  it('shows a sent version as the customer view, with no internal field in the JSON', async () => {
    const { service } = setup([SENT]);
    const view = await service.get(SENT.versionId);
    expect(view).toMatchObject({ id: vid(1), number: 'QT-1', status: 'sent', file: null });
    // The view's party block keeps the country beside the street lines and city.
    expect(view.issuer).toEqual({
      legalName: 'Techrida Pvt. Ltd.',
      panVatNo: '301234567',
      country: 'NP',
      address: { line: address.line, city: address.city },
    });
    const json = JSON.stringify(view);
    // `display` is left out of the scan: its NPR/INR/USD keys are currency codes for formatting, not an NPR equivalent.
    const { display: _display, ...scanned } = JSON.parse(json) as Record<string, unknown>;
    const words = keyWords(scanned);
    for (const word of CUSTOMER_VIEW_FORBIDDEN_WORDS) expect(words).not.toContain(word);
    // The internal values the source carried never reach the JSON.
    for (const secret of ['133.5', '81463700', '400000', '25.9259', '30000.00']) {
      expect(json).not.toContain(secret);
    }
  });

  it('answers 404 for a draft, an unsent approval and an internal rejection, as for a foreign or unknown id', async () => {
    const { service } = setup([
      { versionId: vid(2), quotationId: qid(2), number: 'QT-2', revisionNo: 1, status: 'draft' },
      { versionId: vid(3), quotationId: qid(3), number: 'QT-3', revisionNo: 1, status: 'approved' },
      {
        versionId: vid(4),
        quotationId: qid(4),
        number: 'QT-4',
        revisionNo: 1,
        status: 'rejected',
        rejectionSource: 'internal',
      },
      {
        versionId: vid(5),
        quotationId: qid(5),
        number: 'QT-5',
        revisionNo: 1,
        status: 'submitted',
      },
      {
        versionId: vid(6),
        quotationId: qid(6),
        number: 'QT-6',
        revisionNo: 1,
        status: 'cancelled',
      },
      {
        versionId: vid(10),
        quotationId: qid(8),
        number: 'QT-8',
        revisionNo: 1,
        status: 'sent',
        partyId: OTHER_PARTY,
      },
    ]);
    for (const id of [vid(2), vid(3), vid(4), vid(5), vid(6), vid(10), vid(99)]) {
      await expect(service.get(id), id).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('answers 409 quotation_closed for a cancelled version the customer was sent, before any document lookup', async () => {
    const { service, documents } = setup([
      {
        versionId: vid(6),
        quotationId: qid(6),
        number: 'QT-6',
        revisionNo: 1,
        status: 'cancelled',
        rendered: true,
        sentAt: new Date('2026-11-08T10:00:00Z'),
      },
    ]);
    const error = await service.get(vid(6)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      code: 'quotation_closed',
      message: 'This quotation is no longer open',
    });
    expect(documents.listForOwner).not.toHaveBeenCalled();
  });

  it('answers 404 for a cancelled version that was never sent, and for a sent-then-cancelled one of another party', async () => {
    const { service } = setup([
      {
        versionId: vid(6),
        quotationId: qid(6),
        number: 'QT-6',
        revisionNo: 1,
        status: 'cancelled',
        sentAt: null,
      },
      {
        versionId: vid(10),
        quotationId: qid(8),
        number: 'QT-8',
        revisionNo: 1,
        status: 'cancelled',
        partyId: OTHER_PARTY,
        sentAt: new Date('2026-11-08T10:00:00Z'),
      },
    ]);
    for (const id of [vid(6), vid(10)]) {
      await expect(service.get(id), id).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('answers 409 quotation_closed for a mailed superseded version whose quotation was then cancelled (R6D)', async () => {
    const sent = new Date('2026-11-08T10:00:00Z');
    const { service } = setup([
      {
        versionId: vid(8),
        quotationId: qid(7),
        number: 'QT-7',
        revisionNo: 1,
        status: 'superseded',
        sentAt: sent,
        quotationCancelled: true,
      },
      {
        versionId: vid(11),
        quotationId: qid(9),
        number: 'QT-9',
        revisionNo: 1,
        status: 'superseded',
        sentAt: sent,
        quotationCancelled: false,
      },
    ]);
    const error = await service.get(vid(8)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'quotation_closed' });
    // A revision still open keeps showing the superseded page.
    await expect(service.get(vid(11))).resolves.toMatchObject({ status: 'superseded' });
  });

  it('never shows a version that was never sent, whatever it was replaced or expired into (R6D)', async () => {
    const sent = new Date('2026-11-08T10:00:00Z');
    const { service, store } = setup([
      // Approved, never sent, then revised: superseded with no sent_at.
      {
        versionId: vid(8),
        quotationId: qid(7),
        number: 'QT-7',
        revisionNo: 1,
        status: 'superseded',
        sentAt: null,
        rendered: true,
      },
      { versionId: vid(9), quotationId: qid(7), number: 'QT-7', revisionNo: 2, status: 'draft' },
      // Approved, never sent, then ran out.
      {
        versionId: vid(10),
        quotationId: qid(8),
        number: 'QT-8',
        revisionNo: 1,
        status: 'expired',
        sentAt: null,
        rendered: true,
      },
      // The same statuses after a send stay visible.
      {
        versionId: vid(11),
        quotationId: qid(9),
        number: 'QT-9',
        revisionNo: 1,
        status: 'superseded',
        sentAt: sent,
        rendered: true,
      },
      {
        versionId: vid(12),
        quotationId: qid(10),
        number: 'QT-10',
        revisionNo: 1,
        status: 'expired',
        sentAt: sent,
        rendered: true,
      },
    ]);
    expect((await service.list()).map((i) => i.number).sort()).toEqual(['QT-10', 'QT-9']);
    for (const id of [vid(8), vid(10)]) {
      await expect(service.get(id), id).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.quotationPdfLink(id), id).rejects.toBeInstanceOf(NotFoundException);
    }
    for (const id of [vid(11), vid(12)]) await expect(service.get(id)).resolves.toBeDefined();
    expect(store.loadDocumentHead).toHaveBeenCalled();
  });

  it('says closed everywhere for a sent, superseded version of a cancelled quotation: list, page and PDF (R6D)', async () => {
    const sent = new Date('2026-11-08T10:00:00Z');
    const { service } = setup([
      {
        versionId: vid(8),
        quotationId: qid(7),
        number: 'QT-7',
        revisionNo: 1,
        status: 'superseded',
        sentAt: sent,
        quotationCancelled: true,
        rendered: true,
      },
      {
        versionId: vid(9),
        quotationId: qid(8),
        number: 'QT-8',
        revisionNo: 1,
        status: 'cancelled',
        sentAt: sent,
        rendered: true,
      },
    ]);
    expect(await service.list()).toEqual([]);
    for (const id of [vid(8), vid(9)]) {
      for (const call of [() => service.get(id), () => service.quotationPdfLink(id)]) {
        const error = await call().catch((e: unknown) => e);
        expect(error, id).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'quotation_closed',
        });
      }
    }
  });

  it('after a revise with the new draft unsent, shows the last sent version and 404s the draft', async () => {
    const { service } = setup([
      {
        versionId: vid(8),
        quotationId: qid(7),
        number: 'QT-7',
        revisionNo: 1,
        status: 'superseded',
        sentAt: new Date('2026-11-08T10:00:00Z'),
      },
      { versionId: vid(9), quotationId: qid(7), number: 'QT-7', revisionNo: 2, status: 'draft' },
    ]);
    const [item] = await service.list();
    expect(item?.id).toBe(vid(8));
    await expect(service.get(vid(8))).resolves.toMatchObject({
      id: vid(8),
      revisionNo: 1,
      status: 'superseded',
    });
    await expect(service.get(vid(9))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('shows a customer rejection', async () => {
    const { service } = setup([
      {
        versionId: vid(5),
        quotationId: qid(5),
        number: 'QT-5',
        revisionNo: 1,
        status: 'rejected',
        rejectionSource: 'customer',
      },
    ]);
    await expect(service.get(vid(5))).resolves.toMatchObject({ status: 'rejected' });
  });

  it('includes the file only when the rendered document scanned clean', async () => {
    const rendered: Seed = { ...SENT, rendered: true };
    const clean = await setup([rendered]).service.get(SENT.versionId);
    expect(clean.file).toEqual({
      documentId: DOC,
      filename: 'QT-1-R1.pdf',
      sha256: Buffer.alloc(32, 7).toString('hex'),
    });
    for (const status of ['scanning', 'infected', 'failed', 'rejected']) {
      const view = await setup([rendered], { docStatus: status }).service.get(SENT.versionId);
      expect(view.file, status).toBeNull();
    }
  });

  it('does not look up documents for a version that is not customer-visible', async () => {
    const { service, documents } = setup([
      {
        versionId: vid(2),
        quotationId: qid(2),
        number: 'QT-2',
        revisionNo: 1,
        status: 'draft',
        rendered: true,
      },
    ]);
    await expect(service.get(vid(2))).rejects.toBeInstanceOf(NotFoundException);
    expect(documents.listForOwner).not.toHaveBeenCalled();
  });

  it('answers 503 issuer_incomplete, with no data, when the entity has no address', async () => {
    const { service } = setup([SENT], { address: null });
    const error = await service.get(SENT.versionId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      code: 'issuer_incomplete',
      message: 'This quotation cannot be shown right now',
    });
  });
});

describe('PortalService.get: after the customer accepted (F1-Q28)', () => {
  const ACCEPTED: Seed = { ...SENT, versionId: vid(7), status: 'accepted' };

  it('says the acceptance waits for staff and which documents the policy still needs', async () => {
    const { service } = setup([ACCEPTED], { evidencePolicy: 'both' });
    const view = CustomerQuotationViewSchema.parse(await service.get(ACCEPTED.versionId));
    expect(view.afterAcceptance).toEqual({
      status: 'pending',
      needs: ['contract', 'purchase_order'],
    });
  });

  it('needs nothing more under the signed-quote policy, and nothing once staff confirmed', async () => {
    const { service } = setup(
      [ACCEPTED, { ...ACCEPTED, versionId: vid(8), evidenceConfirmed: true }],
      {
        evidencePolicy: 'contract',
      },
    );
    expect((await service.get(vid(8))).afterAcceptance).toEqual({ status: 'confirmed', needs: [] });
    const { service: signedQuote } = setup([ACCEPTED]);
    expect((await signedQuote.get(ACCEPTED.versionId)).afterAcceptance).toEqual({
      status: 'pending',
      needs: [],
    });
  });

  it('leaves the field out of a version that is not accepted', async () => {
    const { service } = setup([SENT]);
    expect(await service.get(SENT.versionId)).not.toHaveProperty('afterAcceptance');
  });
});

describe('PortalService.get: the display it was sent with', () => {
  it('shows a frozen snapshot display even when the live settings differ, without reading them', async () => {
    const frozen = snapshotWith({
      numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'international' },
      dateFormat: 'dd/MM/yyyy',
    });
    const { service, formatReads } = setup([{ ...SENT, documentStyle: frozen }]);
    const view = await service.get(SENT.versionId);
    expect(view.display).toEqual({
      numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'international' },
      dateFormat: 'dd/MM/yyyy',
    });
    expect(formatReads()).toEqual([]);
  });

  it('reads a legacy snapshot (one number system, no date format) as that system for every currency', async () => {
    const legacy = snapshotWith({ numberSystem: 'international' });
    const { service, formatReads } = setup([{ ...SENT, documentStyle: legacy }]);
    const view = await service.get(SENT.versionId);
    expect(view.display).toEqual({
      numberSystems: { NPR: 'international', INR: 'international', USD: 'international' },
      // A snapshot taken before the date setting printed the default.
      dateFormat: 'dd MMM yyyy',
    });
    expect(formatReads()).toEqual([]);
  });

  it('falls back to the live settings of the selling entity when the version has no snapshot', async () => {
    const { service, settings } = setup([SENT]);
    const view = await service.get(SENT.versionId);
    expect(view.display).toEqual(LIVE);
    expect(settings.get).toHaveBeenCalledWith(
      { tenantId: TENANT, organizationId: ENTITY },
      'format.number_systems',
    );
    expect(settings.get).toHaveBeenCalledWith(
      { tenantId: TENANT, organizationId: ENTITY },
      'format.date',
    );
  });

  it('falls back to the live settings, never fails, when the stored snapshot does not validate', async () => {
    for (const bad of [
      { style: 'banded' },
      snapshotWith({}),
      snapshotWith({ numberSystems: { NPR: 'arabic', INR: 'south_asian', USD: 'international' } }),
      snapshotWith({ numberSystem: 'international', dateFormat: 'MM/dd/yyyy' }),
      'not an object',
    ]) {
      const view = await setup([{ ...SENT, documentStyle: bad }]).service.get(SENT.versionId);
      expect(view.display, JSON.stringify(bad)).toEqual(LIVE);
    }
  });

  it('shows the defaults when a live setting does not validate', async () => {
    const { service } = setup([SENT], {
      live: { numberSystems: 'international', dateFormat: 'MM/dd/yyyy' },
    });
    const view = await service.get(SENT.versionId);
    expect(view.display).toEqual({
      numberSystems: { NPR: 'south_asian', INR: 'south_asian', USD: 'international' },
      dateFormat: 'dd MMM yyyy',
    });
  });
});

describe('PortalService.display', () => {
  const VENDOR_PARTY = '0a000000-0000-4000-8000-00000000000b';

  const LIVE_WITH_CURRENCIES = { ...LIVE, enabledCurrencies: LIVE_CURRENCIES };

  it('answers a customer with the live settings of its acting entity, enabled currencies included', async () => {
    const { service, settings } = setup([SENT]);
    const display = await service.display();
    expect(display).toEqual(LIVE_WITH_CURRENCIES);
    expect(PortalDisplaySchema.safeParse(display).success).toBe(true);
    expect(settings.get).toHaveBeenCalledWith(
      { tenantId: TENANT, organizationId: ENTITY },
      'format.number_systems',
    );
    expect(settings.get).toHaveBeenCalledWith(
      { tenantId: TENANT, organizationId: ENTITY },
      'currency.enabled',
    );
  });

  it('answers a vendor with a party too, enabled currencies included', async () => {
    const { service } = setup([], {
      caller: principalOf({ orgKind: 'vendor', partyId: VENDOR_PARTY, grants: new Map() }),
    });
    await expect(service.display()).resolves.toEqual(LIVE_WITH_CURRENCIES);
  });

  it('never uses a version snapshot: it is the company setting now', async () => {
    const frozen = snapshotWith({ numberSystem: 'international', dateFormat: 'dd/MM/yyyy' });
    const { service } = setup([{ ...SENT, documentStyle: frozen }]);
    await expect(service.display()).resolves.toEqual(LIVE_WITH_CURRENCIES);
  });

  it('offers what the 422 check accepts: NPR first and always, then the known saved codes', async () => {
    const cases: [unknown, string[]][] = [
      [
        ['NPR', 'INR', 'USD'],
        ['NPR', 'INR', 'USD'],
      ],
      [['USD'], ['NPR', 'USD']],
      [
        ['USD', 'NPR', 'USD'],
        ['NPR', 'USD'],
      ],
      [
        ['NPR', 'EUR', 42, 'INR'],
        ['NPR', 'INR'],
      ],
      ['USD', ['NPR']],
      [null, ['NPR']],
    ];
    for (const [stored, offered] of cases) {
      const { service } = setup([SENT], { live: { enabledCurrencies: stored } });
      const display = await service.display();
      expect(display.enabledCurrencies, JSON.stringify(stored)).toEqual(offered);
      expect(PortalDisplaySchema.safeParse(display).success).toBe(true);
    }
  });

  it('keeps the enabled currencies out of a quotation view: only the display read carries them', async () => {
    const { service, settings } = setup([SENT]);
    const view = await service.get(SENT.versionId);
    expect(view.display).toEqual(LIVE);
    expect(view.display).not.toHaveProperty('enabledCurrencies');
    expect(settings.get).not.toHaveBeenCalledWith(expect.anything(), 'currency.enabled');
  });

  const refused: [string, Partial<Principal>][] = [
    [
      'a staff founder (portal grants at all)',
      { orgKind: 'staff', partyId: null, grants: new Map([['portal.quotation.read', 'all']]) },
    ],
    ['a staff user who somehow has a party', { orgKind: 'staff' }],
    ['a customer with no party', { partyId: null }],
    ['a vendor with no party', { orgKind: 'vendor', partyId: null }],
    ['a vendor with an empty party', { orgKind: 'vendor', partyId: '' }],
    ['an invited (not yet active) customer', { status: 'invited' }],
  ];
  for (const [name, over] of refused) {
    it(`answers 403 to ${name}, before reading settings`, async () => {
      const { service, settings } = setup([SENT], { caller: principalOf(over) });
      await expect(service.display()).rejects.toBeInstanceOf(ForbiddenException);
      expect(settings.get).not.toHaveBeenCalled();
    });
  }
});

describe('PortalService.quotationPdfLink', () => {
  const RENDERED: Seed = { ...SENT, rendered: true };

  it('issues the link for the version and its rendered document, in the quotation own tenant and entity', async () => {
    // The caller acts in another entity than the row: the scope must come from the row, never the caller.
    const caller = principalOf({ organizationId: '0a000000-0000-4000-8000-0000000000ff' });
    const { service, store, documents } = setup([RENDERED], { caller });
    const link = await service.quotationPdfLink(SENT.versionId);
    expect(link).toEqual({ url: '/v1/files/tok.en', expiresAt: 'later' });
    expect(store.loadDocumentHead).toHaveBeenCalledWith(caller, SENT.versionId);
    expect(documents.issueLinkForOwner).toHaveBeenCalledTimes(1);
    expect(documents.issueLinkForOwner).toHaveBeenCalledWith(
      { tenantId: TENANT, organizationId: ENTITY },
      { ownerType: 'quotation_version', ownerId: SENT.versionId },
      DOC,
    );
  });

  it('answers 404, without a link, for a version that is not customer-visible', async () => {
    for (const status of ['draft', 'submitted', 'approved'] as const) {
      const { service, documents } = setup([{ ...RENDERED, status }]);
      await expect(service.quotationPdfLink(SENT.versionId), status).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(documents.issueLinkForOwner, status).not.toHaveBeenCalled();
    }
    const internal = setup([{ ...RENDERED, status: 'rejected', rejectionSource: 'internal' }]);
    await expect(internal.service.quotationPdfLink(SENT.versionId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(internal.documents.issueLinkForOwner).not.toHaveBeenCalled();
  });

  it('answers 404 for another party or an unknown id, before any document lookup', async () => {
    const { service, documents } = setup([{ ...RENDERED, partyId: OTHER_PARTY }]);
    await expect(service.quotationPdfLink(SENT.versionId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.quotationPdfLink(vid(99))).rejects.toBeInstanceOf(NotFoundException);
    expect(documents.listForOwner).not.toHaveBeenCalled();
    expect(documents.issueLinkForOwner).not.toHaveBeenCalled();
  });

  it('answers 409 while the PDF is being prepared and 424 once it will not come, without a link', async () => {
    const statusOf = async (promise: Promise<unknown>) =>
      promise.then(
        () => 200,
        (error: unknown) => (error instanceof HttpException ? error.getStatus() : -1),
      );
    const notRendered = setup([SENT]);
    expect(await statusOf(notRendered.service.quotationPdfLink(SENT.versionId))).toBe(409);
    expect(notRendered.documents.issueLinkForOwner).not.toHaveBeenCalled();
    for (const [status, expected] of [
      ['awaiting_content', 409],
      ['quarantined', 409],
      ['infected', 424],
      ['scan_failed', 424],
      ['rejected', 424],
    ] as const) {
      const { service, documents } = setup([RENDERED], { docStatus: status });
      expect(await statusOf(service.quotationPdfLink(SENT.versionId)), status).toBe(expected);
      expect(documents.issueLinkForOwner, status).not.toHaveBeenCalled();
    }
  });

  it('passes the documents 404 through unchanged', async () => {
    const { service, documents } = setup([RENDERED]);
    documents.issueLinkForOwner.mockRejectedValueOnce(new NotFoundException('File not found'));
    await expect(service.quotationPdfLink(SENT.versionId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
