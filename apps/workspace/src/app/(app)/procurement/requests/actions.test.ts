import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['procurement'] as string[] }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: session.roles }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

const api = vi.hoisted(() => ({
  createPurchaseRequest: vi.fn(),
  updatePurchaseRequest: vi.fn(),
  submitPurchaseRequest: vi.fn(),
  cancelPurchaseRequest: vi.fn(),
}));
vi.mock('@/lib/api-procurement', () => api);

const { cancelPrAction, createPrAction, submitPrAction, updatePrAction } =
  await import('./actions');
const { commandStart } = await import('./_lib/state');

const ID = '11111111-1111-4111-8111-111111111111';
const DEPT = '22222222-2222-4222-8222-222222222222';
const COST = '33333333-3333-4333-8333-333333333333';
const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const apiError = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError(status, 'x', {
    error: { code, message: 'The API wording.', correlationId: 'corr-12345678', ...extra },
  });

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const prForm = {
  idempotencyKey: KEY,
  requestType: 'goods',
  departmentId: DEPT,
  costCenterId: COST,
  justification: 'Chairs for the new office',
  requiredBy: '2026-12-01',
  budgetCode: 'OPS-26',
  currency: 'NPR',
  'lines.0.description': 'Chair',
  'lines.0.uom': 'pcs',
  'lines.0.quantity': '10',
  'lines.0.estimatedUnitPrice': '4500.00',
};
const start = { key: KEY, errors: {} };

beforeEach(() => {
  vi.clearAllMocks();
  session.roles = ['procurement'];
});

describe('createPrAction', () => {
  it('sends the contract body with the form key and goes to the new request', async () => {
    api.createPurchaseRequest.mockResolvedValue({ id: ID });
    await expect(createPrAction(start, form(prForm))).rejects.toThrow(
      `redirect /procurement/requests/${ID}?created=1`,
    );
    expect(api.createPurchaseRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requestType: 'goods',
        departmentId: DEPT,
        costCenterId: COST,
        isEmergency: false,
        lines: [{ description: 'Chair', uom: 'pcs', quantity: '10', estimatedUnitPrice: '4500' }],
      }),
      KEY,
    );
  });

  it.each(['costCenterId', 'departmentId'])(
    'requires %s through normal validation before calling the API',
    async (field) => {
      const result = await createPrAction(start, form({ ...prForm, [field]: '' }));
      expect(result.errors[field]).toBeTruthy();
      expect(api.createPurchaseRequest).not.toHaveBeenCalled();
    },
  );

  it('refuses without procurement.pr.create and never calls the API', async () => {
    session.roles = ['finance'];
    const r = await createPrAction(start, form(prForm));
    expect(r.error).toMatch(/do not include raising purchase requests/);
    expect(api.createPurchaseRequest).not.toHaveBeenCalled();
  });

  it('shows contract errors on the fields and keeps the key (nothing was sent)', async () => {
    const r = await createPrAction(start, form({ ...prForm, 'lines.0.quantity': '0' }));
    expect(r.errors['lines.0.quantity']).toMatch(/above zero/);
    expect(r.key).toBe(KEY);
    expect(api.createPurchaseRequest).not.toHaveBeenCalled();
  });

  it('an emergency request without a reason never reaches the API', async () => {
    const r = await createPrAction(start, form({ ...prForm, isEmergency: 'on' }));
    expect(r.errors.emergencyReason).toBeDefined();
    expect(api.createPurchaseRequest).not.toHaveBeenCalled();
  });

  it('a 400 is final: it names the problem and rotates the key', async () => {
    api.createPurchaseRequest.mockRejectedValue(
      apiError(400, 'bad_request', { message: 'Unknown department' }),
    );
    const r = await createPrAction(start, form(prForm));
    expect(r.error).toContain('Unknown department');
    expect(r.key).not.toBe(KEY);
  });

  it('a timeout, a 5xx and the in-progress 409 keep the same key (replay, never a second request)', async () => {
    for (const err of [
      new Error('fetch failed'),
      new ApiError(503, 'x'),
      apiError(409, 'conflict', {
        message: 'A request with this Idempotency-Key is still in progress',
      }),
    ]) {
      api.createPurchaseRequest.mockRejectedValueOnce(err);
      const r = await createPrAction(start, form(prForm));
      expect(r.key).toBe(KEY);
      expect(r.error).toBeDefined();
    }
  });
});

