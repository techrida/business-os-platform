import { beforeEach, describe, expect, it, vi } from 'vitest';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  routeSession: vi.fn<() => Promise<unknown>>(),
  can: vi.fn<(permission: string) => boolean>(),
  listCustomers: vi.fn(),
}));
vi.mock('@/lib/bff', async (original) => ({
  ...(await original<typeof import('@/lib/bff')>()),
  routeSession: mocks.routeSession,
}));
vi.mock('@/lib/live-permissions', () => ({ getPermissionCheck: () => Promise.resolve(mocks.can) }));
vi.mock('@/components/p2/customers/api', () => ({ listCustomers: mocks.listCustomers }));

const { GET } = await import('./route');

const ID = '33333333-3333-4333-8333-333333333333';
const customer = (over: Record<string, unknown> = {}) => ({
  id: ID,
  number: 'CUS-0001',
  legalName: 'Everest Foods',
  panVatNo: '301234567',
  defaultCurrency: 'NPR',
  mergedIntoId: null,
  ...over,
});
const ask = (q: string) => GET(new Request(`https://app.test/payments/new/customers?q=${q}`));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.routeSession.mockResolvedValue({ accessToken: 't', orgKind: 'staff' });
  mocks.can.mockReturnValue(true);
});

describe('GET /payments/new/customers', () => {
  it('answers the live matches with number and PAN, searched as the signed-in user', async () => {
    mocks.listCustomers.mockResolvedValue({
      items: [customer(), customer({ id: 'x', legalName: 'Old Co', mergedIntoId: ID })],
      total: 2,
    });
    const res = await ask('everest');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      customers: [
        {
          id: ID,
          name: 'Everest Foods',
          number: 'CUS-0001',
          panVatNo: '301234567',
          defaultCurrency: 'NPR',
        },
      ],
    });
    expect(mocks.listCustomers).toHaveBeenCalledWith(expect.anything(), {
      q: 'everest',
      limit: 20,
    });
  });

  it('lists nothing for blank text and asks the API nothing', async () => {
    const res = await ask('%20');
    expect(await res.json()).toEqual({ customers: [] });
    expect(mocks.listCustomers).not.toHaveBeenCalled();
  });

  it('refuses someone who may not record payments, and passes the sign-in answer on', async () => {
    mocks.can.mockReturnValue(false);
    expect((await ask('a')).status).toBe(403);
    expect(mocks.listCustomers).not.toHaveBeenCalled();
    mocks.routeSession.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await ask('a')).status).toBe(401);
  });
});
