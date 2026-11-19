import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['procurement'] as string[] }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: session.roles }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/procurement/requests',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('./actions', () => ({
  createPrAction: vi.fn(),
  updatePrAction: vi.fn(),
  submitPrAction: vi.fn(),
  cancelPrAction: vi.fn(),
}));
const api = vi.hoisted(() => ({
  listPurchaseRequestsPage: vi.fn(),
  getPurchaseRequest: vi.fn(),
  listDepartments: vi.fn(),
  listCostCenters: vi.fn(),
}));
vi.mock('@/lib/api-procurement', () => api);
const kernel = vi.hoisted(() => ({ getApprovalRequest: vi.fn() }));
vi.mock('@/lib/api-kernel', () => kernel);

const { default: ListPage } = await import('./page');
const { default: DetailPage } = await import('./[id]/page');
const { default: EditPage } = await import('./[id]/edit/page');
const { default: NewPage } = await import('./new/page');

const ID = '11111111-1111-4111-8111-111111111111';
const DEPT = '22222222-2222-4222-8222-222222222222';
const APPROVAL = '44444444-4444-4444-8444-444444444444';

const apiError = (status: number, code = 'x', extra: Record<string, unknown> = {}) =>
  new ApiError(status, 'x', {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678', ...extra },
  });

const item = (over: Record<string, unknown> = {}) => ({
  id: ID,
  number: null,
  requestType: 'goods',
  departmentId: DEPT,
  requesterUserId: 'user-1',
  costCenterId: DEPT,
  justification: 'Chairs for the new office',
  requiredBy: '2026-12-01',
  deliveryLocation: null,
  budgetCode: 'OPS-26',
  projectId: null,
  currency: 'NPR',
  estimatedTotal: '4500000.00',
  estimatedTotalNpr: null,
  fxRate: null,
  fxSource: null,
  fxDate: null,
  isEmergency: false,
  emergencyReason: null,
  status: 'draft',
  approvalRequestId: null,
  submittedAt: null,
  version: 2,
  createdAt: '2026-11-08T05:45:00.000Z',
  updatedAt: '2026-11-08T05:45:00.000Z',
  ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({
  ...item(over),
  lines: [
    {
      id: DEPT,
      lineNo: 1,
      description: 'Office chair',
      specification: 'Ergonomic, black',
      uom: 'pcs',
      quantity: '10.0000',
      estimatedUnitPrice: '450000.00',
      estimatedAmount: '4500000.00',
    },
  ],
});

const html = (el: unknown) => renderToStaticMarkup(el as React.ReactElement);

/**
 * The server markup of one dropdown: its root (carries data-required / data-disabled), the hidden
 * field that submits the value, and the trigger button that shows the selected label.
 */
function dropdown(out: string, name: string) {
  const match = new RegExp(
    `(<div[^>]*data-rac[^>]*>)(<input type="hidden"[^>]*name="${name}"[^>]*/>)(.*?</button>)`,
    's',
  ).exec(out);
  return match ? { root: match[1]!, field: match[2]!, trigger: match[3]! } : null;
}
const page = (items: unknown[], total = items.length) => ({ items, total });
const list = async (sp: Record<string, string | string[]> = {}) =>
  html(await ListPage({ searchParams: Promise.resolve(sp) }));
const detailHtml = async (sp: Record<string, string> = {}) =>
  html(
    await DetailPage({ params: Promise.resolve({ id: ID }), searchParams: Promise.resolve(sp) }),
  );
const editHtml = async () => html(await EditPage({ params: Promise.resolve({ id: ID }) }));

beforeEach(() => {
  vi.clearAllMocks();
  session.roles = ['procurement'];
  api.listDepartments.mockResolvedValue([{ id: DEPT, name: 'Operations' }]);
  api.listCostCenters.mockResolvedValue([
    { id: DEPT, code: 'GENERAL', name: 'General', active: true },
  ]);
});

describe('the list', () => {
  it('shows the rows with server money (lakh grouping) and an Emergency badge', async () => {
    api.listPurchaseRequestsPage.mockResolvedValue(
      page([item({ isEmergency: true, number: 'PR-2082/83-00001', status: 'submitted' })]),
    );
    const out = await list();
    expect(out).toContain('PR-2082/83-00001');
    expect(out).toContain('Chairs for the new office');
    expect(out).toContain('45,00,000.00');
    expect(out).toContain('Emergency');
    expect(out).toContain('Awaiting approval');
    expect(out).toContain('New purchase request');
  });

  it('a draft has no number yet and says so', async () => {
    api.listPurchaseRequestsPage.mockResolvedValue(page([item()]));
    expect(await list()).toContain('Not numbered yet');
  });

  it('passes repeated statuses, the search and the page window, dropping a bogus status', async () => {
    api.listPurchaseRequestsPage.mockResolvedValue(page([]));
    await list({ status: ['returned', 'bogus', 'draft'], q: ' chairs ', page: '3', rows: '50' });
    expect(api.listPurchaseRequestsPage).toHaveBeenCalledWith(expect.anything(), {
      status: ['returned', 'draft'],
      q: 'chairs',
      limit: 50,
      offset: 100,
    });
  });

  it('asks for the first page of 25 when the URL has no filters', async () => {
    api.listPurchaseRequestsPage.mockResolvedValue(page([]));
    await list({});
    expect(api.listPurchaseRequestsPage).toHaveBeenCalledWith(expect.anything(), {
      status: [],
      limit: 25,
      offset: 0,
    });
  });

  it('shows the total, the range and no Apply button', async () => {
    api.listPurchaseRequestsPage.mockResolvedValue(page([item(), item()], 134));
    const out = await list({ status: 'draft' });
    expect(out).toContain('Showing 2 of 134 requests');
    expect(out).toContain('Showing 1-25 of 134');
    expect(out).toContain('type="search"');
    expect(out).not.toContain('>Apply<');
  });

  it('a page past the end falls back to the last page', async () => {
    api.listPurchaseRequestsPage
      .mockResolvedValueOnce(page([], 30))
      .mockResolvedValueOnce(page([item()], 30));
    const out = await list({ page: '9' });
    expect(api.listPurchaseRequestsPage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ offset: 25 }),
    );
    expect(out).toContain('Showing 26-30 of 30');
  });

  it('says "My purchase requests" for a role that reads only its own, and hides New without the grant', async () => {
    session.roles = ['finance'];
    api.listPurchaseRequestsPage.mockResolvedValue(page([]));
    const out = await list();
    expect(out).toContain('My purchase requests');
    expect(out).not.toContain('New purchase request');
  });

  it('an operations officer sees their own heading and can still raise a request', async () => {
    session.roles = ['operations_officer'];
    api.listPurchaseRequestsPage.mockResolvedValue(page([]));
    const out = await list();
    expect(out).toContain('My purchase requests');
    expect(out).toContain('New purchase request');
  });

  it('empty: invites a first request; filtered empty offers to clear', async () => {
    api.listPurchaseRequestsPage.mockResolvedValue(page([]));
    expect(await list()).toContain('No purchase requests yet.');
    const filtered = await list({ status: ['closed', 'draft'], q: 'chairs' });
    expect(filtered).toContain('Clear filters');
    expect(filtered).toContain('Status: Closed, Draft');
    expect(filtered).toContain('chairs');
    expect(filtered).toContain('href="/procurement/requests"');
  });

  it('403 is an info notice, not an error, with no reload link', async () => {
    api.listPurchaseRequestsPage.mockRejectedValue(apiError(403, 'forbidden'));
    const out = await list();
    expect(out).toContain('Your roles do not include purchase requests');
    expect(out).not.toContain('Reload purchase requests');
  });

  it('an API failure is an alert with a reload link and the platform-did-not-respond words', async () => {
    api.listPurchaseRequestsPage.mockRejectedValue(new ApiError(502, 'x'));
    const out = await list();
    expect(out).toContain('Purchase requests did not load');
    expect(out).toContain('Reload purchase requests');
  });

  it('a long justification wraps without breaking the table', async () => {
    api.listPurchaseRequestsPage.mockResolvedValue(
      page([item({ justification: 'x'.repeat(2000) })]),
    );
    expect(await list()).toContain('x'.repeat(2000));
  });
});

