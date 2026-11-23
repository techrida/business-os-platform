import { QuotationDetailSchema, type QuotationDetail } from '@bos/contracts';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import EditQuotationPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
// The page asks what the user may do (to offer Create contact); every grant is on here.
vi.mock('@/lib/live-permissions', () => ({
  getPermissionCheck: () => Promise.resolve(() => true),
}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getQuotation: vi.fn(),
  builderProps: vi.fn(),
  // The display-settings read behind the real `loadEnabledCurrencies`.
  call: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
// The detail read: `GET /v1/quotations/:id` answers a QuotationDetail, not a bare QuotationDto.
vi.mock('@/components/p2/quotations/api', () => ({ getQuotation: mocks.getQuotation }));
vi.mock('@/components/p2/quote-builder/api', () => ({
  getCustomer: vi.fn(() => Promise.reject(new Error('not needed'))),
  getOpportunity: vi.fn(() => Promise.reject(new Error('not needed'))),
}));
vi.mock('@/lib/api-procurement', () => ({ call: mocks.call }));
vi.mock('@/components/p2/quote-builder/lookups', () => ({
  loadLookups: vi.fn(() => Promise.resolve({ contacts: [], taxCodes: [], paymentTerms: [] })),
}));
vi.mock('@/components/p2/quote-builder/quote-builder', () => ({
  QuoteBuilder: (props: unknown) => {
    mocks.builderProps(props);
    return <p>builder</p>;
  },
}));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound, redirect: vi.fn() }));

const ID = '11111111-1111-4111-8111-111111111111';
const V1 = '22222222-2222-4222-8222-222222222221';
const V2 = '22222222-2222-4222-8222-222222222222';
const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const TAX = '55555555-5555-4555-8555-555555555555';
const WHEN = '2026-11-08T05:45:00.000Z';

const totals = {
  subtotal: '100.00',
  discountAmount: '0.00',
  taxableAmount: '100.00',
  taxAmount: '13.00',
  total: '113.00',
  effectiveDiscountPct: '0',
};

function version(over: Record<string, unknown>) {
  return {
    id: V1,
    quotationId: ID,
    number: 'QT-2082-0042',
    revisionNo: 1,
    status: 'draft',
    rejectionSource: null,
    customerId: CUSTOMER,
    contactId: null,
    templateId: null,
    currency: 'NPR',
    issueDate: '2026-11-08',
    validUntil: '2026-11-23',
    scope: null,
    assumptions: null,
    exclusions: null,
    deliveryTimeline: null,
    termsAndConditions: null,
    paymentTermId: null,
    paymentSchedule: [],
    discount: null,
    lines: [
      {
        lineNo: 1,
        catalogItemId: null,
        description: 'Work',
        uom: 'lot',
        quantity: '1',
        unitPrice: '100',
        unitCost: null,
        taxCodeId: TAX,
        gross: '100.00',
        discountAlloc: '0.00',
        taxable: '100.00',
      },
    ],
    taxSummary: [],
    totals,
    internalCostTotal: null,
    marginPct: null,
    nprSnapshot: null,
    approvalRequestId: null,
    snapshotSha256: null,
    renderedDocumentId: null,
    renderedSha256: null,
    renderedScanStatus: null,
    renderFailed: false,
    supersedesVersionId: null,
    supersededByVersionId: null,
    revisionReason: null,
    cancelReason: null,
    submittedAt: null,
    approvedAt: null,
    sentAt: null,
    acceptedAt: null,
    rejectedAt: null,
    expiredAt: null,
    cancelledAt: null,
    version: 1,
    createdAt: WHEN,
    updatedAt: WHEN,
    ...over,
  };
}

function detail(): QuotationDetail {
  return QuotationDetailSchema.parse({
    quotation: {
      id: ID,
      number: 'QT-2082-0042',
      customerId: CUSTOMER,
      opportunityId: CUSTOMER,
      currentVersionId: V2,
      ownerUserId: null,
      status: 'returned',
      version: 3,
      createdAt: WHEN,
      updatedAt: WHEN,
    },
    versions: [
      version({ id: V1, status: 'superseded', supersededByVersionId: V2, scope: 'Old scope' }),
      version({
        id: V2,
        revisionNo: 2,
        status: 'returned',
        supersedesVersionId: V1,
        scope: 'Current scope',
        version: 5,
      }),
    ],
    statusHistory: [],
    customerName: 'Big Kahuna Burger Ltd.',
    contacts: [],
    capabilities: { canEdit: true, canRevise: false },
  });
}

