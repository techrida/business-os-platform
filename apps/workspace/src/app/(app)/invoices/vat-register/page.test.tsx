import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

import type { SalesVatRegister } from '@bos/contracts';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['accountant'] as string[] }));
const api = vi.hoisted(() => ({ getSalesVatRegister: vi.fn() }));
const guard = vi.hoisted(() => ({ requireStaffSession: vi.fn() }));
vi.mock('@/lib/bff', () => guard);
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
vi.mock('@/lib/api-billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-billing')>()),
  ...api,
}));

const { default: SalesVatRegisterPage } = await import('./page');
const id = '11111111-1111-4111-8111-111111111111';
const period = { from: '2026-11-01', to: '2026-11-30' };
const zeros = { exemptAmount: '0.00', zeroRatedAmount: '0.00' };
const register: SalesVatRegister = {
  ...period,
  rows: [
    {
      invoiceId: id,
      kind: 'tax_invoice',
      number: 'INV-1',
      issueDate: '2026-11-09',
      issueDateBs: '2083-07-23',
      buyerName: 'Himal Traders',
      buyerPan: '123456789',
      currency: 'NPR',
      taxableAmount: '100.00',
      vatAmount: '13.00',
      totalAmount: '113.00',
      ...zeros,
    },
    {
      invoiceId: '22222222-2222-4222-8222-222222222222',
      kind: 'credit_note',
      number: 'CN-1',
      issueDate: '2026-11-10',
      issueDateBs: '2083-07-24',
      buyerName: 'Overseas Buyer',
      buyerPan: null,
      currency: 'USD',
      taxableAmount: '-10.00',
      vatAmount: '-1.30',
      totalAmount: '-11.30',
      ...zeros,
    },
  ],
  // Deliberately different from the visible rows: totals must come from the API, one set per currency.
  totals: [
    {
      currency: 'NPR',
      documents: 1,
      taxableAmount: '9999.99',
      vatAmount: '888.88',
      totalAmount: '10888.87',
      ...zeros,
    },
    {
      currency: 'USD',
      documents: 1,
      taxableAmount: '-10.00',
      vatAmount: '-1.30',
      totalAmount: '-11.30',
      ...zeros,
    },
  ],
};
const render = async (params: { from?: string | string[]; to?: string | string[] } = period) =>
  renderToStaticMarkup(await SalesVatRegisterPage({ searchParams: Promise.resolve(params) }));

beforeEach(() => {
  vi.clearAllMocks();
  grants.live = undefined;
  session.roles = ['accountant'];
  guard.requireStaffSession.mockResolvedValue(session);
  api.getSalesVatRegister.mockResolvedValue(register);
});

it('requires the staff session and refuses a role without the grant before loading VAT data', async () => {
  session.roles = ['sales'];
  expect(await render()).toContain('Your roles do not include the sales VAT register.');
  expect(guard.requireStaffSession).toHaveBeenCalledWith('/invoices/vat-register');
  expect(api.getSalesVatRegister).not.toHaveBeenCalled();
});

it.each([
  { from: '2026-11-30', to: '2026-11-01' },
  { from: '2026-02-30', to: '2026-11-30' },
  { from: '2026-11-01' },
  { from: ['2026-11-01', '2026-11-02'], to: '2026-11-30' },
])('rejects invalid date ranges before any API read: %j', async (params) => {
  expect(await render(params)).toContain('Choose valid start and end dates');
  expect(api.getSalesVatRegister).not.toHaveBeenCalled();
});

it('asks for a period without reading or showing an export', async () => {
  const html = await render({});
  expect(html).toContain('Choose a period.');
  expect(html).not.toContain('Export CSV');
  expect(api.getSalesVatRegister).not.toHaveBeenCalled();
});

it('renders rows with BS dates, document kinds, links, negative credit notes and one total row per currency', async () => {
  const html = await render();
  expect(api.getSalesVatRegister).toHaveBeenCalledExactlyOnceWith(session, period.from, period.to);
  expect(html).toContain('Himal Traders');
  expect(html).toContain('123456789');
  expect(html).toContain('No PAN');
  expect(html).toContain('2083-07-23');
  expect(html).toContain('Credit note');
  expect(html).toContain(`/invoices/${id}`);
  expect(html).toContain('/invoices/vat-register/export?from=2026-11-01&amp;to=2026-11-30');
  const footer = html.match(/<tfoot>[\s\S]*?<\/tfoot>/)?.[0] ?? '';
  expect(footer.match(/<tr/g)).toHaveLength(2);
  expect(footer).toContain('9,999.99');
  expect(footer).toContain('888.88');
  expect(footer).toContain('-10.00');
  expect(html).toContain('Taxable sales (NPR)');
  expect(html).toContain('VAT charged (USD)');
});

it('shows the empty period result and still permits exporting', async () => {
  api.getSalesVatRegister.mockResolvedValue({ ...register, rows: [], totals: [] });
  const html = await render();
  expect(html).toContain('No issued documents in this period.');
  expect(html).toContain('Export CSV');
  expect(html).not.toContain('INV-1');
});

it('shows a failed load without an export', async () => {
  api.getSalesVatRegister.mockRejectedValue(new ApiError(403, 'Forbidden'));
  const html = await render();
  expect(html).toContain('The register did not load');
  expect(html).not.toContain('Export CSV');
  expect(html).not.toContain('INV-1');
});

// The page reads the live grants, not the role defaults.
it('opens for a role an admin granted the register, and refuses an Accountant whose grant was removed', async () => {
  session.roles = ['sales'];
  grants.live = new Map([['vat.sales.read', 'all']]);
  expect(await render()).toContain('INV-1');
  session.roles = ['accountant'];
  grants.live = new Map([['payables.vat_register.read', 'all']]);
  api.getSalesVatRegister.mockClear();
  expect(await render()).toContain('Your roles do not include the sales VAT register.');
  expect(api.getSalesVatRegister).not.toHaveBeenCalled();
});
