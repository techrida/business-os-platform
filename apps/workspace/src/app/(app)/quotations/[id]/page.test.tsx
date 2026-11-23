import {
  QuotationDetailSchema,
  type QuotationDetail,
  type QuotationEvidenceDto,
  type QuotationVersionDto,
} from '@bos/contracts';
import type { ComponentProps, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PAYMENT_TERM_ID,
  version as contentsVersion,
} from '@/components/p2/quotations/contents.fixture';
import { ApiError } from '@/lib/api';
import { __resetEnvForTests } from '@/lib/env';

import QuotationDetailPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getQuotation: vi.fn(),
  getEvidence: vi.fn(),
  listSalesOrders: vi.fn(),
  listPaymentTerms: vi.fn(),
  getOpportunity: vi.fn(),
  refresh: vi.fn(),
  seen: [] as { component: string; version: QuotationVersionDto }[],
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  getSession: vi.fn(),
  apiFetch: vi.fn(),
  getMe: vi.fn(),
}));

vi.mock('@/lib/api-billing', () => ({ listSalesOrders: mocks.listSalesOrders }));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/components/p2/quotations/api', () => ({
  getQuotation: mocks.getQuotation,
  getEvidence: mocks.getEvidence,
}));
vi.mock('@/components/p2/quote-builder/api', () => ({
  listPaymentTerms: mocks.listPaymentTerms,
  getOpportunity: mocks.getOpportunity,
}));
// `PreparingRefresh` (the words for a PDF on its way) reads the router.
vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
  redirect: vi.fn(),
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// The tenant's display settings come through the real `getDisplaySettings` read; only the session
// and the HTTP call under it are stubbed. No session (the default) means the default settings.
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  getSession: mocks.getSession,
}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
  getMe: mocks.getMe,
}));

// Open the revision drawer and render its portal inline for assertions on server-provided rows.
vi.mock('@radix-ui/react-dialog', async (importOriginal) => {
  const radix = await importOriginal<typeof import('@radix-ui/react-dialog')>();
  return {
    ...radix,
    Root: (props: ComponentProps<typeof radix.Root>) => <radix.Root {...props} defaultOpen />,
    Portal: ({ children }: ComponentProps<typeof radix.Portal>) => children,
  };
});

// Record the version each component is handed: the page passes the API's answer on as it is (D29: the API, not
// the page, leaves out what the viewer may not see), so no component can be handed a figure the API withheld.
vi.mock('@/components/p2/quotations/contents', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/p2/quotations/contents')>();
  return {
    QuotationContents: (props: ComponentProps<typeof real.QuotationContents>) => {
      mocks.seen.push({ component: 'QuotationContents', version: props.version });
      return real.QuotationContents(props);
    },
  };
});
vi.mock('@/components/p2/quotations/detail-actions', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/p2/quotations/detail-actions')>();
  return {
    hasDetailActions: real.hasDetailActions,
    DetailActions: (props: ComponentProps<typeof real.DetailActions>) => {
      mocks.seen.push({ component: 'DetailActions', version: props.current });
      return real.DetailActions(props);
    },
  };
});