async function render(): Promise<string> {
  const page = await EditQuotationPage({
    params: Promise.resolve({ id: ID }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(page);
}

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 'tok' });
  mocks.getQuotation.mockReset().mockResolvedValue(detail());
  mocks.builderProps.mockReset();
  mocks.call.mockReset().mockResolvedValue({ enabledCurrencies: ['NPR', 'INR', 'USD'] });
  mocks.notFound.mockClear();
});

describe('edit quotation page', () => {
  it('reads the detail and fills the builder from the current revision', async () => {
    await render();
    expect(mocks.getQuotation).toHaveBeenCalledWith(expect.anything(), ID);
    expect(mocks.builderProps).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'QT-2082-0042 Rev 2' }),
    );
    const props = mocks.builderProps.mock.calls[0]?.[0] as {
      target: { quotationId: string; versionId: string; expectedVersion: number };
      initial: { scope: string };
      idempotencyKey: string;
    };
    expect(props.target).toEqual({
      mode: 'edit',
      quotationId: ID,
      versionId: V2,
      expectedVersion: 5,
    });
    expect(props.initial.scope).toBe('Current scope');
    expect(props.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('shows the status as its label, not the stored lowercase value', async () => {
    await render();
    const props = mocks.builderProps.mock.calls[0]?.[0] as { status: ReactNode };
    const badge = renderToStaticMarkup(<>{props.status}</>);
    expect(badge).toContain('Returned');
    expect(badge).not.toContain('>returned<');
  });

  it('says the current revision is missing instead of editing another one', async () => {
    const d = detail();
    mocks.getQuotation.mockResolvedValue({ ...d, versions: d.versions.filter((v) => v.id !== V2) });
    const html = await render();
    expect(html).toContain('The current revision is missing');
    expect(mocks.builderProps).not.toHaveBeenCalled();
  });

  it('offers no editor for a Returned quotation the caller may not edit, and links back to it', async () => {
    mocks.getQuotation.mockResolvedValue({
      ...detail(),
      capabilities: { canEdit: false, canRevise: false },
    });
    const html = await render();
    expect(html).toContain('You can view this quotation but not edit it');
    expect(html).toContain('Returned');
    expect(html).not.toContain('>returned<');
    expect(html).toContain(`href="/quotations/${ID}"`);
    expect(mocks.builderProps).not.toHaveBeenCalled();
  });

  it('after a submit, promises no pull-back or recall: Cancel is the only way to end a quotation', async () => {
    const d = detail();
    mocks.getQuotation.mockResolvedValue({
      ...d,
      versions: d.versions.map((v) => (v.id === V2 ? { ...v, status: 'submitted' as const } : v)),
    });
    const page = await EditQuotationPage({
      params: Promise.resolve({ id: ID }),
      searchParams: Promise.resolve({ submitted: '1' }),
    });
    const html = renderToStaticMarkup(page);
    expect(html).toContain('Approval pending');
    expect(html).not.toMatch(/recall|pull it back/i);
    expect(html).toContain('If the approver returns it, you can change it and submit again.');
  });

  it('answers 404 for a quotation the API cannot find', async () => {
    mocks.getQuotation.mockRejectedValue(new ApiError(404, 'missing'));
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('edit quotation currencies (D44)', () => {
  it("hands the builder the enabled list and the revision's own currency, even if switched off", async () => {
    mocks.call.mockResolvedValue({ enabledCurrencies: ['NPR', 'INR'] });
    const d = detail();
    mocks.getQuotation.mockResolvedValue({
      ...d,
      versions: d.versions.map((v) => (v.id === V2 ? { ...v, currency: 'USD' } : v)),
    });
    await render();
    expect(mocks.call).toHaveBeenCalledTimes(1);
    const props = mocks.builderProps.mock.calls[0]?.[0] as {
      enabledCurrencies: string[];
      initial: { currency: string };
    };
    expect(props.enabledCurrencies).toEqual(['NPR', 'INR']);
    expect(props.initial.currency).toBe('USD');
  });
});