describe('the detail', () => {
  it('a draft offers submit, edit and cancel, with totals from the server', async () => {
    api.getPurchaseRequest.mockResolvedValue(detail());
    const out = await detailHtml();
    expect(out).toContain('Submit for approval');
    expect(out).toContain('Edit request');
    expect(out).toContain('Cancel request');
    expect(out).toContain('45,00,000.00');
    expect(out).toContain('Office chair');
    expect(out).toContain('Ergonomic, black');
  });

  it('a submitted request is read-only: no submit, edit or cancel, and shows the approval steps', async () => {
    api.getPurchaseRequest.mockResolvedValue(
      detail({ status: 'submitted', number: 'PR-1', approvalRequestId: APPROVAL }),
    );
    kernel.getApprovalRequest.mockResolvedValue({
      status: 'pending',
      decidedAt: null,
      steps: [
        {
          seq: 1,
          reason: 'Base route: the head of the requesting department approves the need',
          status: 'active',
        },
      ],
    });
    const out = await detailHtml();
    expect(out).not.toContain('Submit for approval');
    expect(out).not.toContain('Edit request');
    expect(out).not.toContain('Cancel request');
    expect(out).toContain('the head of the requesting department approves the need');
    expect(kernel.getApprovalRequest).toHaveBeenCalledWith(expect.anything(), APPROVAL);
  });

  it('a returned request offers resubmit and edit but not cancel', async () => {
    api.getPurchaseRequest.mockResolvedValue(detail({ status: 'returned', number: 'PR-1' }));
    const out = await detailHtml();
    expect(out).toContain('Resubmit');
    expect(out).toContain('Edit request');
    expect(out).not.toContain('Cancel request');
  });

  it('shows the emergency reason and the NPR estimate for a foreign-currency request', async () => {
    api.getPurchaseRequest.mockResolvedValue(
      detail({
        isEmergency: true,
        emergencyReason: 'Generator failed',
        currency: 'USD',
        estimatedTotal: '1000.00',
        estimatedTotalNpr: '133500.00',
        fxRate: '133.500000',
        fxDate: '2026-11-08',
        status: 'submitted',
      }),
    );
    const out = await detailHtml();
    expect(out).toContain('Generator failed');
    expect(out).toContain('1,33,500.00');
  });

  it('a user without the create grant sees no buttons on a draft', async () => {
    session.roles = ['finance'];
    api.getPurchaseRequest.mockResolvedValue(detail());
    const out = await detailHtml();
    expect(out).not.toContain('Submit for approval');
    expect(out).not.toContain('Cancel request');
  });

  it('a department-approved request with no RFQ offers Start RFQ to sourcing staff only', async () => {
    api.getPurchaseRequest.mockResolvedValue(detail({ status: 'dept_approved' }));
    const out = await detailHtml();
    expect(out).toContain('Start RFQ');
    expect(out).toContain(`/procurement/rfqs/new?pr=${ID}`);
    session.roles = ['sales'];
    expect(await detailHtml()).not.toContain('Start RFQ');
  });

  it('a request with an RFQ opens it instead of starting another', async () => {
    const RFQ = '99999999-9999-4999-8999-999999999999';
    api.getPurchaseRequest.mockResolvedValue(detail({ status: 'sourcing', rfqId: RFQ }));
    const out = await detailHtml();
    expect(out).toContain('Open RFQ');
    expect(out).toContain(`/procurement/rfqs/${RFQ}`);
    expect(out).not.toContain('Start RFQ');
  });

  it('no RFQ button before the department head approved, or when the RFQ id is absent', async () => {
    api.getPurchaseRequest.mockResolvedValue(detail({ status: 'submitted' }));
    const out = await detailHtml();
    expect(out).not.toContain('Start RFQ');
    expect(out).not.toContain('Open RFQ');
  });

  it('a missing or foreign request is the not-found page', async () => {
    api.getPurchaseRequest.mockRejectedValue(apiError(404, 'not_found'));
    await expect(detailHtml()).rejects.toThrow('NOT_FOUND');
  });

  it('403 is an info notice', async () => {
    api.getPurchaseRequest.mockRejectedValue(apiError(403, 'forbidden'));
    expect(await detailHtml()).toContain('Your roles do not include this purchase request');
  });

  it('an approval that fails to load does not take the page down', async () => {
    api.getPurchaseRequest.mockResolvedValue(
      detail({ status: 'submitted', approvalRequestId: APPROVAL }),
    );
    kernel.getApprovalRequest.mockRejectedValue(new ApiError(500, 'x'));
    const out = await detailHtml();
    expect(out).toContain('The approval did not load');
    expect(out).toContain('Office chair');
  });

  it("names the request's purchase orders and offers Receive service only where the API allows it", async () => {
    session.roles = ['operations_officer'];
    const ISSUED = '55555555-5555-4555-8555-555555555551';
    const DONE = '55555555-5555-4555-8555-555555555552';
    api.getPurchaseRequest.mockResolvedValue(
      detail({
        status: 'po_issued',
        purchaseOrders: [
          {
            id: ISSUED,
            number: 'PO-2083-0011',
            status: 'issued',
            vendorName: 'Everest Cleaners Pvt Ltd',
            can: { receiveService: true },
          },
          {
            id: DONE,
            number: 'PO-2083-0012',
            status: 'fully_received',
            vendorName: 'Himal Traders Pvt Ltd',
            can: { receiveService: false },
          },
        ],
      }),
    );
    const out = await detailHtml();
    expect(out).toContain('Purchase orders');
    expect(out).toContain('PO-2083-0011');
    expect(out).toContain('Everest Cleaners Pvt Ltd');
    expect(out).toContain('PO-2083-0012');
    expect(out).toContain(`href="/procurement/receipts?po=${ISSUED}"`);
    expect(out).toContain(`href="/procurement/receipts?po=${DONE}"`);
    expect(out).toContain(`href="/procurement/receipts/new?po=${ISSUED}"`);
    expect(out).toContain('Receive service');
    expect(out).not.toContain(`/procurement/receipts/new?po=${DONE}`);
    // The requester holds no purchase order read: nothing links to the order page itself.
    expect(out).not.toContain('/procurement/orders/');
  });

  it('shows no purchase order panel when the request has none or the response omits them', async () => {
    api.getPurchaseRequest.mockResolvedValue(detail({ purchaseOrders: [] }));
    expect(await detailHtml()).not.toContain('Purchase orders of this request');
    api.getPurchaseRequest.mockResolvedValue(detail());
    expect(await detailHtml()).not.toContain('Purchase orders of this request');
  });
});

