import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import { listTaxCodes } from './api-tax-codes';
import type { Session } from './session';

vi.mock('server-only', () => ({}));
const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  apiFetch: api.apiFetch,
}));

const session = { roles: ['procurement'] } as Session;
const code = { id: '11111111-1111-4111-8111-111111111111', label: 'VAT 13%', rate: '13' };

beforeEach(() => vi.clearAllMocks());

describe('listTaxCodes', () => {
  it.each([false, true])('parses the tax registry (wrapped: %s)', async (wrapped) => {
    api.apiFetch.mockResolvedValue(Response.json(wrapped ? { items: [code] } : [code]));
    expect(await listTaxCodes(session)).toEqual([code]);
    expect(api.apiFetch).toHaveBeenCalledWith(session, '/v1/tax-codes', undefined);
  });

  it('keeps an empty registry distinct from a failed read', async () => {
    api.apiFetch.mockResolvedValue(Response.json([]));
    expect(await listTaxCodes(session)).toEqual([]);
    api.apiFetch.mockResolvedValue(
      Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }),
    );
    await expect(listTaxCodes(session)).rejects.toMatchObject({ status: 403 });
  });

  it('rejects malformed tax-code ids instead of passing them to forms', async () => {
    api.apiFetch.mockResolvedValue(Response.json([{ ...code, id: 'invalid' }]));
    const result = listTaxCodes(session);
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({ status: 502 });
  });
});