// The viewer dialog draws PDF pages in the browser (it reads `window` once open, which the forced-open dialog
// above would reach). The page only needs its trigger, and the URL it would fetch once opened.
vi.mock('@/components/ui/file-preview-dialog', () => ({
  DownloadIcon: () => null,
  FilePreviewDialog: ({
    trigger,
    previewUrl,
    downloadUrl,
    retryUrl,
  }: {
    trigger: ReactNode;
    previewUrl: string;
    downloadUrl: string;
    retryUrl?: string | undefined;
  }) => (
    <span data-preview-url={previewUrl} data-download-url={downloadUrl} data-retry-url={retryUrl}>
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
    capabilities: { canEdit: false, canRevise: true },
    ...over,
  });
}

async function render(id: string = ID, rev?: string | string[]): Promise<string> {
  return renderToStaticMarkup(
    await QuotationDetailPage({
      params: Promise.resolve({ id }),
      ...(rev !== undefined ? { searchParams: Promise.resolve({ rev }) } : {}),
    }),
  );
}

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 'tok', roles: ['sales'] });
  mocks.getQuotation.mockReset().mockResolvedValue(detail());
  mocks.getEvidence.mockReset().mockResolvedValue(null);
  mocks.notFound.mockClear();
  mocks.listSalesOrders.mockReset().mockResolvedValue([]);
  mocks.listPaymentTerms.mockReset().mockResolvedValue([]);
  // A denied read is the common case for roles without CRM access: the plain link stays.
  mocks.getOpportunity.mockReset().mockRejectedValue(new ApiError(403, 'no'));
  mocks.refresh.mockReset();
  mocks.seen.length = 0;
  mocks.getSession.mockReset().mockResolvedValue(null);
  mocks.apiFetch.mockReset().mockRejectedValue(new Error('no API in this test'));
  mocks.getMe.mockReset().mockRejectedValue(new Error('offline'));
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

  it('links to the visible live order for the accepted revision', async () => {
    const quote = detail();
    quote.quotation.status = 'accepted';
    quote.versions[1]!.status = 'accepted';
    mocks.getQuotation.mockResolvedValue(quote);
    mocks.listSalesOrders.mockResolvedValue([
      { id: CUSTOMER, number: 'SO-0042', status: 'confirmed' },
    ]);

    expect(await render()).toContain(`href="/sales-orders/${CUSTOMER}"`);
    expect(mocks.listSalesOrders).toHaveBeenCalledWith(expect.anything(), {
      quotationVersionId: V2,
    });

    mocks.listSalesOrders.mockResolvedValue([]);
    expect(await render()).not.toContain('href="/sales-orders/');
  });

  const pendingEvidence: QuotationEvidenceDto = {
    quotationId: CUSTOMER,
    versionId: V2,
    status: 'pending',
    policy: 'both',
    missing: ['purchase_order'],
    acceptance: {
      actorKind: 'customer_user',
      decidedOn: '2026-11-20',
      acceptedByName: 'Jules',
      evidenceKinds: ['contract'],
      evidenceDocumentIds: [],
    },
    confirmation: null,
    can: { confirm: true },
  };

  it('shows a portal acceptance awaiting confirmation, with Confirm evidence, then confirmed (F1-Q28)', async () => {
    const quote = detail();
    quote.quotation.status = 'accepted';
    quote.versions[1]!.status = 'accepted';
    mocks.getQuotation.mockResolvedValue(quote);
    mocks.getEvidence.mockResolvedValue(pendingEvidence);
    const awaiting = await render();
    expect(mocks.getEvidence).toHaveBeenCalledWith(expect.anything(), quote.quotation.id, V2);
    expect(awaiting).toContain('After acceptance');
    expect(awaiting).toContain('Awaiting confirmation');
    expect(awaiting).toContain('confirms a contract and a purchase order before the sales order');
    expect(awaiting).toContain('>Confirm evidence</button>');
    expect(awaiting).toContain('Confirm acceptance evidence for revision 2');
    expect(awaiting).toContain('Your company asks for a contract and a purchase order.');

    mocks.getQuotation.mockResolvedValue({
      ...quote,
      people: [{ userId: CUSTOMER, name: 'Asha Accountant' }],
    });
    mocks.getEvidence.mockResolvedValue({
      ...pendingEvidence,
      status: 'confirmed',
      missing: [],
      confirmation: {
        evidenceKinds: ['contract', 'purchase_order'],
        comment: null,
        confirmedBy: CUSTOMER,
        confirmedAt: WHEN,
      },
      can: { confirm: false },
    });
    const confirmed = await render();
    expect(confirmed).toContain('Confirmed');
    expect(confirmed).toContain('Contract, Purchase order by Asha Accountant on');
    expect(confirmed).not.toContain('>Confirm evidence</button>');
  });

  it('offers no Confirm evidence when the API says the caller may not, and no evidence row without an answer', async () => {
    const quote = detail();
    quote.quotation.status = 'accepted';
    quote.versions[1]!.status = 'accepted';
    mocks.getQuotation.mockResolvedValue(quote);
    mocks.getEvidence.mockResolvedValue({ ...pendingEvidence, can: { confirm: false } });
    const denied = await render();
    expect(denied).toContain('Awaiting confirmation');
    expect(denied).not.toContain('>Confirm evidence</button>');

    mocks.getEvidence.mockResolvedValue(null);
    expect(await render()).not.toContain('Customer evidence');
  });

  it('says a staff-recorded acceptance was checked when it was recorded', async () => {
    const quote = detail();
    quote.quotation.status = 'accepted';
    quote.versions[1]!.status = 'accepted';
    mocks.getQuotation.mockResolvedValue(quote);
    mocks.getEvidence.mockResolvedValue({
      ...pendingEvidence,
      status: 'confirmed',
      acceptance: { ...pendingEvidence.acceptance, actorKind: 'staff' },
      can: { confirm: false },
    });
    const html = await render();
    expect(html).toContain('Checked when the acceptance was recorded.');
    expect(html).not.toContain('Awaiting confirmation');
  });

  it('offers Cancel quotation on a submitted quotation when the API says canCancel (F1-Q27)', async () => {
    const quote = detail();
    quote.quotation.status = 'submitted';
    quote.versions[1]!.status = 'submitted';
    mocks.getQuotation.mockResolvedValue({
      ...quote,
      capabilities: { ...quote.capabilities, canCancel: true },
    });
    const html = await render();
    // Revision 2 of the fixture: cancelling it discards the revision and gives the earlier one back (R6D).
    expect(html).toContain('>Discard revision</button>');
    expect(html).toContain('Cancel revision 2 of');
    expect(html).toContain('Cancelling discards this revision and its approval request');

    mocks.getQuotation.mockResolvedValue(quote);
    expect(await render()).not.toContain('>Discard revision</button>');
  });

  it('asks for no evidence on a quotation that is not accepted', async () => {
    mocks.getQuotation.mockResolvedValue(detail());
    await render();
    expect(mocks.getEvidence).not.toHaveBeenCalled();
  });

  it('links the sales order once, in the After acceptance panel, not again in Linked records', async () => {
    const quote = detail();
    quote.quotation.status = 'accepted';
    quote.versions[1]!.status = 'accepted';
    mocks.getQuotation.mockResolvedValue(quote);
    mocks.listSalesOrders.mockResolvedValue([
      { id: CUSTOMER, number: 'SO-2082-0007', status: 'confirmed' },
    ]);
    const html = await render();
    expect(html.split(`href="/sales-orders/${CUSTOMER}"`).length - 1).toBe(1);
    const linked = /Linked records(.*?)<\/ul>/s.exec(html)?.[1] ?? '';
    expect(linked).not.toContain('/sales-orders/');
  });

  it('shows the draft sales order created from the accepted revision, waiting for Accounts (F1-Q25)', async () => {
    const quote = detail();
    quote.quotation.status = 'accepted';
    quote.versions[1]!.status = 'accepted';
    mocks.getQuotation.mockResolvedValue(quote);
    mocks.listSalesOrders.mockResolvedValue([
      { id: CUSTOMER, number: 'SO-2082-0007', status: 'draft' },
    ]);
    const html = await render();
    const panel = html.slice(html.indexOf('After acceptance'));
    expect(panel).toContain(`href="/sales-orders/${CUSTOMER}"`);
    expect(panel).toContain('SO-2082-0007');
    expect(panel).toContain('Draft');
    expect(panel).toContain('Accounts confirms it before billing starts.');

    mocks.listSalesOrders.mockResolvedValue([]);
    expect(await render()).toContain('Not created yet');
  });

  it('lists the superseded revision in the dialog, with its own total', async () => {
    const html = await render();
    expect(html).toContain('Superseded');
    expect(html).toContain('28,25,000');
    expect(html).toContain('All revisions (2)');
  });

  it('offers the PDF link only for the clean revision, words for the other', async () => {
    const html = await render();
    // Download stays in the app (R4c2): the viewer and its Download button get the route, no anchor does.
    expect(html).toContain(`data-download-url="/quotations/${ID}/versions/${V2}/document"`);
    expect(html).not.toContain(`href="/quotations/${ID}/versions/${V2}/document"`);
    expect(html).not.toContain(`/versions/${V1}/document`);
    expect(html).toContain('Not available');
  });

  it('opens the PDF in the viewer: a View PDF button and no request while rendering', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const html = await render();
      expect(html).toContain('View PDF');
      expect(html).not.toContain('Download PDF');
      expect(html).toContain(
        `data-preview-url="/quotations/${ID}/versions/${V2}/document/preview" data-download-url="/quotations/${ID}/versions/${V2}/document"`,
      );
      // Staff can ask for a PDF that failed to prepare to be made again.
      expect(html).toContain(`data-retry-url="/quotations/${ID}/versions/${V2}/document/retry"`);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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
    expect(html).toContain('Preparing PDF');
    expect(html).not.toContain('/document"');
    expect(html).not.toContain('View PDF');
  });

  it('puts the actions of the current status in the action slot', async () => {
    // The fixture is Sent: record the outcome, or revise. Send is for an approved quotation.
    const html = await render();
    const header = html.slice(0, html.indexOf('<section'));
    expect(header).toContain('>Record outcome</button>');
    expect(header).toContain('>Revise</button>');
    expect(html).not.toContain('Record client decision');
    expect(html).not.toContain('>Send to customer</button>');
  });

  it('hides Send while the opportunity is On Hold and says why on the page', async () => {
    const approved = detail({
      capabilities: { canEdit: false, canRevise: true, canSend: true, canRecordOutcome: true },
    });
    approved.quotation.status = 'approved';
    approved.versions[1]!.status = 'approved';
    mocks.getQuotation.mockResolvedValue(approved);
    mocks.getOpportunity.mockResolvedValue({
      number: 'DEAL-2026-0095',
      stage: 'on_hold',
      wonQuotationVersionId: null,
    });
    const html = await render();
    expect(html).not.toContain('>Send to customer</button>');
    expect(html).toContain('>Revise</button>');
    expect(html).toContain(
      'This quotation cannot be sent while its opportunity is On Hold. Resume the opportunity first.',
    );

    // Back in Negotiation the API would send it, so the button returns and the notice goes.
    mocks.getOpportunity.mockResolvedValue({
      number: 'DEAL-2026-0095',
      stage: 'negotiation',
      wonQuotationVersionId: null,
    });
    const negotiating = await render();
    expect(negotiating).toContain('>Send to customer</button>');
    expect(negotiating).not.toContain('cannot be sent while');
  });

  it('offers only Rejected while the opportunity is On Hold, and names the revision the outcome is for', async () => {
    mocks.getQuotation.mockResolvedValue(
      detail({
        capabilities: { canEdit: false, canRevise: true, canSend: true, canRecordOutcome: true },
      }),
    );
    mocks.getOpportunity.mockResolvedValue({
      number: 'DEAL-2026-0095',
      stage: 'on_hold',
      wonQuotationVersionId: null,
    });
    const html = await render();
    expect(html).toContain('>Record outcome</button>');
    expect(html).toContain('Record outcome for revision 2');
    expect(html).toContain(
      'This quotation cannot be recorded as accepted while its opportunity is On Hold.',
    );
    expect(html).toContain('value="rejected"');
    expect(html).not.toContain('value="accepted"');
  });

  it('holds nothing back when the opportunity cannot be read: the API decides', async () => {
    const approved = detail({
      capabilities: { canEdit: false, canRevise: true, canSend: true, canRecordOutcome: true },
    });
    approved.quotation.status = 'approved';
    approved.versions[1]!.status = 'approved';
    mocks.getQuotation.mockResolvedValue(approved);
    const html = await render();
    expect(html).toContain('>Send to customer</button>');
    expect(html).not.toContain('cannot be sent while');
  });

  it('hides Send to customer and Record outcome when live grants or server capabilities withhold them', async () => {
    mocks.getMe.mockResolvedValue({
      permissions: [{ permission: 'quotation.read', scope: 'all' }],
    });
    const sentHtml = await render();
    expect(sentHtml).not.toContain('>Record outcome</button>');
    expect(sentHtml).toContain('>Revise</button>');

    const approved = detail({ capabilities: { canEdit: false, canRevise: true, canSend: false } });
    approved.quotation.status = 'approved';
    approved.versions[1]!.status = 'approved';
    mocks.getQuotation.mockResolvedValue(approved);
    mocks.getMe.mockRejectedValue(new Error('offline'));
    const approvedHtml = await render();
    expect(approvedHtml).not.toContain('>Send to customer</button>');
    expect(approvedHtml).toContain('>Revise</button>');

    mocks.getMe.mockResolvedValue({
      permissions: [{ permission: 'quotation.read', scope: 'all' }],
    });
    mocks.getQuotation.mockResolvedValue(
      detail({
        capabilities: { canEdit: false, canRevise: false, canSend: false, canRecordOutcome: false },
      }),
    );
    const readOnlyHtml = await render();
    const h1Start = readOnlyHtml.indexOf('<h1');
    const bodyStart = readOnlyHtml.indexOf('<section', h1Start);
    expect(h1Start).toBeGreaterThan(-1);
    expect(bodyStart).toBeGreaterThan(h1Start);
    const header = readOnlyHtml.slice(h1Start, bodyStart);
    expect(header).not.toContain('<button');
    expect(header).not.toMatch(/class="[^"]*actions/);
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

/** The env the API client validates before any fetch; without it no request would reach the stub. */
function stubApiEnv() {
  for (const [k, v] of Object.entries({
    API_INTERNAL_URL: 'http://api:3001',
    OIDC_ISSUER: 'https://auth.test',
    OIDC_CLIENT_ID: 'client-123',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
    OIDC_AUDIENCE: 'proj-42',
    WORKSPACE_PUBLIC_URL: 'https://app.test',
    VALKEY_URL: 'redis://valkey.test:6379',
    SESSION_ENC_KEY: Buffer.alloc(32, 5).toString('base64'),
  })) {
    vi.stubEnv(k, v);
  }
  __resetEnvForTests();
}

describe('quotation detail page: names come with the quotation', () => {
  const OWNER = '66666666-6666-4666-8666-666666666666';

  it('names the owner from the quotation itself and calls no admin endpoint', async () => {
    // Every fetch the page makes passes here (getQuotation itself is mocked above). The admin directory answers
    // 403 to Sales and Accountants, as the API does.
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: 'forbidden', message: 'Forbidden', correlationId: 'c' },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    stubApiEnv();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const d = detail();
      mocks.getQuotation.mockResolvedValue({
        ...d,
        quotation: { ...d.quotation, ownerUserId: OWNER },
        people: [{ userId: OWNER, name: 'Ram Thapa' }],
      });
      const html = await render();
      const admin = fetchMock.mock.calls
        .map(([url]) => new URL(url as URL | string).pathname)
        .filter((path) => path.startsWith('/v1/admin/'));
      expect(admin).toEqual([]);
      expect(html).toContain('Ram Thapa');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  // An owner who is none of the history actors, so only the owner fact can show their name.
  const AUTHOR = '77777777-7777-4777-8777-777777777777';
  const APPROVER = '88888888-8888-4888-8888-888888888888';
  const STRAY = '99999999-9999-4999-8999-999999999999';
  function namedDetail(ownerUserId: string | null, people: { userId: string; name: string }[]) {
    const d = detail();
    return {
      ...d,
      quotation: { ...d.quotation, ownerUserId },
      statusHistory: [
        { ...d.statusHistory[0]!, actorId: AUTHOR },
        { ...d.statusHistory[0]!, fromStatus: 'draft', toStatus: 'submitted', actorId: AUTHOR },
        {
          ...d.statusHistory[0]!,
          fromStatus: 'submitted',
          toStatus: 'approved',
          actorId: APPROVER,
        },
      ],
      people,
    } satisfies QuotationDetail;
  }

  it('names an owner who never acted and every history actor, and nobody it does not refer to', async () => {
    mocks.getQuotation.mockResolvedValue(
      namedDetail(OWNER, [
        { userId: OWNER, name: 'Ram Thapa' },
        { userId: AUTHOR, name: 'Sita Gurung' },
        { userId: APPROVER, name: 'Mina Rai' },
        { userId: STRAY, name: 'Stray Person' },
      ]),
    );
    const html = await render();
    expect(html).toMatch(/>Owner<\/dt><dd[^>]*><span>Ram Thapa<\/span>/);
    expect(html).toContain('Sita Gurung');
    expect(html).toContain('Mina Rai');
    expect(html).not.toContain('Stray Person');
    expect(html).not.toContain('name unavailable');
  });

  it('says the owner name is unavailable when the quotation omits it, not another name', async () => {
    mocks.getQuotation.mockResolvedValue(
      namedDetail(OWNER, [
        { userId: AUTHOR, name: 'Sita Gurung' },
        { userId: APPROVER, name: 'Mina Rai' },
      ]),
    );
    const html = await render();
    expect(html).toContain('Owner name unavailable');
    expect(html).not.toContain('Person name unavailable');
  });

  it('shows an unset owner as Unassigned and still names the history actors', async () => {
    mocks.getQuotation.mockResolvedValue(
      namedDetail(null, [
        { userId: AUTHOR, name: 'Sita Gurung' },
        { userId: APPROVER, name: 'Mina Rai' },
      ]),
    );
    const html = await render();
    expect(html).toContain('Unassigned');
    expect(html).toContain('Sita Gurung');
    expect(html).toContain('Mina Rai');
    expect(html).not.toContain('name unavailable');
  });
});

const CONTENTS_V1 = contentsVersion({
  id: V1,
  revisionNo: 1,
  status: 'superseded',
  scope: 'Scope of the first revision',
  supersededByVersionId: V2,
});
const CONTENTS_V2 = contentsVersion({
  id: V2,
  revisionNo: 2,
  status: 'sent',
  scope: 'Scope of the second revision',
  paymentTermId: PAYMENT_TERM_ID,
  supersedesVersionId: V1,
});

function withContents() {
  const d = detail();
  return { ...d, versions: [CONTENTS_V1, CONTENTS_V2] } satisfies QuotationDetail;
}

describe('quotation detail page: contents', () => {
  it('shows the contents of the current revision, with its payment term by name', async () => {
    mocks.getQuotation.mockResolvedValue(withContents());
    mocks.listPaymentTerms.mockResolvedValue([{ id: PAYMENT_TERM_ID, label: 'Net 30 days' }]);
    const html = await render();
    expect(html).toContain('Contents');
    expect(html).toContain('Line items');
    expect(html).toContain('Site survey');
    expect(html).toContain('Scope of the second revision');
    expect(html).not.toContain('Scope of the first revision');
    expect(html).toContain('Net 30 days');
    expect(html).not.toContain('Back to current revision');
  });

  it('asks for the payment terms only when the revision has one, and survives a failed lookup', async () => {
    mocks.getQuotation.mockResolvedValue(detail());
    await render();
    expect(mocks.listPaymentTerms).not.toHaveBeenCalled();

    mocks.getQuotation.mockResolvedValue(withContents());
    mocks.listPaymentTerms.mockRejectedValue(new ApiError(502, 'bad'));
    const html = await render();
    expect(mocks.listPaymentTerms).toHaveBeenCalledTimes(1);
    expect(html).toContain('Scope of the second revision');
    expect(html).not.toContain('Net 30 days');
  });
});

describe('quotation detail page: a selected revision', () => {
  beforeEach(() => {
    mocks.getQuotation.mockResolvedValue(withContents());
  });

  it.each([
    ['its id', V1],
    ['its number', '1'],
  ])('shows an earlier revision named by %s, with a way back', async (_name, rev) => {
    const html = await render(ID, rev);
    expect(html).toContain('Rev 1 of 2');
    expect(html).toContain('Revision 1 contents');
    expect(html).toContain('Scope of the first revision');
    expect(html).not.toContain('Scope of the second revision');
    expect(html).toContain(`href="/quotations/${ID}"`);
    expect(html).toContain('Back to current revision');
  });

  it('keeps the header, the sales-order lookup and the actions on the current revision', async () => {
    const html = await render(ID, V1);
    expect(html).toMatch(/headerFact[^>]*>Revision 2</);
    expect(html).toContain('>Revise</button>');
  });

  it('takes the PDF fact from the selected revision', async () => {
    const d = withContents();
    d.versions = [
      {
        ...CONTENTS_V1,
        renderedDocumentId: '44444444-4444-4444-8444-444444444441',
        renderedScanStatus: 'clean',
      },
      CONTENTS_V2,
    ];
    mocks.getQuotation.mockResolvedValue(d);
    const html = await render(ID, V1);
    expect(html).toContain(`data-download-url="/quotations/${ID}/versions/${V1}/document"`);
    expect(html).toContain('View PDF');
  });

  it.each([
    ['unknown number', '99'],
    ['zero', '0'],
    ['not a number', 'abc'],
    ['an id of no revision', '99999999-9999-4999-8999-999999999999'],
    ['repeated', [V1, V2]],
    ['the current revision itself', V2],
  ])('shows the current revision for %s', async (_name, rev) => {
    const html = await render(ID, rev);
    expect(html).toContain('Rev 2 of 2');
    expect(html).toContain('Scope of the second revision');
    expect(html).not.toContain('Back to current revision');
    expect(html).not.toContain('contents</span>');
  });

  it('links every row of the revision list to its page, and the current one to the bare path', async () => {
    const html = await render();
    expect(html).toMatch(new RegExp(`<a [^>]*href="/quotations/${ID}\\?rev=${V1}"[^>]*>Rev 1</a>`));
    expect(html).toMatch(new RegExp(`<a [^>]*href="/quotations/${ID}"[^>]*>Rev 2</a>`));
  });
});

function withoutCost(v: QuotationVersionDto): QuotationVersionDto {
  const { internalCostTotal: _total, marginPct: _margin, ...rest } = v;
  return { ...rest, lines: v.lines.map(({ unitCost: _cost, ...line }) => line) };
}

describe('quotation detail page: internal figures (D29)', () => {
  it('shows what the API sent, whatever the roles of the session', async () => {
    // No role decision on the page any more: the API already applied the viewer's live grants.
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 'tok', roles: ['warehouse'] });
    mocks.getQuotation.mockResolvedValue(withContents());
    const html = await render();
    expect(html).toContain('Unit cost');
    expect(html).toContain('NPR 800.25');
    expect(html).toContain('NPR 2,231.40');
    expect(html).toContain('35.32%');
  });

  it('leaves cost and margin out of the page when the API left them out, for any revision', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 'tok', roles: ['sales'] });
    const d = withContents();
    mocks.getQuotation.mockResolvedValue({ ...d, versions: d.versions.map(withoutCost) });
    for (const rev of [undefined, V1]) {
      const html = await render(ID, rev);
      expect(html).toContain('Site survey');
      expect(html).not.toContain('Unit cost');
      expect(html).not.toContain('800.25');
      expect(html).not.toContain('2,231.40');
      expect(html).not.toContain('35.32%');
      expect(html).not.toContain('Margin');
    }
  });

  it('hands every component the version exactly as the API served it', async () => {
    const d = withContents();
    mocks.getQuotation.mockResolvedValue(d);
    await render();
    const contents = mocks.seen.find((s) => s.component === 'QuotationContents');
    expect(contents?.version).toBe(d.versions[1]);
    expect(contents?.version.internalCostTotal).toBe('2231.40');
    expect(contents?.version.lines[0]?.unitCost).toBe('800.25');
  });
});