describe('edit and new', () => {
  it.each(['goods', 'service'])(
    'only offers serial tracking for goods when editing %s',
    async (requestType) => {
      api.getPurchaseRequest.mockResolvedValue(detail({ requestType }));
      const out = await editHtml();
      if (requestType === 'goods') {
        expect(out).toContain('name="lines.0.requiresSerials"');
        expect(out).toContain('Record serial numbers at receipt');
      } else {
        expect(out).not.toContain('name="lines.0.requiresSerials"');
        expect(out).not.toContain('Record serial numbers at receipt');
      }
    },
  );

  it('edits a draft with its values and the version seen', async () => {
    api.getPurchaseRequest.mockResolvedValue(detail());
    const out = await editHtml();
    expect(out).toContain('Office chair');
    expect(out).toContain('name="expectedVersion"');
    expect(out).toContain('value="2"');
    expect(out).toContain('Save changes');
  });

  it('a submitted request is read-only on the edit page', async () => {
    api.getPurchaseRequest.mockResolvedValue(detail({ status: 'submitted' }));
    const out = await editHtml();
    expect(out).toContain('This request is read-only');
    expect(out).not.toContain('Save changes');
  });

  it('the new form has an idempotency key, one line and no total', async () => {
    const out = html(await NewPage());
    expect(out).toContain('name="idempotencyKey"');
    expect(out).toContain('name="lines.0.description"');
    expect(out).not.toContain('name="lines.1.description"');
    expect(out).not.toMatch(/Total/);
    expect(out).toContain('Save draft');
  });

  it('the new page refuses a role without the create grant', async () => {
    session.roles = ['finance'];
    const out = html(await NewPage());
    expect(out).toContain('do not include raising purchase requests');
    expect(out).not.toContain('Save draft');
  });
});

