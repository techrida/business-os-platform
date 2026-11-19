// Unit tests of PortalService with fakes for the caller, the store, documents and settings. They pin the portal's
// visibility rules: only a customer principal with a party gets past the door (403 before any query), only
// customer-visible versions are listed or shown (anything else, and anything the store does not return, is a
// 404), the list shows the newest customer-visible version of each quotation (never a draft), and nothing in the
// JSON is named like an internal field. The SQL scoping itself is the drizzle store's job; the integration test
// covers it against a real database.
import { CUSTOMER_VIEW_FORBIDDEN_WORDS } from '@bos/contracts';
import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import { PortalService } from './portal.service';
import type { PortalQuotationStore, PortalVersionHead, PortalViewSource } from './portal.store';

const TENANT = '0a000000-0000-4000-8000-000000000001';
const ENTITY = '0a000000-0000-4000-8000-000000000002';
const PARTY = '0a000000-0000-4000-8000-000000000003';
const OTHER_PARTY = '0a000000-0000-4000-8000-000000000004';
const DOC = '0a000000-0000-4000-8000-000000000005';
const address = { line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' };

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
    customer: { legalName: 'Himal Traders Pvt. Ltd.', panVatNo: 'ABC-12345', address },
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
  };
}

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
              renderedDocumentId: s.rendered === true ? DOC : null,
            },
      );
    }),
  };
  return store;
}

function setup(
  seeds: Seed[],
  opts: { caller?: Principal; docStatus?: string; address?: unknown } = {},
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
    get: vi.fn((_scope: unknown, key: string) =>
      Promise.resolve(
        key === 'entity.address' ? ('address' in opts ? opts.address : address) : '301234567',
      ),
    ),
  };
  const service = new PortalService(caller, store, documents as never, settings as never);
  return { service, store, documents };
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
      },
      { versionId: vid(7), quotationId: qid(6), number: 'QT-6', revisionNo: 2, status: 'sent' },
      // Revised, new draft not sent yet: the last sent version (now superseded) shows, never the draft.
      {
        versionId: vid(8),
        quotationId: qid(7),
        number: 'QT-7',
        revisionNo: 1,
        status: 'superseded',
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
    expect(view.issuer).toEqual({
      legalName: 'Techrida Pvt. Ltd.',
      panVatNo: '301234567',
      address,
    });
    const json = JSON.stringify(view);
    const words = keyWords(JSON.parse(json));
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

  it('after a revise with the new draft unsent, shows the last sent version and 404s the draft', async () => {
    const { service } = setup([
      {
        versionId: vid(8),
        quotationId: qid(7),
        number: 'QT-7',
        revisionNo: 1,
        status: 'superseded',
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

  it('answers 404 when nothing is rendered, or the rendered document is not clean', async () => {
    const notRendered = setup([SENT]);
    await expect(notRendered.service.quotationPdfLink(SENT.versionId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(notRendered.documents.issueLinkForOwner).not.toHaveBeenCalled();
    for (const status of ['quarantined', 'scanning', 'infected', 'failed', 'rejected']) {
      const { service, documents } = setup([RENDERED], { docStatus: status });
      await expect(service.quotationPdfLink(SENT.versionId), status).rejects.toBeInstanceOf(
        NotFoundException,
      );
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