describe('quotation detail page: linked records', () => {
  const LEAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  /** The hrefs of the Linked records card, in order. */
  function linked(html: string): string[] {
    const card = /Linked records(.*?)<\/ul>/s.exec(html)?.[1] ?? '';
    return [...card.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
  }

  it('shows the lead first, as a link to its CRM page, then the opportunity', async () => {
    mocks.getOpportunity.mockResolvedValue({ number: 'DEAL-2026-0095', stage: 'proposal_sent' });
    mocks.getQuotation.mockResolvedValue({
      ...detail(),
      lead: { id: LEAD, name: 'Kathmandu <expo> lead' },
    });
    const html = await render();
    expect(linked(html)).toEqual([
      `/customers/${CUSTOMER}`,
      `/leads/${LEAD}`,
      `/opportunities/${CUSTOMER}`,
    ]);
    expect(html).toContain('Kathmandu &lt;expo&gt; lead');
  });

  it('names the opportunity by its number and stage when the viewer may read it', async () => {
    mocks.getOpportunity.mockResolvedValue({ number: 'DEAL-2026-0095', stage: 'proposal_sent' });
    const html = await render();
    expect(mocks.getOpportunity).toHaveBeenCalledWith(expect.anything(), CUSTOMER);
    expect(html).toContain('DEAL-2026-0095');
    expect(html).toContain('Proposal Sent');
    expect(html).not.toContain('View opportunity');
    expect(linked(html)).toContain(`/opportunities/${CUSTOMER}`);
  });

  it('leaves the opportunity link out when the opportunity cannot be read, since it would open a 404', async () => {
    const html = await render();
    expect(html).not.toContain('View opportunity');
    expect(linked(html)).not.toContain(`/opportunities/${CUSTOMER}`);
  });

  it.each([['no lead, or one the viewer may not read (absent)', {}]])(
    'shows no lead row for %s',
    async (_name, over) => {
      mocks.getQuotation.mockResolvedValue(detail(over));
      mocks.getOpportunity.mockResolvedValue({ number: 'DEAL-2026-0095', stage: 'proposal_sent' });
      const html = await render();
      expect(linked(html)).toEqual([`/customers/${CUSTOMER}`, `/opportunities/${CUSTOMER}`]);
      expect(html).not.toContain('/leads/');
    },
  );
});

describe("quotation detail page: the tenant's date format", () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({ accessToken: 'tok', roles: ['sales'] });
    // A fresh body on every call: the settings may be read more than once in a test.
    mocks.apiFetch.mockImplementation((_session: unknown, path: string) =>
      path === '/v1/settings/display'
        ? Response.json({
            numberSystems: { NPR: 'south_asian', INR: 'south_asian', USD: 'international' },
            dateFormat: 'dd/MM/yyyy',
          })
        : Response.json({ error: 'unexpected' }, { status: 500 }),
    );
    const base = detail();
    mocks.getQuotation.mockResolvedValue({
      ...base,
      versions: base.versions.map((v) =>
        // 20:00 UTC on the 9th is 01:45 on the 10th in Kathmandu.
        v.id === V2 ? { ...v, updatedAt: '2026-11-09T20:00:00.000Z' } : v,
      ),
    });
  });

  it('writes the issue date, valid-until, last changed and the history in that pattern', async () => {
    const html = await render();
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/settings/display',
      undefined,
    );
    expect(html).toMatch(/<time dateTime="2026-11-08">08\/11\/2026<\/time>/);
    expect(html).toMatch(/<time dateTime="2026-11-23">23\/11\/2026<\/time>/);
    expect(html).toContain('Last changed 10/11/2026, 01:45');
    expect(html).toContain(`<time dateTime="${WHEN}">08/11/2026, 11:30</time>`);
    // The contents card writes its dates the same way.
    expect(html).toMatch(/Issue date<\/dt><dd[^>]*>08\/11\/2026</);
    // No date is left in the default wording.
    expect(html).not.toMatch(/\d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}/);
  });

  it('keeps the default wording when the settings read fails', async () => {
    mocks.apiFetch.mockRejectedValue(new Error('network down'));
    const html = await render();
    expect(html).toMatch(/<time dateTime="2026-11-08">08 Nov 2026<\/time>/);
    expect(html).toContain('Last changed 10 Nov 2026, 01:45');
  });
});
