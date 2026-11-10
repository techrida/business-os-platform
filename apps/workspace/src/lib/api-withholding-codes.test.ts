import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listWithholdingCodes } from './api-withholding-codes';
import type { Session } from './session';

vi.mock('server-only', () => ({}));
const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  apiFetch: api.apiFetch,
}));
const session = { roles: ['accountant'] } as Session;
const row = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'TDS0',
  name: 'Pending accountant signoff',
  rateBp: 0,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
};
beforeEach(() => vi.clearAllMocks());

describe('listWithholdingCodes', () => {
  it('parses named codes and passes the staff session', async () => {
    api.apiFetch.mockResolvedValue(Response.json([row]));
    expect(await listWithholdingCodes(session)).toEqual([row]);
    expect(api.apiFetch).toHaveBeenCalledWith(session, '/v1/withholding-codes', undefined);
  });
  it('preserves an empty result and refuses malformed code IDs', async () => {
    api.apiFetch.mockResolvedValue(Response.json([]));
    expect(await listWithholdingCodes(session)).toEqual([]);
    api.apiFetch.mockResolvedValue(Response.json([{ ...row, id: 'bad' }]));
    await expect(listWithholdingCodes(session)).rejects.toMatchObject({ status: 502 });
  });
  it('preserves permission failures instead of showing no withholding', async () => {
    api.apiFetch.mockResolvedValue(
      Response.json({ error: { code: 'forbidden' } }, { status: 403 }),
    );
    await expect(listWithholdingCodes(session)).rejects.toMatchObject({ status: 403 });
  });
});