it('uses named departments and allows editing cost centre and project references', async () => {
  api.getPurchaseRequest.mockResolvedValue(detail({ projectId: DEPT }));
  const out = await editHtml();
  expect(out).toContain('Operations');
  const department = dropdown(out, 'departmentId');
  expect(department).not.toBeNull();
  expect(department!.trigger).toContain('Operations');
  const costCentre = dropdown(out, 'costCenterId');
  expect(costCentre).not.toBeNull();
  expect(costCentre!.root).toContain('data-required="true"');
  // Editable, not a locked or read-only value.
  expect(costCentre!.root).not.toContain('data-disabled');
  expect(costCentre!.field).not.toContain('disabled');
  expect(costCentre!.trigger).not.toMatch(/<button[^>]*disabled/);
  expect(out).toContain(`name="projectId"`);
  expect(out).not.toContain('type="hidden" name="projectId"');
  expect(out).not.toContain('Cost centre name unavailable');
  expect(out).toContain('Optional. Enter the project reference, or leave blank.');
  // The department is chosen by name; no raw-ID text input is offered.
  expect(out).not.toMatch(/<input(?![^>]*type="hidden")[^>]+name="departmentId"/);
  expect(out).not.toContain(`>${DEPT}<`);
});

it('preserves editing if departments cannot load, without exposing a department ID', async () => {
  api.getPurchaseRequest.mockResolvedValue(detail());
  api.listDepartments.mockRejectedValue(new Error('offline'));
  const out = await editHtml();
  expect(out).toContain('Department name unavailable');
  expect(out).toContain('Save changes');
  expect(out).not.toContain(`>${DEPT}<`);
});

