import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from '@/lib/env';

import InboxPage from '../page';
import InboxDetailPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
  redirect: vi.fn(),
  // The inbox list's filter bar reads the URL on render.
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/inbox',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const RID = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const REQUESTER = '33333333-3333-4333-8333-333333333333';
const NAMED = '44444444-4444-4444-8444-444444444444';
const GROUP = '55555555-5555-4555-8555-555555555555';
const WHEN = '2026-11-17T05:45:00.000Z';

const request = {
  requestId: RID,
  documentType: 'test_memo',
  documentId: DOC,
  documentNumber: 'PR-2082-0007',
  status: 'pending',
  blockReason: null,
  currentSeq: 1,
  version: 1,
  requesterUserId: REQUESTER,
  snapshot: { title: 'Two laptops' },
  steps: [
    {
      seq: 1,
      kind: 'user',
      roleKey: null,
      groupId: null,
      userId: NAMED,
      reason: 'Accountant checks it',
      status: 'active',
      activatedAt: WHEN,
      decidedBy: null,
      decidedOnBehalfOf: null,
    },
    {
      seq: 2,
      kind: 'group',
      roleKey: null,
      groupId: GROUP,
      userId: null,
      reason: 'Treasury approves',
      status: 'waiting',
      activatedAt: null,
      decidedBy: null,
      decidedOnBehalfOf: null,
      groupName: 'Treasury desk',
    },
  ],
  actions: [
    {
      action: 'submit',
      actorUserId: REQUESTER,
      onBehalfOfUserId: null,
      comment: null,
      createdAt: WHEN,
    },
  ],
  submittedAt: WHEN,
  decidedAt: null,
  people: [
    { userId: REQUESTER, name: 'Ram Thapa' },
    { userId: NAMED, name: 'Mina Rai' },
  ],
};

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

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const defaultFetch = ((input) => {
  const path = new URL(input as URL | string).pathname;
  if (path === `/v1/approvals/requests/${RID}`) return Promise.resolve(json(200, request));
  if (path === '/v1/approvals/inbox') return Promise.resolve(json(200, []));
  // Everything else, the admin directory included, is refused as the API refuses Sales and Accountants.
  return Promise.resolve(
    json(403, { error: { code: 'forbidden', message: 'Forbidden', correlationId: 'c' } }),
  );
}) satisfies typeof fetch;
const fetchMock = vi.fn<typeof fetch>(defaultFetch);

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 'tok' });
  fetchMock.mockReset().mockImplementation(defaultFetch);
  stubApiEnv();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const person = (userId: string, name: string) => ({
  userId,
  name,
  jobTitle: null,
  department: null,
});
const PERSON = person(NAMED, 'Mina Rai');
const memoSnapshot = {
  title: 'Two laptops',
  number: 'PR-2082-0007',
  body: 'Please approve two laptops for the design team.',
  template: {
    organizationId: '66666666-6666-4666-8666-666666666666',
    organizationName: 'Techrida',
    departmentId: '77777777-7777-4777-8777-777777777777',
    departmentName: 'Design',
    date: '2026-11-17',
    closing: 'Regards',
    preparedBy: person(REQUESTER, 'Ram Thapa'),
    recommenders: [PERSON],
    approvedBy: person(GROUP, 'Sita Karki'),
  },
};

