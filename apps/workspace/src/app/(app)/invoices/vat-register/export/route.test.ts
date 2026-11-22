import { beforeEach, expect, it, vi } from 'vitest';

import type { SalesVatRegister } from '@bos/contracts';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
const api = vi.hoisted(() => ({ getSalesVatRegister: vi.fn() }));
vi.mock('@/lib/session', () => auth);
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
vi.mock('@/lib/api-billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-billing')>()),
  ...api,
}));

const { GET } = await import('./route');
const session: Session = {
  id: 'session',
  sub: 'user',
  orgId: 'entity',
  orgKind: 'staff',
  roles: ['accountant'],
  accessToken: 'test-token',
  accessExp: 1,
  createdAt: 1,
  lastSeenAt: 1,
};
const period = { from: '2026-11-01', to: '2026-11-30' };
const register: SalesVatRegister = {
  ...period,
  rows: [
    {
      invoiceId: '11111111-1111-4111-8111-111111111111',
      kind: 'tax_invoice',
      number: 'INV-1',
      issueDate: '2026-11-09',
      issueDateBs: '2083-07-23',
      buyerName: 'Himal Traders',
      buyerPan: '123456789',
      currency: 'NPR',
      taxableAmount: '100.00',
      vatAmount: '13.00',
      exemptAmount: '5.00',
      zeroRatedAmount: '0.00',
      totalAmount: '118.00',
      fxRate: '1.000000',
      nprTaxableAmount: '100.00',
      nprVatAmount: '13.00',
      nprExemptAmount: '5.00',
      nprZeroRatedAmount: '0.00',
      nprTotalAmount: '118.00',
    },
    {
      invoiceId: '22222222-2222-4222-8222-222222222222',
      kind: 'credit_note',
      number: 'CN-1',
      issueDate: '2026-11-10',
      issueDateBs: '2083-07-24',
      buyerName: '=HYPERLINK("http://evil.example")',
      buyerPan: null,
      currency: 'USD',
      taxableAmount: '-10.00',
      vatAmount: '-1.30',
      exemptAmount: '0.00',
      zeroRatedAmount: '0.00',
      totalAmount: '-11.30',
      fxRate: '133.500000',
      nprTaxableAmount: '-1335.00',
      nprVatAmount: '-173.55',
      nprExemptAmount: '0.00',
      nprZeroRatedAmount: '0.00',
      nprTotalAmount: '-1508.55',
    },
  ],
  // Deliberately different from the visible rows: totals must come from the API.
  totals: [
    {
      currency: 'NPR',
      documents: 1,
      taxableAmount: '9999.99',
      vatAmount: '888.88',
      exemptAmount: '5.00',
      zeroRatedAmount: '0.00',
      totalAmount: '10893.87',
    },
    {
      currency: 'USD',
      documents: 1,
      taxableAmount: '-10.00',
      vatAmount: '-1.30',
      exemptAmount: '0.00',
      zeroRatedAmount: '0.00',
      totalAmount: '-11.30',
    },
  ],
  nprTotal: {
    documents: 2,
    taxableAmount: '1234.56',
    vatAmount: '160.55',
    exemptAmount: '5.00',
    zeroRatedAmount: '0.00',
    totalAmount: '1390.55',
  },
};
const request = (query = new URLSearchParams(period).toString()) =>
  new Request(`https://workspace.example/invoices/vat-register/export?${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  grants.live = undefined;
  auth.getSession.mockResolvedValue(session);
  api.getSalesVatRegister.mockResolvedValue(register);
});

it.each([
  [null, 401],
  [{ ...session, orgKind: 'vendor' }, 403],
  [{ ...session, roles: ['sales'] }, 403],
])(
  'denies absent, non-staff or unauthorized sessions before reading VAT: %j',
  async (caller, status) => {
    auth.getSession.mockResolvedValue(caller);
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(api.getSalesVatRegister).not.toHaveBeenCalled();
  },
);

it.each([
  '',
  'from=2026-11-01',
  'from=2026-02-30&to=2026-11-30',
  'from=2026-11-30&to=2026-11-01',
  'from=invalid&to=2026-11-30',
])('rejects an invalid export range without an API read: %s', async (query) => {
  const response = await GET(request(query));
  expect(response.status).toBe(400);
  expect(api.getSalesVatRegister).not.toHaveBeenCalled();
});

it('downloads UTF-8 CSV with the exact server values, per-currency totals and a formula-safe buyer cell', async () => {
  const response = await GET(request());
  expect(api.getSalesVatRegister).toHaveBeenCalledExactlyOnceWith(session, period.from, period.to);
  expect(response.status).toBe(200);
  expect(Object.fromEntries(response.headers)).toEqual({
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="sales-vat-2026-11-01-2026-11-30.csv"',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const lines = new TextDecoder().decode(bytes.slice(3)).split('\r\n');
  expect(lines[0]).toBe(
    '"Date (BS)","Date (AD)","Document","Invoice number","Buyer","Buyer PAN","Currency","Taxable amount","VAT","Exempt amount","Zero-rated amount","Total","Rate to NPR","NPR taxable amount","NPR VAT","NPR exempt amount","NPR zero-rated amount","NPR total"',
  );
  expect(lines[1]).toBe(
    '"2083-07-23","2026-11-09","Tax invoice","INV-1","Himal Traders","123456789","NPR","100.00","13.00","5.00","0.00","118.00","1.000000","100.00","13.00","5.00","0.00","118.00"',
  );
  // A credit note is negative, and a buyer name that starts like a formula is quoted with a leading apostrophe.
  expect(lines[2]).toBe(
    '"2083-07-24","2026-11-10","Credit note","CN-1","\'=HYPERLINK(""http://evil.example"")","","USD","-10.00","-1.30","0.00","0.00","-11.30","133.500000","-1335.00","-173.55","0.00","0.00","-1508.55"',
  );
  expect(lines[3]).toBe(
    '"Total NPR","","","","","","NPR","9999.99","888.88","5.00","0.00","10893.87","","","","","",""',
  );
  expect(lines[4]).toBe(
    '"Total USD","","","","","","USD","-10.00","-1.30","0.00","0.00","-11.30","","","","","",""',
  );
  // One NPR filing total across the currencies, in the NPR columns only (the API's figures, not re-added here).
  expect(lines[5]).toBe(
    '"NPR filing total (all currencies)","","","","","","","","","","","","","1234.56","160.55","5.00","0.00","1390.55"',
  );
});

it.each([401, 403, 404, 422, 429])(
  'preserves upstream refusal status %i as uncached JSON',
  async (status) => {
    api.getSalesVatRegister.mockRejectedValue(new ApiError(status, 'upstream refusal'));
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('content-disposition')).toBe(false);
  },
);

// The export reads the live grants, not the role defaults.
it('exports for a role an admin granted the register, whatever its defaults', async () => {
  auth.getSession.mockResolvedValue({ ...session, roles: ['sales'] });
  grants.live = new Map([['vat.sales.read', 'all']]);
  expect((await GET(request())).status).toBe(200);
});

it('refuses an Accountant whose register grant an admin removed, and one holding only the purchase register', async () => {
  grants.live = new Map([['payables.vat_register.read', 'all']]);
  expect((await GET(request())).status).toBe(403);
  expect(api.getSalesVatRegister).not.toHaveBeenCalled();
});
