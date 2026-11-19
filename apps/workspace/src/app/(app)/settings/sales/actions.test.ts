import { LOST_REASONS_STALE_MESSAGE, lostReasonsToken } from '@bos/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
const revalidatePath = vi.fn<(path: string, type?: string) => void>();
vi.mock('next/cache', () => ({
  revalidatePath: (path: string, type?: string) => revalidatePath(path, type),
}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));

const apiMocks = vi.hoisted(() => ({
  createLeadLostReason: vi.fn(),
  reorderLeadLostReasons: vi.fn(),
  resetLeadLostReasons: vi.fn(),
  updateLeadLostReason: vi.fn(),
}));
vi.mock('@/lib/api-lead-lost-reasons', () => apiMocks);

const { ApiError } = await import('@/lib/api');
const { reorderLostReasonsAction, resetLostReasonsAction, setLostReasonRetiredAction } =
  await import('./actions');

const founder: Session = { accessToken: 't', orgKind: 'staff', roles: ['founder'] } as Session;
const sales: Session = { accessToken: 't', orgKind: 'staff', roles: ['sales'] } as Session;

const ID_A = '00000000-0000-4000-8000-000000000001';
const ID_B = '00000000-0000-4000-8000-000000000002';
const TOKEN = lostReasonsToken([
  { id: ID_A, position: 0, version: 1, retired: false },
  { id: ID_B, position: 1, version: 1, retired: false },
]);

const staleError = () =>
  new ApiError(409, 'PUT failed with 409', {
    error: {
      code: 'conflict',
      message: LOST_REASONS_STALE_MESSAGE,
      correlationId: 'req-12345678',
    },
  });

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue(founder);
  revalidatePath.mockReset();
  for (const fn of Object.values(apiMocks)) fn.mockReset();
});

describe('reorderLostReasonsAction', () => {
  it('sends the new ids order and current token, revalidates, and returns ok', async () => {
    apiMocks.reorderLeadLostReasons.mockResolvedValue([]);
    await expect(reorderLostReasonsAction([ID_B, ID_A], TOKEN)).resolves.toEqual({
      status: 'ok',
      message: 'Order saved.',
    });
    expect(apiMocks.reorderLeadLostReasons).toHaveBeenCalledExactlyOnceWith(founder, {
      ids: [ID_B, ID_A],
      expectedOrder: TOKEN,
    });
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith('/settings/sales', undefined);
  });

  it('keeps the page and returns the exact stale message on a stale 409', async () => {
    apiMocks.reorderLeadLostReasons.mockRejectedValue(staleError());
    await expect(reorderLostReasonsAction([ID_B, ID_A], '00000000000000')).resolves.toEqual({
      status: 'error',
      message: LOST_REASONS_STALE_MESSAGE,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('fails closed on an empty token or invalid ids without calling the API', async () => {
    await expect(reorderLostReasonsAction([ID_B, ID_A], '')).resolves.toEqual({
      status: 'error',
      message: LOST_REASONS_STALE_MESSAGE,
    });
    await expect(reorderLostReasonsAction(['not-a-uuid'], TOKEN)).resolves.toEqual({
      status: 'error',
      message: LOST_REASONS_STALE_MESSAGE,
    });
    expect(apiMocks.reorderLeadLostReasons).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses a user without the sales settings permission', async () => {
    getSession.mockResolvedValue(sales);
    await expect(reorderLostReasonsAction([ID_B, ID_A], TOKEN)).rejects.toThrow(
      'REDIRECT:/settings/denied',
    );
    expect(apiMocks.reorderLeadLostReasons).not.toHaveBeenCalled();
  });
});

describe('resetLostReasonsAction', () => {
  it('sends the current token, revalidates, and returns ok', async () => {
    apiMocks.resetLeadLostReasons.mockResolvedValue([]);
    await expect(resetLostReasonsAction(TOKEN)).resolves.toEqual({
      status: 'ok',
      message: 'Lost reasons are back to the defaults.',
    });
    expect(apiMocks.resetLeadLostReasons).toHaveBeenCalledExactlyOnceWith(founder, {
      expectedOrder: TOKEN,
    });
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith('/settings/sales', undefined);
  });

  it('keeps the page and returns the exact stale message on a stale 409', async () => {
    apiMocks.resetLeadLostReasons.mockRejectedValue(staleError());
    await expect(resetLostReasonsAction('00000000000000')).resolves.toEqual({
      status: 'error',
      message: LOST_REASONS_STALE_MESSAGE,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('fails closed on an empty token without calling the API', async () => {
    await expect(resetLostReasonsAction('')).resolves.toEqual({
      status: 'error',
      message: LOST_REASONS_STALE_MESSAGE,
    });
    expect(apiMocks.resetLeadLostReasons).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses a user without the sales settings permission', async () => {
    getSession.mockResolvedValue(sales);
    await expect(resetLostReasonsAction(TOKEN)).rejects.toThrow('REDIRECT:/settings/denied');
    expect(apiMocks.resetLeadLostReasons).not.toHaveBeenCalled();
  });
});

describe('setLostReasonRetiredAction', () => {
  it('mentions both leads and opportunities when a reason is retired', async () => {
    apiMocks.updateLeadLostReason.mockResolvedValue({});
    await expect(setLostReasonRetiredAction(ID_A, true, 2)).resolves.toEqual({
      status: 'ok',
      message: 'Reason retired. Leads and opportunities that used it keep it.',
    });
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith('/settings/sales', undefined);
  });
});