describe('updatePrAction', () => {
  const edit = { ...prForm, prId: ID, expectedVersion: '3' };

  it('replaces the draft with the form body, the version seen and the form key', async () => {
    api.updatePurchaseRequest.mockResolvedValue({ id: ID });
    await expect(updatePrAction(start, form(edit))).rejects.toThrow(
      `redirect /procurement/requests/${ID}?saved=1`,
    );
    expect(api.updatePurchaseRequest).toHaveBeenCalledWith(
      expect.anything(),
      ID,
      expect.objectContaining({ departmentId: DEPT }),
      KEY,
      3,
    );
  });

  it('a request that was submitted meanwhile (409) says reload', async () => {
    api.updatePurchaseRequest.mockRejectedValue(apiError(409, 'conflict'));
    const r = await updatePrAction(start, form(edit));
    expect(r.reload).toBe(true);
    expect(r.error).toMatch(/submitted or changed/);
    expect(r.key).not.toBe(KEY);
  });

  it('a form without a valid request id or version asks for a reload', async () => {
    const r = await updatePrAction(start, form({ ...edit, prId: 'nope' }));
    expect(r.reload).toBe(true);
    expect(api.updatePurchaseRequest).not.toHaveBeenCalled();
    const r2 = await updatePrAction(start, form({ ...edit, expectedVersion: '' }));
    expect(r2.reload).toBe(true);
  });
});

describe('submitPrAction', () => {
  const cmd = { prId: ID, expectedVersion: '2', idempotencyKey: KEY };

  it('submits with the key and the version the person saw', async () => {
    api.submitPurchaseRequest.mockResolvedValue({ id: ID, status: 'submitted' });
    const r = await submitPrAction(commandStart(KEY), form(cmd));
    expect(api.submitPurchaseRequest).toHaveBeenCalledWith(expect.anything(), ID, KEY, 2);
    expect(r.saved).toMatch(/sent to the department head/);
    expect(r.count).toBe(1);
  });

  it('shows 422 NO_ELIGIBLE_APPROVER plainly and rotates the key', async () => {
    api.submitPurchaseRequest.mockRejectedValue(
      apiError(422, 'NO_ELIGIBLE_APPROVER', {
        message: 'This purchase request cannot be submitted: no department head.',
      }),
    );
    const r = await submitPrAction(commandStart(KEY), form(cmd));
    expect(r.error).toContain('no department head');
    expect(r.saved).toBeUndefined();
    expect(r.key).not.toBe(KEY);
  });

  it('keeps the key on a 5xx so a retry replays the first call', async () => {
    api.submitPurchaseRequest.mockRejectedValue(new ApiError(502, 'x'));
    const r = await submitPrAction(commandStart(KEY), form(cmd));
    expect(r.key).toBe(KEY);
  });

  it('keeps the key on the in-progress 409', async () => {
    api.submitPurchaseRequest.mockRejectedValue(
      apiError(409, 'conflict', {
        message: 'A request with this Idempotency-Key is still in progress',
      }),
    );
    const r = await submitPrAction(commandStart(KEY), form(cmd));
    expect(r.key).toBe(KEY);
    expect(r.reload).toBeFalsy();
  });

  it('a stale status (409) asks for a reload', async () => {
    api.submitPurchaseRequest.mockRejectedValue(apiError(409, 'conflict'));
    const r = await submitPrAction(commandStart(KEY), form(cmd));
    expect(r.reload).toBe(true);
  });

  it('refuses without procurement.pr.create and never calls the API', async () => {
    session.roles = ['finance'];
    const r = await submitPrAction(commandStart(KEY), form(cmd));
    expect(r.error).toMatch(/do not include raising purchase requests/);
    expect(api.submitPurchaseRequest).not.toHaveBeenCalled();
  });

  it('a form without a valid id asks for a reload', async () => {
    const r = await submitPrAction(commandStart(KEY), form({ ...cmd, prId: 'x' }));
    expect(r.reload).toBe(true);
    expect(api.submitPurchaseRequest).not.toHaveBeenCalled();
  });
});

describe('cancelPrAction', () => {
  const cmd = { prId: ID, expectedVersion: '1', idempotencyKey: KEY };

  it('cancels a draft with the key', async () => {
    api.cancelPurchaseRequest.mockResolvedValue({ id: ID, status: 'cancelled' });
    const r = await cancelPrAction(commandStart(KEY), form(cmd));
    expect(api.cancelPurchaseRequest).toHaveBeenCalledWith(expect.anything(), ID, KEY, 1);
    expect(r.saved).toMatch(/cancelled/);
  });

  it('a request that is no longer a draft (409) says so and offers a reload', async () => {
    api.cancelPurchaseRequest.mockRejectedValue(apiError(409, 'conflict'));
    const r = await cancelPrAction(commandStart(KEY), form(cmd));
    expect(r.reload).toBe(true);
    expect(r.error).toMatch(/Only a draft/);
  });
});