describe('inbox detail page', () => {
  it('shows a submitted memo body once and keeps its other details collapsed, with no inbox-reason card', async () => {
    fetchMock.mockImplementation((input) => {
      const path = new URL(input as URL | string).pathname;
      if (path === `/v1/approvals/requests/${RID}`)
        return Promise.resolve(json(200, { ...request, snapshot: memoSnapshot }));
      if (path === '/v1/approvals/inbox')
        return Promise.resolve(
          json(200, [
            {
              requestId: RID,
              documentType: 'test_memo',
              documentId: DOC,
              documentNumber: 'PR-2082-0007',
              title: 'Two laptops',
              amountNpr: null,
              reason: 'Selected recommender 1',
              activeStep: request.steps[0],
              submittedAt: WHEN,
              version: 1,
            },
          ]),
        );
      return Promise.resolve(json(403, { error: { code: 'forbidden', message: 'Forbidden' } }));
    });
    const html = renderToStaticMarkup(
      await InboxDetailPage({ params: Promise.resolve({ id: RID }) }),
    );
    expect(html.split('Please approve two laptops').length - 1).toBe(1);
    expect(html).not.toContain('>Body<');
    expect(html).not.toContain('Why this is in your inbox');
    expect(html).not.toContain('Selected recommender 1');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>[\s\S]*?Details/);
    expect(html).toContain('Approve');
  });

  it('labels people and groups from the request itself and calls no admin endpoint', async () => {
    const html = renderToStaticMarkup(
      await InboxDetailPage({ params: Promise.resolve({ id: RID }) }),
    );
    const paths = fetchMock.mock.calls.map(([url]) => new URL(url as URL | string).pathname);
    expect(paths.sort()).toEqual(['/v1/approvals/inbox', `/v1/approvals/requests/${RID}`]);
    expect(html).toContain('Ram Thapa');
    // The step the author assigned names that person; the group step its group's name.
    expect(html).toContain('Mina Rai');
    expect(html).toContain('Treasury desk');
    expect(html).not.toContain('name unavailable');
  });

  it('titles an unnumbered debit note in words and names its submitter as History does', async () => {
    const SUBMITTER = '77777777-7777-4777-8777-777777777777';
    // The frozen shape invoice-approval.service.ts submits: no title, a draft reference and a content hash.
    const debitNote = {
      ...request,
      documentType: 'debit_note',
      documentNumber: 'Draft debit_note 7d92d5bf',
      snapshot: {
        kind: 'debit_note',
        reference: 'Draft debit_note 7d92d5bf',
        customerName: 'Acme Traders',
        currency: 'NPR',
        total: '1130.00',
        noteReason: 'Short billed',
        contentSha256: 'a'.repeat(64),
      },
      // The note's creator is the requester; someone else pressed submit.
      actions: [{ ...request.actions[0], actorUserId: SUBMITTER }],
      people: [
        { userId: REQUESTER, name: 'Dev Finance Two' },
        { userId: SUBMITTER, name: 'Dev Founder' },
        { userId: NAMED, name: 'Mina Rai' },
      ],
    };
    fetchMock.mockImplementation((input) => {
      const path = new URL(input as URL | string).pathname;
      if (path === `/v1/approvals/requests/${RID}`) return Promise.resolve(json(200, debitNote));
      if (path === '/v1/approvals/inbox') return Promise.resolve(json(200, []));
      return Promise.resolve(json(403, { error: { code: 'forbidden', message: 'Forbidden' } }));
    });
    const html = renderToStaticMarkup(
      await InboxDetailPage({ params: Promise.resolve({ id: RID }) }),
    );
    expect(html).toMatch(/<h1[^>]*>Draft debit note<\/h1>/);
    expect(html).not.toMatch(/debit_note|7d92d5bf|a{64}/);
    expect(html).not.toContain('Content sha256');
    expect(html).toMatch(
      /Submitted <time[^>]*>[^<]*<\/time> by <span>Dev Founder<\/span> for <span>Dev Finance Two<\/span>/,
    );
  });

  it('names the requester when the submit was done by the system', async () => {
    const system = {
      ...request,
      actions: [{ ...request.actions[0], actorUserId: 'system' }],
      people: [{ userId: REQUESTER, name: 'Dev Finance Two' }],
    };
    fetchMock.mockImplementation((input) => {
      const path = new URL(input as URL | string).pathname;
      if (path === `/v1/approvals/requests/${RID}`) return Promise.resolve(json(200, system));
      if (path === '/v1/approvals/inbox') return Promise.resolve(json(200, []));
      return Promise.resolve(json(403, { error: { code: 'forbidden', message: 'Forbidden' } }));
    });
    const html = renderToStaticMarkup(
      await InboxDetailPage({ params: Promise.resolve({ id: RID }) }),
    );
    expect(html).toMatch(/Submitted <time[^>]*>[^<]*<\/time> by <span>Dev Finance Two<\/span>/);
    expect(html).not.toMatch(/by <span>Person name unavailable<\/span>/);
  });

  it('does not add "for" when the requester submitted it themselves', async () => {
    const own = {
      ...request,
      people: [
        { userId: REQUESTER, name: 'Dev Finance Two' },
        { userId: NAMED, name: 'Mina Rai' },
      ],
    };
    fetchMock.mockImplementation((input) => {
      const path = new URL(input as URL | string).pathname;
      if (path === `/v1/approvals/requests/${RID}`) return Promise.resolve(json(200, own));
      if (path === '/v1/approvals/inbox') return Promise.resolve(json(200, []));
      return Promise.resolve(json(403, { error: { code: 'forbidden', message: 'Forbidden' } }));
    });
    const html = renderToStaticMarkup(
      await InboxDetailPage({ params: Promise.resolve({ id: RID }) }),
    );
    const header =
      /Submitted <time[^>]*>[^<]*<\/time> by <span>[^<]*<\/span>(?: for <span>[^<]*<\/span>)?/.exec(
        html,
      );
    expect(header?.[0]).toBeDefined();
    expect(header?.[0]).not.toContain(' for ');
  });
});

