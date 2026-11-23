import { beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ listVendors: vi.fn() }));
const bff = vi.hoisted(() => ({ routeSession: vi.fn() }));
const grants = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/lib/api-vendors', () => api);
vi.mock('@/lib/grants', () => ({
  getGrants: () => Promise.resolve(new Map()),
  hasGrant: () => grants.allowed,
}));
vi.mock('@/lib/bff', () => ({
  ...bff,
  jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
  errorResponse: () => Response.json({ error: { message: 'failed' } }, { status: 502 }),
}));

const { GET } = await import('./route');
const get = (q?: string) =>
  GET(
    new Request(`https://workspace.test/payables/vendor-search${q === undefined ? '' : `?q=${q}`}`),
  );

beforeEach(() => {
  api.listVendors.mockReset();
  bff.routeSession.mockResolvedValue({ roles: ['accountant'] });
  grants.allowed = true;
});

it('answers the matching vendors as picker options with the PAN as the description', async () => {
  api.listVendors.mockResolvedValue({
    items: [{ id: 'v1', legalName: 'Himal Traders', pan: '123456789' }],
    total: 1,
  });
  const res = await get('himal');
  expect(api.listVendors).toHaveBeenCalledWith(expect.anything(), {
    limit: 20,
    offset: 0,
    q: 'himal',
  });
  expect(await res.json()).toEqual({
    vendors: [{ id: 'v1', label: 'Himal Traders', description: 'PAN 123456789' }],
  });
});

it('asks nothing for an empty search and refuses a caller who cannot key in bills', async () => {
  expect(await (await get('')).json()).toEqual({ vendors: [] });
  expect(api.listVendors).not.toHaveBeenCalled();
  grants.allowed = false;
  expect((await get('x')).status).toBe(403);
});
