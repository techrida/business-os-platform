import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { emptyValues, type BuilderValues } from './model';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 't', roles: ['sales'] })),
}));

const api = vi.hoisted(() => ({
  createQuotation: vi.fn(),
  updateDraft: vi.fn(),
  previewVersion: vi.fn(),
  submitVersion: vi.fn(),
}));
vi.mock('./api', () => api);

import { previewQuoteAction, saveDraftAction, submitQuoteAction } from './actions';

const QID = '11111111-1111-4111-8111-111111111111';
const VID = '22222222-2222-4222-8222-222222222222';
const TAX = '33333333-3333-4333-8333-333333333333';
const OPP = '55555555-5555-4555-8555-555555555555';
const ref = { quotationId: QID, versionId: VID };
const KEY = '44444444-4444-4444-8444-444444444444';
const submit = { ...ref, expectedVersion: 3, idempotencyKey: KEY };
const create = { mode: 'create', opportunityId: OPP, idempotencyKey: KEY } as const;

function values(): BuilderValues {
  const v = emptyValues({ currency: 'NPR', issueDate: '2026-11-08', validUntil: '2026-12-08' });
  v.lines = [
    { key: 'l1', description: 'Work', uom: 'lot', quantity: '1', unitPrice: '100', taxCodeId: TAX },
  ];
  return v;
}

const m = (percent: string) => ({ key: percent, label: 'Milestone', percent, dueDescription: '' });

const apiError = (status: number, code: string) =>
  new ApiError(status, 'x', { error: { code, message: 'm', correlationId: 'c' } });

/** What the API sends for the idempotency guard's 409s (platform/db/idempotency.ts): code `conflict`, header named in the text. */
const inProgress = (message: string) =>
  new ApiError(409, 'x', { error: { code: 'conflict', message, correlationId: 'c' } });
const IN_PROGRESS = [
  'The first request with this Idempotency-Key did not finish',
  'This Idempotency-Key was released while it was being checked',
];

beforeEach(() => vi.clearAllMocks());

describe('submitQuoteAction', () => {
  it('does not call the API when the payment schedule does not total 100%', async () => {
    const v = values();
    v.schedule = [m('60'), m('30')];
    const res = await submitQuoteAction({ ...submit, values: v });
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.message).toMatch(/100%/);
    expect(api.submitVersion).not.toHaveBeenCalled();
  });

  it('submits a complete draft with the row version the page saw', async () => {
    const v = values();
    v.schedule = [m('60'), m('40')];
    api.submitVersion.mockResolvedValue({ status: 'submitted' });
    const res = await submitQuoteAction({ ...submit, values: v });
    expect(res.ok).toBe(true);
    expect(api.submitVersion).toHaveBeenCalledWith(expect.anything(), QID, VID, 3, KEY, undefined);
  });

  it('passes the chosen approver through, and refuses one that is not an id', async () => {
    const v = values();
    v.schedule = [m('60'), m('40')];
    api.submitVersion.mockResolvedValue({ status: 'submitted' });
    const res = await submitQuoteAction({ ...submit, values: v, approverUserId: OPP });
    expect(res.ok).toBe(true);
    expect(api.submitVersion).toHaveBeenCalledWith(expect.anything(), QID, VID, 3, KEY, OPP);

    api.submitVersion.mockClear();
    const bad = await submitQuoteAction({ ...submit, values: v, approverUserId: 'someone' });
    expect(bad.ok).toBe(false);
    expect(api.submitVersion).not.toHaveBeenCalled();
  });

  it('keeps the key after a 5xx and rotates it after a 4xx', async () => {
    const v = values();
    v.schedule = [m('60'), m('40')];
    api.submitVersion.mockRejectedValueOnce(new ApiError(502, 'bad gateway'));
    expect(await submitQuoteAction({ ...submit, values: v })).toMatchObject({ key: KEY });

    api.submitVersion.mockRejectedValueOnce(apiError(409, 'VERSION_CONFLICT'));
    const res = await submitQuoteAction({ ...submit, values: v });
    expect(res.ok ? '' : res.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.ok ? '' : res.key).not.toBe(KEY);
  });

  it('keeps the key after the in-progress idempotency 409, so the retry replays', async () => {
    const v = values();
    v.schedule = [m('60'), m('40')];
    for (const message of IN_PROGRESS) {
      api.submitVersion.mockRejectedValueOnce(inProgress(message));
      expect(await submitQuoteAction({ ...submit, values: v })).toMatchObject({
        ok: false,
        key: KEY,
      });
    }
  });

  it('rotates the key after the idempotency 422 (same key, different content)', async () => {
    const v = values();
    v.schedule = [m('60'), m('40')];
    api.submitVersion.mockRejectedValueOnce(
      new ApiError(422, 'x', {
        error: {
          code: 'bad_request',
          message: 'This Idempotency-Key was already used for a different request',
          correlationId: 'c',
        },
      }),
    );
    const res = await submitQuoteAction({ ...submit, values: v });
    expect(res.ok ? '' : res.key).not.toBe(KEY);
  });

  it('words a refusal for a 0.00 instalment plainly and puts it on the payment schedule (FR-4)', async () => {
    const v = values();
    v.schedule = [m('99.99'), m('0.01')];
    api.submitVersion.mockRejectedValueOnce(
      new ApiError(422, 'x', {
        error: {
          code: 'PAYMENT_INSTALMENT_ZERO',
          message: 'Milestone 2 would be an instalment of 0.00',
          correlationId: 'c',
        },
      }),
    );
    const res = await submitQuoteAction({ ...submit, values: v });
    const words =
      'At least one payment milestone would come to 0.00 at this total. Remove that milestone or raise its share, then submit again. Nothing was submitted.';
    expect(res).toMatchObject({
      ok: false,
      kind: 'invalid',
      message: words,
      fieldErrors: { paymentSchedule: words },
    });
  });

  it('asks for a reload on a stale row version (409)', async () => {
    api.submitVersion.mockRejectedValue(apiError(409, 'VERSION_CONFLICT'));
    const res = await submitQuoteAction({ ...submit, values: values() });
    expect(res).toMatchObject({ ok: false, kind: 'stale' });
  });

  it('gives a clear message for a stale exchange rate (409)', async () => {
    api.submitVersion.mockRejectedValue(apiError(409, 'FX_RATE_STALE'));
    const v = values();
    v.currency = 'USD';
    const res = await submitQuoteAction({ ...submit, values: v });
    expect(res).toMatchObject({ ok: false, kind: 'stale_fx' });
    expect(res.ok ? '' : res.message).toMatch(/exchange rate/i);
  });
});

