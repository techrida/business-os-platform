// The quotation detail page offers Retry on a failed PDF only to a viewer who may send: the API's retry route requires
// `quotation.send`, so a reader without it (management reads every quotation but sends none) would only meet a 403.
// The page is rendered for real; only its data sources and the PDF viewer (which draws in the browser) are faked.
// Run with: pnpm --filter @bos/workspace exec vitest run 'src/app/(app)/quotations/[id]/pdf-retry.test.tsx'
import { QuotationDetailSchema, type QuotationDetail } from '@bos/contracts';
import type { ComponentProps, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuotationDetailPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getQuotation: vi.fn(),
  listSalesOrders: vi.fn(),
  listPaymentTerms: vi.fn(),
}));

vi.mock('@/lib/api-billing', () => ({ listSalesOrders: mocks.listSalesOrders }));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/components/p2/quotations/api', () => ({ getQuotation: mocks.getQuotation }));
vi.mock('@/components/p2/quote-builder/api', () => ({ listPaymentTerms: mocks.listPaymentTerms }));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Open the revision drawer and render its portal inline, so the PDF of every revision row is in the markup too.
vi.mock('@radix-ui/react-dialog', async (importOriginal) => {
  const radix = await importOriginal<typeof import('@radix-ui/react-dialog')>();
  return {
    ...radix,
    Root: (props: ComponentProps<typeof radix.Root>) => <radix.Root {...props} defaultOpen />,
    Portal: ({ children }: ComponentProps<typeof radix.Portal>) => children,
  };
});

// The viewer dialog draws PDF pages in the browser. The page only needs its trigger and the URLs it is handed.
vi.mock('@/components/ui/file-preview-dialog', () => ({
  DownloadIcon: () => null,
  FilePreviewDialog: ({ trigger, retryUrl }: { trigger: ReactNode; retryUrl?: string | undefined }) => (
    <span data-pdf-viewer="" data-retry-url={retryUrl}>
      {trigger}
    </span>
  ),
}));

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
    termsAndConditions: null,
    paymentTermId: null,
    paymentSchedule: [],
    discount: null,
    lines: [],
    taxSummary: [],
    totals: {
      subtotal: '2000000.00',
      discountAmount: '0.00',
      taxableAmount: '2000000.00',
      taxAmount: '260000.00',
      total: '2260000.00',
      effectiveDiscountPct: '0',
    },
    internalCostTotal: null,
    marginPct: null,
    nprSnapshot: null,
    approvalRequestId: null,
    snapshotSha256: null,
    renderedDocumentId: '44444444-4444-4444-8444-444444444444',
    renderedSha256: null,
    renderedScanStatus: 'clean',
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
      status: 'sent',
      version: 3,
      createdAt: WHEN,
      updatedAt: WHEN,
    },
    versions: [
      version({ id: V1, revisionNo: 1, status: 'superseded', supersededByVersionId: V2 }),
      version({ id: V2, revisionNo: 2, status: 'sent', supersedesVersionId: V1 }),
    ],
    statusHistory: [],
    customerName: 'Big Kahuna Burger Ltd.',
    contacts: [],
    capabilities: { canEdit: false, canRevise: false },
  });
}

async function renderAs(roles: string[]): Promise<string> {
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 'tok', roles });
  return renderToStaticMarkup(await QuotationDetailPage({ params: Promise.resolve({ id: ID }) }));
}

beforeEach(() => {
  mocks.requireStaffSession.mockReset();
  mocks.getQuotation.mockReset().mockResolvedValue(detail());
  mocks.listSalesOrders.mockReset().mockResolvedValue([]);
  mocks.listPaymentTerms.mockReset().mockResolvedValue([]);
});

describe('quotation detail page: PDF Retry follows quotation.send', () => {
  it('hands the retry route to every PDF viewer for a role that may send (sales)', async () => {
    const html = await renderAs(['sales']);
    expect(html).toContain(`data-retry-url="/quotations/${ID}/versions/${V2}/document/retry"`);
    expect(html).toContain(`data-retry-url="/quotations/${ID}/versions/${V1}/document/retry"`);
  });

  it('shows the PDF but no Retry to a role that reads quotations without sending them (management)', async () => {
    const html = await renderAs(['management']);
    expect(html).toContain('data-pdf-viewer');
    expect(html).toContain('View PDF');
    expect(html).not.toContain('data-retry-url');
    expect(html).not.toContain('/document/retry');
  });

  it('offers Retry when any one of the roles may send', async () => {
    const html = await renderAs(['management', 'sales']);
    expect(html).toContain(`data-retry-url="/quotations/${ID}/versions/${V2}/document/retry"`);
  });
});
