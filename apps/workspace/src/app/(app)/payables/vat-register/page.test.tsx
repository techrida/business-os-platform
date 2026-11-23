import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { VatRegister } from '@/lib/api-payables';

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['accountant'] as string[] }));
const api = vi.hoisted(() => ({ getVatRegister: vi.fn() }));
const guard = vi.hoisted(() => ({ requireStaffSession: vi.fn() }));
vi.mock('@/lib/bff', () => guard);
// GET /v1/me for an unedited role answers the role's default grants; a test sets `live` for an edited one.
const grants = vi.hoisted(() => ({ live: undefined as Map<string, string> | undefined }));
vi.mock('@/lib/grants', async () => {
  const { DEFAULT_ROLE_PERMISSIONS } = await import('@bos/contracts');
  return {
    getGrants: (s: { roles: string[] }) =>
      Promise.resolve(
        grants.live ??
          new Map(
            s.roles.flatMap((r) =>
              Object.entries(DEFAULT_ROLE_PERMISSIONS[r as keyof typeof DEFAULT_ROLE_PERMISSIONS]),
            ),
          ),
      ),
    hasGrant: (g: Map<string, string>, p: string) => g.has(p),
  };
});
vi.mock('@/lib/api-payables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-payables')>()),
  ...api,
}));

const { default: VatRegisterPage } = await import('./page');
const id = '11111111-1111-4111-8111-111111111111';
const period = { from: '2026-11-01', to: '2026-11-30' };
const register: VatRegister = {
  ...period,
  rows: [
    {
      vendorBillId: id,
      billNumber: 'BILL-2083-0001',
      vendorPartyId: id,
      vendorName: 'Himal Traders',
      vendorPan: '123456789',
      vendorInvoiceNo: 'INV-1',
      invoiceDate: '2026-11-09',
      invoiceDateBs: '2083-07-23',
      taxableAmount: '100.00',
      vatAmount: '13.00',
    },
  ],
  // Deliberately different from the visible row: totals must come from the API.
  total: { taxableAmount: '9999.99', vatAmount: '888.88' },
};
const render = async (params: { from?: string | string[]; to?: string | string[] } = period) =>
  renderToStaticMarkup(await VatRegisterPage({ searchParams: Promise.resolve(params) }));

beforeEach(() => {
  vi.clearAllMocks();
  grants.live = undefined;
  session.roles = ['accountant'];
  guard.requireStaffSession.mockResolvedValue(session);
  api.getVatRegister.mockResolvedValue(register);
});

it('requires the staff session and refuses unauthorized roles before loading VAT data', async () => {
  session.roles = ['warehouse'];
  expect(await render()).toContain('Your roles do not include the purchase VAT register.');
  expect(guard.requireStaffSession).toHaveBeenCalledWith('/payables/vat-register');
  expect(api.getVatRegister).not.toHaveBeenCalled();
});

it.each([
  { from: '2026-11-30', to: '2026-11-01' },
  { from: '2026-02-30', to: '2026-11-30' },
  { from: '2026-11-01' },
  { from: ['2026-11-01', '2026-11-02'], to: '2026-11-30' },
])('rejects invalid date ranges before any API read: %j', async (params) => {
  expect(await render(params)).toContain('Choose valid start and end dates');
  expect(api.getVatRegister).not.toHaveBeenCalled();
});

it('asks for a period without reading or showing an export', async () => {
  const html = await render({});
  expect(html).toContain('Choose a period.');
  expect(html).not.toContain('Export CSV');
  expect(api.getVatRegister).not.toHaveBeenCalled();
});

// noValidate turns off the browser's required check: an empty submit (`?from=&to=`) must still say why.
it('names the empty start and end dates when the filter is submitted blank', async () => {
  const html = await render({ from: '', to: '' });
  expect(html).toContain('Choose the start date.');
  expect(html).toContain('Choose the end date.');
  expect(html).not.toContain('Choose a period.');
  expect(api.getVatRegister).not.toHaveBeenCalled();
});

it('renders the API totals, BS dates, invoice detail and validated export range', async () => {
  const html = await render();
  expect(api.getVatRegister).toHaveBeenCalledExactlyOnceWith(session, period.from, period.to);
  expect(html).toContain('Himal Traders');
  expect(html).toContain('123456789');
  expect(html).toContain('2083-07-23');
  expect(html).toContain(`/payables/bills/${id}`);
  expect(html).toContain('/payables/vat-register/export?from=2026-11-01&amp;to=2026-11-30');
  const totals = html.match(/<tfoot>[\s\S]*?<\/tfoot>/)?.[0];
  expect(totals).toContain('9,999.99');
  expect(totals).toContain('888.88');
});

it('shows the empty period result and still permits exporting its server totals', async () => {
  api.getVatRegister.mockResolvedValue({
    ...register,
    rows: [],
    total: { taxableAmount: '0.00', vatAmount: '0.00' },
  });
  const html = await render();
  expect(html).toContain('No creditable VAT in this period.');
  expect(html).toContain('Export CSV');
  expect(html).not.toContain('INV-1');
});

it('shows a failed load without an export or unrelated payment-request instructions', async () => {
  api.getVatRegister.mockRejectedValue(new ApiError(403, 'Forbidden'));
  const html = await render();
  expect(html).toContain('The register did not load');
  expect(html).toMatch(/permission|roles/i);
  expect(html).not.toContain('payment requests');
  expect(html).not.toContain('Export CSV');
  expect(html).not.toContain('INV-1');
});

// The page reads the live grants, not the role defaults (both cases fail on the old role-default gate).
it('opens for a role an admin granted the register, whatever its defaults', async () => {
  session.roles = ['warehouse'];
  grants.live = new Map([['payables.vat_register.read', 'own']]);
  const html = await render();
  expect(html).not.toContain('Your roles do not include the purchase VAT register.');
  expect(html).toContain('INV-1');
  expect(api.getVatRegister).toHaveBeenCalledOnce();
});

it('refuses an Accountant whose register grant an admin removed, before loading VAT data', async () => {
  grants.live = new Map([['payables.bill.read', 'all']]);
  expect(await render()).toContain('Your roles do not include the purchase VAT register.');
  expect(api.getVatRegister).not.toHaveBeenCalled();
});