it('does not read departments or expose cost centre entry without create permission', async () => {
  session.roles = ['finance'];
  const out = html(await NewPage());
  expect(api.listDepartments).not.toHaveBeenCalled();
  expect(out).not.toContain('name="costCenterId"');
});

describe('cost centre picker', () => {
  it('loads the entity catalogue on new requests and renders a labelled select', async () => {
    const out = html(await NewPage());
    expect(api.listCostCenters).toHaveBeenCalledOnce();
    const costCentre = dropdown(out, 'costCenterId');
    expect(costCentre).not.toBeNull();
    // Nothing is chosen yet: the required dropdown shows its placeholder and submits an empty value.
    expect(costCentre!.field).toContain('value=""');
    expect(costCentre!.trigger).toContain('Choose a cost centre');
    expect(out).toContain('GENERAL \u00b7 General');
    expect(out).not.toContain('The cost centre&#x27;s id.');
  });

  it('loads the catalogue when editing and keeps the selected centre', async () => {
    api.getPurchaseRequest.mockResolvedValue(detail());
    const out = await editHtml();
    expect(api.listCostCenters).toHaveBeenCalledOnce();
    expect(dropdown(out, 'costCenterId')!.field).toContain(`value="${DEPT}"`);
    expect(out).toContain(`value="${DEPT}" selected=""`);
  });

  it('shows a retryable error when the catalogue cannot load', async () => {
    api.listCostCenters.mockRejectedValue(new ApiError(502, 'unavailable'));
    const out = html(await NewPage());
    expect(out).toContain('Cost centres did not load');
    expect(out).not.toContain('name="costCenterId"');
  });
});

describe('cost centre catalogue states', () => {
  it('keeps an existing inactive centre selected on edit, and hides inactive alternatives', async () => {
    api.getPurchaseRequest.mockResolvedValue(detail());
    api.listCostCenters.mockResolvedValue([
      { id: DEPT, code: 'OLD', name: 'Legacy', active: false },
      { id: ID, code: 'CLOSED', name: 'Other closed centre', active: false },
    ]);
    const out = await editHtml();
    expect(out).toContain('Legacy (inactive)');
    expect(out).not.toContain('Other closed centre');
    const costCentre = dropdown(out, 'costCenterId')!;
    expect(costCentre.field).toContain(`value="${DEPT}"`);
    expect(costCentre.trigger).toContain('Legacy (inactive)');
    expect(out).toContain(`value="${DEPT}" selected=""`);
  });

  it('explains an empty catalogue and disables saving', async () => {
    api.listCostCenters.mockResolvedValue([]);
    const out = html(await NewPage());
    expect(out).toContain('No active cost centres');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Save draft<\/button>/);
  });
});