it('lists an unnumbered credit note by its kind, without its internal id', async () => {
  fetchMock.mockImplementation((input) => {
    const path = new URL(input as URL | string).pathname;
    if (path === '/v1/approvals/inbox') {
      const listed = json(200, [
        {
          requestId: RID,
          documentType: 'credit_note',
          documentId: DOC,
          documentNumber: 'Draft credit_note 7d92d5bf',
          title: 'Credit note for Acme Traders (NPR 1130.00)',
          amountNpr: '1130.00',
          reason: 'Accountant checks it',
          activeStep: request.steps[0],
          submittedAt: WHEN,
          version: 1,
        },
      ]);
      listed.headers.set('x-total-count', '1');
      return Promise.resolve(listed);
    }
    return Promise.resolve(json(403, { error: { code: 'forbidden', message: 'Forbidden' } }));
  });
  const html = renderToStaticMarkup(await InboxPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('Credit note for Acme Traders');
  expect(html).toContain('Draft credit note');
  expect(html).not.toMatch(/credit_note 7d92d5bf/);
});

describe('the current record on the approval page (U18 #2)', () => {
  const FILE_DOC = '88888888-8888-4888-8888-888888888888';
  const FILE_VER = '99999999-9999-4999-8999-999999999999';
  const BILL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const context = (href: string | null) => ({
    title: 'Bill BILL-0004',
    fields: [
      { key: 'vendor', label: 'Vendor', value: 'Himal Supplies Pvt Ltd', kind: 'text' },
      { key: 'netTotal', label: 'Net amount', value: '125000.50', kind: 'money', currency: 'NPR' },
      { key: 'status', label: 'Status', value: 'pending_approval', kind: 'status' },
    ],
    documents: [
      {
        documentId: FILE_DOC,
        versionId: FILE_VER,
        filename: 'bill-0004.pdf',
        detectedMime: 'application/pdf',
      },
    ],
    href,
  });
  const serve = (body: unknown) =>
    fetchMock.mockImplementation((input) => {
      const path = new URL(input as URL | string).pathname;
      if (path === `/v1/approvals/requests/${RID}`) return Promise.resolve(json(200, body));
      if (path === '/v1/approvals/inbox') return Promise.resolve(json(200, []));
      return Promise.resolve(json(403, { error: { code: 'forbidden', message: 'Forbidden' } }));
    });

  it('shows a Management approver the bill and its file, with no link when the API gives none', async () => {
    serve({ ...request, documentType: 'vendor_bill', context: context(null) });
    const html = renderToStaticMarkup(
      await InboxDetailPage({ params: Promise.resolve({ id: RID }) }),
    );
    expect(html).toContain('Current record');
    expect(html).toContain('Bill BILL-0004');
    expect(html).toContain('Himal Supplies Pvt Ltd');
    expect(html).toContain('Pending approval');
    expect(html).toMatch(/1,25,000\.50|125,000\.50/);
    expect(html).toContain('bill-0004.pdf');
    expect(html).not.toContain('/payables/bills/');
  });

  it('links the record when the API says the reader may open it', async () => {
    serve({ ...request, documentType: 'vendor_bill', context: context(`/payables/bills/${BILL}`) });
    const html = renderToStaticMarkup(
      await InboxDetailPage({ params: Promise.resolve({ id: RID }) }),
    );
    expect(html).toContain(`href="/payables/bills/${BILL}"`);
  });

  it('leaves the panel out when the API sends no context', async () => {
    const html = renderToStaticMarkup(
      await InboxDetailPage({ params: Promise.resolve({ id: RID }) }),
    );
    expect(html).not.toContain('Current record');
  });
});

it('renders the denial returned by the inbox endpoint', async () => {
  fetchMock.mockResolvedValueOnce(
    json(403, {
      error: {
        code: 'forbidden',
        correlationId: 'request-1234',
        message: 'You have no approval assignment',
        reason: 'out_of_scope',
      },
    }),
  );
  const html = renderToStaticMarkup(await InboxPage({ searchParams: Promise.resolve({}) }));
  const paths = fetchMock.mock.calls.map(([url]) => new URL(url as URL | string).pathname);
  // The summary read starts with the list read (U1-16); its answer is dropped when the list is denied.
  expect(paths).toEqual(['/v1/approvals/inbox', '/v1/approvals/inbox']);
  expect(html).toContain('You have no approval assignment.');
});