describe('previewQuoteAction', () => {
  it('returns the server preview and sends the lines as typed, never a total', async () => {
    api.previewVersion.mockResolvedValue({
      totals: {
        subtotal: '100.00',
        discountAmount: '0.00',
        taxableAmount: '100.00',
        taxAmount: '13.00',
        total: '113.00',
        effectiveDiscountPct: '0.0000',
      },
      taxSummary: [],
      route: { steps: [], blocked: false },
    });
    const res = await previewQuoteAction({ ...ref, values: values() });
    expect(res.ok).toBe(true);
    const body = api.previewVersion.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['currency', 'lines']);
  });

  it('reports incomplete lines without calling the API', async () => {
    const v = values();
    v.lines[0]!.quantity = '';
    const res = await previewQuoteAction({ ...ref, values: v });
    expect(res).toMatchObject({ ok: false, kind: 'invalid' });
    expect(api.previewVersion).not.toHaveBeenCalled();
  });
});

describe('saveDraftAction', () => {
  it('refuses to save a schedule that does not total 100%', async () => {
    const v = values();
    v.schedule = [m('50')];
    const res = await saveDraftAction({ ...create, values: v });
    expect(res.ok).toBe(false);
    expect(api.createQuotation).not.toHaveBeenCalled();
  });

  it('creates the draft with the page key and returns its id, without redirecting itself (TR-Q8)', async () => {
    api.createQuotation.mockResolvedValue({ id: QID, version: 1 });
    await expect(saveDraftAction({ ...create, values: values() })).resolves.toEqual({
      ok: true,
      version: 1,
      createdId: QID,
    });
    expect(api.createQuotation).toHaveBeenCalledWith(expect.anything(), expect.anything(), KEY);
  });

  it('keeps the key after a 5xx or a timeout, so a retry cannot create a second quotation', async () => {
    api.createQuotation.mockRejectedValueOnce(new ApiError(503, 'down'));
    const first = await saveDraftAction({ ...create, values: values() });
    expect(first).toMatchObject({ ok: false, key: KEY });

    api.createQuotation.mockRejectedValueOnce(new TypeError('fetch failed'));
    const second = await saveDraftAction({ ...create, values: values() });
    expect(second).toMatchObject({ ok: false, key: KEY });
  });

  it('rotates the key after a definite 4xx, so the next try is a new request', async () => {
    api.createQuotation.mockRejectedValue(apiError(422, 'VALIDATION'));
    const res = await saveDraftAction({ ...create, values: values() });
    expect(res.ok).toBe(false);
    const next = res.ok ? '' : (res.key ?? '');
    expect(next).toMatch(/^[0-9a-f-]{36}$/);
    expect(next).not.toBe(KEY);
  });

  it('keeps the key after the in-progress idempotency 409, so a retry cannot create a second quotation', async () => {
    for (const message of IN_PROGRESS) {
      api.createQuotation.mockRejectedValueOnce(inProgress(message));
      const res = await saveDraftAction({ ...create, values: values() });
      expect(res).toMatchObject({ ok: false, kind: 'error', key: KEY });
    }
  });

  it('keeps the unused key when the form is refused before any call', async () => {
    const v = values();
    v.schedule = [m('50')];
    const res = await saveDraftAction({ ...create, values: v });
    expect(res).toMatchObject({ ok: false, key: KEY });
  });

  it('updates with expectedVersion and returns the new row version', async () => {
    api.updateDraft.mockResolvedValue({ version: 4 });
    const res = await saveDraftAction({
      mode: 'update',
      ...ref,
      expectedVersion: 3,
      values: values(),
    });
    expect(res).toEqual({ ok: true, version: 4 });
    // A blank field is sent as null so the save clears it; the API keeps any key it is not sent.
    expect(api.updateDraft.mock.calls[0]?.[3]).toMatchObject({
      expectedVersion: 3,
      discount: null,
      scope: null,
    });
  });
});
