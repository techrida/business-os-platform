import { QuotationDetailSchema, type QuotationDetail } from '@bos/contracts';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import QuotationDetailPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getQuotation: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/components/p2/quotations/api', () => ({ getQuotation: mocks.getQuotation }));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Open the revision drawer and render its portal inline for assertions on server-provided rows.
vi.mock('@radix-ui/react-dialog', async (importOriginal) => {
  const radix = await importOriginal<typeof import('@radix-ui/react-dialog')>();
  return {
    ...radix,
    Root: (props: ComponentProps<typeof radix.Root>) => <radix.Root {...props} defaultOpen />,
    Portal: ({ children }: ComponentProps<typeof radix.Portal>) => children,
  };
});

const ID = '11111111-1111-4111-8111-111111111111';
const V1 = '22222222-2222-4222-8222-222222222221';
const V2 = '22222222-2222-4222-8222-222222222222';
const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const WHEN = '2026-11-08T05:45:00.000Z';

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
    paymentTermId: null,
    paymentSchedule: [],
    discount: null,
    lines: [],
    taxSummary: [],
    totals: {
      subtotal: '2500000.00',
      discountAmount: '0.00',
      taxableAmount: '2500000.00',
      taxAmount: '325000.00',
      total: '2825000.00',
      effectiveDiscountPct: '0',
    },
    internalCostTotal: null,
    marginPct: null,
    nprSnapshot: null,
    approvalRequestId: null,
    snapshotSha256: null,
    renderedDocumentId: null,
    renderedSha256: null,
    renderedScanStatus: null,
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

function detail(over: Record<string, unknown> = {}): QuotationDetail {
  return QuotationDetailSchema.parse({
    quotation: {
      id: ID,
      number: 'QT-2082-0042',
      customerId: CUSTOMER,
      opportunityId: CUSTOMER,
      currentVersionId: V2,
      ownerUserId: null,
      status: 'sent',
      version: 3,
      createdAt: WHEN,
      updatedAt: WHEN,
    },
    versions: [
      version({ id: V1, revisionNo: 1, status: 'superseded', supersededByVersionId: V2 }),
      version({
        id: V2,
        revisionNo: 2,
        status: 'sent',
        supersedesVersionId: V1,
        revisionReason: 'Customer asked for a smaller scope',
        totals: {
          subtotal: '2000000.00',
          discountAmount: '0.00',
          taxableAmount: '2000000.00',
          taxAmount: '260000.00',
          total: '2260000.00',
          effectiveDiscountPct: '0',
        },
        renderedDocumentId: '44444444-4444-4444-8444-444444444444',
        renderedScanStatus: 'clean',
      }),
    ],
    statusHistory: [
      {
        versionId: V1,
        fromStatus: null,
        toStatus: 'draft',
        actorId: null,
        reason: null,
        at: WHEN,
      },
    ],
    customerName: 'Big Kahuna Burger Ltd.',
    contacts: [],
    ...over,
  });
}

async function render(id: string = ID): Promise<string> {
  return renderToStaticMarkup(await QuotationDetailPage({ params: Promise.resolve({ id }) }));
}

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 'tok' });
  mocks.getQuotation.mockReset().mockResolvedValue(detail());
  mocks.notFound.mockClear();
});

describe('quotation detail page', () => {
  it('shows the number, the customer, the status and the server totals in lakh grouping', async () => {
    const html = await render();
    expect(html).toContain('QT-2082-0042');
    expect(html).toContain('Big Kahuna Burger Ltd.');
    expect(html).toContain('Sent');
    // Rev 2 is current: its total is shown, not Rev 1's.
    expect(html).toContain('22,60,000');
    expect(html).toContain('Rev 2 of 2');
  });

  it('lists the superseded revision in the dialog, with its own total', async () => {
    const html = await render();
    expect(html).toContain('Superseded');
    expect(html).toContain('28,25,000');
    expect(html).toContain('All revisions (2)');
  });

  it('offers the PDF link only for the clean revision, words for the other', async () => {
    const html = await render();
    expect(html).toContain(`href="/quotations/${ID}/versions/${V2}/document"`);
    expect(html).not.toContain(`/versions/${V1}/document`);
    expect(html).toContain('Not available');
  });

  it('offers no link at all while the file is still being scanned', async () => {
    const d = detail();
    const current = d.versions.find((v) => v.id === V2);
    mocks.getQuotation.mockResolvedValue({
      ...d,
      versions: d.versions.map((v) =>
        v === current ? { ...v, renderedScanStatus: 'quarantined' as const } : v,
      ),
    });
    const html = await render();
    expect(html).toContain('Being scanned');
    expect(html).not.toContain('/document"');
  });

  it('puts the actions of the current status in the action slot', async () => {
    // The fixture is Sent: record the outcome, or revise. Send is for an approved quotation.
    const html = await render();
    expect(html).toMatch(/<div class="[^"]*actions[^"]*"><button[^>]*>Record outcome<\/button>/);
    expect(html).toContain('>Revise</button>');
    expect(html).not.toContain('>Send to customer</button>');
  });

  it('answers a 404 with notFound, and a non-UUID id without calling the API', async () => {
    mocks.getQuotation.mockRejectedValue(new ApiError(404, 'missing'));
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    mocks.getQuotation.mockClear();
    await expect(render('not-an-id')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.getQuotation).not.toHaveBeenCalled();
  });

  it('shows the no-access state for a 403, without a retry link', async () => {
    mocks.getQuotation.mockRejectedValue(new ApiError(403, 'no'));
    const html = await render();
    expect(html).toContain('Your roles do not include quotations');
    expect(html).not.toContain('Try again');
  });

  it('shows an error with a way to retry for any other failure', async () => {
    mocks.getQuotation.mockRejectedValue(new ApiError(502, 'bad'));
    const html = await render();
    expect(html).toContain('This quotation did not load');
    expect(html).toContain('Try again');
  });

  it('keeps the page and the history when the current revision is missing', async () => {
    const d = detail();
    mocks.getQuotation.mockResolvedValue({ ...d, versions: d.versions.filter((v) => v.id !== V2) });
    const html = await render();
    expect(html).toContain('The current revision is missing');
    expect(html).toContain('Status history');
    expect(html).not.toContain('Totals');
  });

  it('keeps a very long customer name as wrapping text', async () => {
    const name = 'Customer '.repeat(80).trim();
    mocks.getQuotation.mockResolvedValue(detail({ customerName: name }));
    expect(await render()).toContain(name);
  });
});
