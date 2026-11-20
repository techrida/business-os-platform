// The portal BFF's milestone reads (F1-Q34): the paths, the bearer token, the strict schema (a staff field fails the
// parse as 502 instead of reaching a page) and the API's 404 passed through for the not-found page.
import type { PortalSalesOrder } from '@bos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import { getPortalSalesOrder, listPortalSalesOrders } from './api.billing';
import { callOf, ID, json, session, stubPortalEnv } from './billing-test-support';

vi.mock('server-only', () => ({}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  stubPortalEnv();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const order = (): PortalSalesOrder => ({
  id: ID,
  number: 'SO-2083/84-00001',
  status: 'confirmed',
  confirmedAt: '2026-11-02T04:00:00.000Z',
  currency: 'NPR',
  total: '1130.00',
  milestones: [
    {
      seq: 1,
      label: 'Advance 40%',
      percent: '40',
      amount: '452.00',
      plannedDate: null,
      status: 'invoiced',
      invoice: { id: ID, number: 'INV-2083/84-00001', dueDate: '2026-12-03' },
    },
  ],
});

async function statusOf(p: Promise<unknown>): Promise<number | undefined> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  return err instanceof ApiError ? err.status : undefined;
}

describe('milestone reads', () => {
  it('lists the orders from /v1/portal/sales-orders with the bearer token', async () => {
    fetchMock.mockResolvedValue(json([order()]));
    expect(await listPortalSalesOrders(session)).toEqual([order()]);
    const { url, headers } = callOf(fetchMock);
    expect(url).toBe('http://api:3001/v1/portal/sales-orders');
    expect(headers.get('authorization')).toBe(`Bearer ${session.accessToken}`);
  });

  it('reads one order by id, encoded as one path segment', async () => {
    fetchMock.mockResolvedValue(json(order()));
    expect((await getPortalSalesOrder(session, ID)).number).toBe('SO-2083/84-00001');
    expect(callOf(fetchMock).url).toBe(`http://api:3001/v1/portal/sales-orders/${ID}`);
  });

  it('refuses a body with a staff field as 502, and passes the 404 through', async () => {
    const leaky = order();
    fetchMock.mockResolvedValueOnce(
      json({ ...leaky, milestones: [{ ...leaky.milestones[0], amountNpr: '452.00' }] }),
    );
    expect(await statusOf(getPortalSalesOrder(session, ID))).toBe(502);
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'not_found' } }, 404));
    expect(await statusOf(getPortalSalesOrder(session, ID))).toBe(404);
  });
});
