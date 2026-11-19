// I-27: the request page names its department and cost centre from the record the API sends, so a Procurement
// user (who cannot read the department or cost-centre directory) sees them. Drives the real API client.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubApi, textOf } from '@/test/api-fetch-stub';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () =>
    Promise.resolve({ accessToken: 'tok', roles: ['procurement'], userId: 'proc-1' }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/procurement/requests',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../actions', () => ({
  createPrAction: vi.fn(),
  updatePrAction: vi.fn(),
  submitPrAction: vi.fn(),
  cancelPrAction: vi.fn(),
}));

const { default: DetailPage } = await import('./page');
const { default: ListPage } = await import('../page');

const ID = '11111111-1111-4111-8111-111111111111';
const DEPT = '22222222-2222-4222-8222-222222222222';
const CC = '33333333-3333-4333-8333-333333333333';

const pr = (over: Record<string, unknown> = {}) => ({
  id: ID,
  number: 'PR-2083/84-00004',
  requestType: 'goods',
  departmentId: DEPT,
  requesterUserId: 'someone-else',
  costCenterId: CC,
  justification: 'Chairs for the new office',
  requiredBy: '2026-12-01',
  deliveryLocation: null,
  budgetCode: 'OPS-26',
  projectId: null,
  currency: 'NPR',
  estimatedTotal: '45000.00',
  estimatedTotalNpr: null,
  fxRate: null,
  fxSource: null,
  fxDate: null,
  isEmergency: false,
  emergencyReason: null,
  status: 'draft',
  approvalRequestId: null,
  rfqId: null,
  submittedAt: null,
  version: 1,
  createdAt: '2026-11-08T05:45:00.000Z',
  updatedAt: '2026-11-08T05:45:00.000Z',
  lines: [],
  ...over,
});

let record: Record<string, unknown> = pr();
beforeEach(() => {
  stubApi(() => ({
    [`/v1/procurement/purchase-requests/${ID}`]: record,
    '/v1/procurement/purchase-requests': [record],
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const detail = async () =>
  textOf(
    renderToStaticMarkup(
      await DetailPage({ params: Promise.resolve({ id: ID }), searchParams: Promise.resolve({}) }),
    ),
  );

describe('purchase request names (I-27)', () => {
  it("shows another requester's department and cost centre by the names the record carries", async () => {
    record = pr({ departmentName: 'Operations', costCenterName: 'GENERAL' });
    const text = await detail();
    expect(text).toContain('Operations');
    expect(text).toContain('GENERAL');
    expect(text).not.toContain('Department name unavailable');
    expect(text).not.toContain('Cost centre name unavailable');
  });

  it('names the department in the list too', async () => {
    record = pr({ departmentName: 'Operations', costCenterName: 'GENERAL' });
    const text = textOf(
      renderToStaticMarkup(await ListPage({ searchParams: Promise.resolve({}) })),
    );
    expect(text).toContain('Operations');
    expect(text).not.toContain('Department name unavailable');
  });

  it('says the name is unavailable when the record has none, and None for an unset project', async () => {
    record = pr({ departmentName: null, costCenterName: null });
    const text = await detail();
    expect(text).toContain('Department name unavailable');
    expect(text).toContain('Cost centre name unavailable');
    expect(text).toContain('None');
  });
});
