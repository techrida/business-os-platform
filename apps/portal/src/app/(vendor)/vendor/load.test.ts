import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
const redirect = vi.fn((to: string): never => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

const { loadVendor, isUuid } = await import('./load');

beforeEach(() => {
  redirect.mockClear();
});

const refuse = (status: number) => () => Promise.reject(new ApiError(status, 'x'));

describe('loadVendor', () => {
  it('returns the data on success', async () => {
    expect(await loadVendor(() => Promise.resolve(42), '/vendor')).toEqual({
      kind: 'ok',
      data: 42,
    });
  });

  it('maps 403 to "forbidden" and 404 to "missing" without redirecting', async () => {
    expect(await loadVendor(refuse(403), '/vendor')).toEqual({ kind: 'forbidden' });
    expect(await loadVendor(refuse(404), '/vendor')).toEqual({ kind: 'missing' });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('sends a 401 to sign-in and comes back to the same page', async () => {
    await expect(loadVendor(refuse(401), '/vendor/bills')).rejects.toThrow(
      'NEXT_REDIRECT /auth/login?returnTo=%2Fvendor%2Fbills',
    );
  });

  it('rethrows anything else so error.tsx shows it', async () => {
    await expect(loadVendor(refuse(502), '/vendor')).rejects.toBeInstanceOf(ApiError);
    await expect(loadVendor(() => Promise.reject(new Error('boom')), '/vendor')).rejects.toThrow(
      'boom',
    );
  });
});

describe('isUuid', () => {
  it('accepts a UUID and refuses junk and path tricks', () => {
    expect(isUuid('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
    for (const bad of ['not-an-id', '../x', '', '0f8fad5b-d9cb-469f-a165-70867728950e/x']) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});
