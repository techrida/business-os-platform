import { beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { VatRegister } from '@/lib/api-payables';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
const api = vi.hoisted(() => ({ getVatRegister: vi.fn() }));
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
vi.mock('@/lib/api-payables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-payables')>()),
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
const register: VatRegister = {
  ...period,
  rows: [
    {
      vendorBillId: '11111111-1111-4111-8111-111111111111',
      billNumber: 'BILL-1',
      vendorPartyId: '11111111-1111-4111-8111-111111111111',
      vendorName: 'Himal Traders',
      vendorPan: '123456789',
      vendorInvoiceNo: 'INV-1',
      invoiceDate: '2026-11-09',
      invoiceDateBs: '2083-07-23',
      taxableAmount: '100.00',
      vatAmount: '13.00',
    },
  ],
  total: { taxableAmount: '9999.99', vatAmount: '888.88' },
};
const request = (query = new URLSearchParams(period).toString()) =>
  new Request(`https://workspace.example/payables/vat-register/export?${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  grants.live = undefined;
  auth.getSession.mockResolvedValue(session);
  api.getVatRegister.mockResolvedValue(register);
});

it.each([
  [null, 401],
  [{ ...session, orgKind: 'vendor' }, 403],
  [{ ...session, roles: ['warehouse'] }, 403],
])(
  'denies absent, non-staff or unauthorized sessions before reading VAT: %j',
  async (caller, status) => {
    auth.getSession.mockResolvedValue(caller);
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(api.getVatRegister).not.toHaveBeenCalled();
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
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(api.getVatRegister).not.toHaveBeenCalled();
});

it('downloads UTF-8 CSV with the exact server values and private response headers', async () => {
  const response = await GET(request());
  expect(api.getVatRegister).toHaveBeenCalledExactlyOnceWith(session, period.from, period.to);
  expect(response.status).toBe(200);
  expect(Object.fromEntries(response.headers)).toEqual({
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="purchase-vat-2026-11-01-2026-11-30.csv"',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(new TextDecoder().decode(bytes.slice(3))).toBe(
    '"PAN","Vendor","Invoice number","Invoice date (BS)","Invoice date (AD)","Taxable amount (NPR)","VAT (NPR)"\r\n' +
      '"123456789","Himal Traders","INV-1","2083-07-23","2026-11-09","100.00","13.00"\r\n' +
      '"Total","","","","","9999.99","888.88"\r\n',
  );
});

it.each([401, 403, 404, 422, 429])(
  'preserves upstream refusal status %i as uncached JSON',
  async (status) => {
    api.getVatRegister.mockRejectedValue(new ApiError(status, 'upstream refusal'));
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.has('content-disposition')).toBe(false);
    const body: unknown = await response.json();
    expect(body).toHaveProperty('error.message');
  },
);

// The export reads the live grants, not the role defaults (both cases fail on the old role-default gate).
it('exports for a role an admin granted the register, whatever its defaults', async () => {
  auth.getSession.mockResolvedValue({ ...session, roles: ['warehouse'] });
  grants.live = new Map([['payables.vat_register.read', 'own']]);
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(api.getVatRegister).toHaveBeenCalledOnce();
});

it('refuses an Accountant whose register grant an admin removed, before reading VAT', async () => {
  grants.live = new Map([['payables.bill.read', 'all']]);
  const response = await GET(request());
  expect(response.status).toBe(403);
  expect(api.getVatRegister).not.toHaveBeenCalled();
});
