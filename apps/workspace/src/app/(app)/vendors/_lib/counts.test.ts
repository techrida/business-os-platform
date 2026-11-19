import { VENDOR_STATUSES } from '@bos/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
const api = vi.hoisted(() => ({ listVendors: vi.fn() }));
vi.mock('@/lib/api-vendors', () => api);

const { countVendorsByBucket, statusesIn, VENDOR_BUCKETS } = await import('./counts');

const session = { roles: ['procurement'] } as unknown as Session;

beforeEach(() => vi.clearAllMocks());

describe('vendor status buckets', () => {
  it('puts every status in exactly one bucket, so the cards add up to the register', () => {
    const covered = VENDOR_BUCKETS.flatMap(statusesIn);
    expect([...covered].sort()).toEqual([...VENDOR_STATUSES].sort());
    expect(new Set(covered).size).toBe(VENDOR_STATUSES.length);
  });

  it('reads each bucket total from one-row list calls and sums them', async () => {
    api.listVendors.mockImplementation((_s: unknown, q: { status: string[] }) =>
      Promise.resolve({ items: [], total: q.status.length * 10 }),
    );
    expect(await countVendorsByBucket(session)).toEqual({
      approved: 10,
      onboarding: 30,
      inactive: 30,
      total: 70,
    });
    for (const call of api.listVendors.mock.calls) expect(call[1]).toMatchObject({ limit: 1 });
  });

  it('is null, not zero, when any count fails', async () => {
    api.listVendors
      .mockResolvedValueOnce({ items: [], total: 1 })
      .mockRejectedValueOnce(new ApiError(403, 'x', {}))
      .mockResolvedValueOnce({ items: [], total: 1 });
    expect(await countVendorsByBucket(session)).toBeNull();
  });
});
