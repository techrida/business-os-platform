import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['procurement'] as string[] }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: session.roles }),
}));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock('next/cache', () => cache);
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

const api = vi.hoisted(() => ({
  createRfq: vi.fn(),
  recordQuotation: vi.fn(),
  convertSubmission: vi.fn(),
  scoreQuotation: vi.fn(),
  recommendQuotation: vi.fn(),
  commitRfq: vi.fn(),
  extendRfqDeadline: vi.fn(),
}));
vi.mock('@/lib/api-rfqs', () => api);

const {
  commitRfqAction,
  createRfqAction,
  extendDeadlineAction,
  recommendQuotationAction,
  recordQuotationAction,
  scoreQuotationAction,
} = await import('./actions');

const RFQ = '11111111-1111-4111-8111-111111111111';
const PR = '22222222-2222-4222-8222-222222222222';
const V1 = '33333333-3333-4333-8333-333333333333';
const V2 = '44444444-4444-4444-8444-444444444444';
const TAX = '55555555-5555-4555-8555-555555555555';
const DOC = '66666666-6666-4666-8666-666666666666';
const SUB = '77777777-7777-4777-8777-777777777777';
const LINE = '88888888-8888-4888-8888-888888888888';
const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const apiError = (status: number, code: string, message = 'The API wording.') =>
  new ApiError(status, 'x', { error: { code, message, correlationId: 'corr-12345678' } });

function form(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

const start = { key: KEY, errors: {} };
const rfqEntries: [string, string][] = [
  ['idempotencyKey', KEY],
  ['purchaseRequestId', PR],
  ['deadline', '2030-12-01T17:30'],
  ['vendorIds', V1],
  ['vendorIds', V2],
];
const quoteEntries: [string, string][] = [
  ['idempotencyKey', KEY],
  ['rfqId', RFQ],
  ['mode', 'record'],
  ['vendorId', V1],
  ['documentId', DOC],
  ['currency', 'NPR'],
  ['lines.0.include', 'on'],
  ['lines.0.prLineId', LINE],
  ['lines.0.quantity', '10'],
  ['lines.0.unitPrice', '450000.00'],
  ['lines.0.taxCodeId', TAX],
];

beforeEach(() => {
  vi.clearAllMocks();
  session.roles = ['procurement'];
});

describe('createRfqAction', () => {
  it('sends the contract body in Kathmandu time with the form key, then opens the RFQ', async () => {
    api.createRfq.mockResolvedValue({ id: RFQ });
    await expect(createRfqAction(start, form(rfqEntries))).rejects.toThrow(
      `redirect /procurement/rfqs/${RFQ}?created=1`,
    );
    expect(api.createRfq).toHaveBeenCalledWith(
      expect.anything(),
      { purchaseRequestId: PR, deadline: '2030-12-01T17:30:00+05:45', vendorIds: [V1, V2] },
      KEY,
    );
  });

  it('refreshes the RFQ list and the purchase request, which moves to sourcing', async () => {
    api.createRfq.mockResolvedValue({ id: RFQ });
    await createRfqAction(start, form(rfqEntries)).catch(() => undefined);
    const paths = cache.revalidatePath.mock.calls.map((c) => String(c[0]));
    expect(paths).toContain('/procurement/rfqs');
    expect(paths).toContain(`/procurement/requests/${PR}`);
  });

  it('does not call the API when the form is incomplete, and says what is missing', async () => {
    const r = await createRfqAction(start, form([['idempotencyKey', KEY]]));
    expect(api.createRfq).not.toHaveBeenCalled();
    expect(r.errors.vendorIds).toBeDefined();
    expect(r.key).toBe(KEY);
  });

  it('refuses a past deadline next to the field without calling the API (I-28)', async () => {
    const entries = rfqEntries.map(([k, v]): [string, string] =>
      k === 'deadline' ? [k, '2020-01-01T17:00'] : [k, v],
    );
    const r = await createRfqAction(start, form(entries));
    expect(api.createRfq).not.toHaveBeenCalled();
    expect(r.errors.deadline).toBe(
      'The quotation deadline has passed. Choose a date and time in the future.',
    );
    expect(r.key).toBe(KEY);
  });

  it("puts the API's 400 deadline_in_past next to the deadline field (I-28)", async () => {
    api.createRfq.mockRejectedValue(
      new ApiError(400, 'x', {
        error: {
          code: 'bad_request',
          reason: 'deadline_in_past',
          message: 'The quotation deadline has passed. Choose a date and time in the future.',
          correlationId: 'corr-12345678',
        },
      }),
    );
    const r = await createRfqAction(start, form(rfqEntries));
    expect(r.errors.deadline).toBe(
      'The quotation deadline has passed. Choose a date and time in the future.',
    );
    expect(r.error).toBeUndefined();
    expect(r.key).not.toBe(KEY);
  });

  it('refuses a person without the sourcing grant before any call', async () => {
    session.roles = ['sales'];
    const r = await createRfqAction(start, form(rfqEntries));
    expect(api.createRfq).not.toHaveBeenCalled();
    expect(r.error).toMatch(/roles do not include/);
  });

  it('shows the API reason for an unapproved vendor and rotates the key', async () => {
    api.createRfq.mockRejectedValue(
      apiError(409, 'VENDOR_NOT_APPROVED', 'Vendor 3333 is not approved'),
    );
    const r = await createRfqAction(start, form(rfqEntries));
    expect(r.error).toContain('Vendor 3333 is not approved');
    expect(r.key).not.toBe(KEY);
  });

  it('a timeout, a 5xx and the in-progress 409 keep the key', async () => {
    api.createRfq.mockRejectedValue(new ApiError(503, 'x'));
    expect((await createRfqAction(start, form(rfqEntries))).key).toBe(KEY);
    api.createRfq.mockRejectedValue(
      apiError(409, 'conflict', 'A request with this Idempotency-Key is still in progress'),
    );
    const r = await createRfqAction(start, form(rfqEntries));
    expect(r.key).toBe(KEY);
    expect(r.reload).toBeFalsy();
  });
});

describe('recordQuotationAction', () => {
  it('records the quotation for the RFQ, sending no expectedVersion', async () => {
    api.recordQuotation.mockResolvedValue({ id: SUB });
    await expect(recordQuotationAction(start, form(quoteEntries))).rejects.toThrow(
      `redirect /procurement/rfqs/${RFQ}?quoted=1`,
    );
    const [, id, body, key] = api.recordQuotation.mock.calls[0] as unknown[];
    expect(id).toBe(RFQ);
    expect(key).toBe(KEY);
    expect(body).toEqual({
      vendorId: V1,
      documentId: DOC,
      currency: 'NPR',
      lines: [{ prLineId: LINE, quantity: '10', unitPrice: '450000', taxCodeId: TAX }],
    });
    expect(api.convertSubmission).not.toHaveBeenCalled();
  });

  it('converts a submission with the submission id and no vendor or document', async () => {
    api.convertSubmission.mockResolvedValue({ id: SUB });
    const entries = quoteEntries
      .filter(([k]) => k !== 'vendorId' && k !== 'documentId' && k !== 'mode')
      .concat([
        ['mode', 'convert'],
        ['submissionId', SUB],
      ]);
    await recordQuotationAction(start, form(entries)).catch(() => undefined);
    const [, id, body] = api.convertSubmission.mock.calls[0] as unknown[];
    expect(id).toBe(RFQ);
    expect(body).toHaveProperty('submissionId', SUB);
    expect(body).not.toHaveProperty('vendorId');
    expect(api.recordQuotation).not.toHaveBeenCalled();
  });

  it('an unscanned file (409) shows the API sentence and rotates the key', async () => {
    api.convertSubmission.mockRejectedValue(
      apiError(409, 'conflict', 'The submitted file has not scanned clean'),
    );
    const entries = quoteEntries
      .concat([['submissionId', SUB]])
      .map(([k, v]) =>
        k === 'mode' ? ([k, 'convert'] as [string, string]) : ([k, v] as [string, string]),
      );
    const r = await recordQuotationAction(start, form(entries));
    expect(r.error).toContain('has not scanned clean');
    expect(r.key).not.toBe(KEY);
  });

  it('keeps the key on a 5xx', async () => {
    api.recordQuotation.mockRejectedValue(new ApiError(502, 'x'));
    expect((await recordQuotationAction(start, form(quoteEntries))).key).toBe(KEY);
  });

  it('refuses a form without a real RFQ id and a person without the grant', async () => {
    const bad = quoteEntries.map(([k, v]) =>
      k === 'rfqId' ? ([k, 'nope'] as [string, string]) : ([k, v] as [string, string]),
    );
    const r = await recordQuotationAction(start, form(bad));
    expect(r.reload).toBe(true);
    session.roles = ['sales'];
    const r2 = await recordQuotationAction(start, form(quoteEntries));
    expect(r2.error).toMatch(/roles do not include/);
    expect(api.recordQuotation).not.toHaveBeenCalled();
  });

  it('shows field errors without calling the API', async () => {
    const entries = quoteEntries.map(([k, v]) =>
      k === 'lines.0.unitPrice' ? ([k, '1.234'] as [string, string]) : ([k, v] as [string, string]),
    );
    const r = await recordQuotationAction(start, form(entries));
    expect(r.errors['lines.0.unitPrice']).toMatch(/2 decimal places/);
    expect(api.recordQuotation).not.toHaveBeenCalled();
  });
});

const QUOTE = '99999999-9999-4999-8999-999999999999';
const IN_PROGRESS = apiError(
  409,
  'conflict',
  'A request with this Idempotency-Key is still in progress',
);

describe('the Idempotency-Key rule across every RFQ write', () => {
  it('keeps the key on 408 and 429 as well as 5xx, and rotates it on other 4xx', async () => {
    for (const status of [408, 429, 500, 503]) {
      api.createRfq.mockRejectedValue(new ApiError(status, 'x'));
      expect((await createRfqAction(start, form(rfqEntries))).key).toBe(KEY);
    }
    for (const status of [400, 403, 404, 422]) {
      api.createRfq.mockRejectedValue(apiError(status, 'x'));
      expect((await createRfqAction(start, form(rfqEntries))).key).not.toBe(KEY);
    }
  });
  it('record: 429 keeps the key', async () => {
    api.recordQuotation.mockRejectedValue(new ApiError(429, 'x'));
    expect((await recordQuotationAction(start, form(quoteEntries))).key).toBe(KEY);
  });
});

describe('scoreQuotationAction', () => {
  const scoreStart = { key: KEY, errors: {}, count: 0 };
  const entries: [string, string][] = [
    ['idempotencyKey', KEY],
    ['rfqId', RFQ],
    ['quotationId', QUOTE],
    ['scores.0.criterion', 'Price'],
    ['scores.0.score', '80'],
    ['scores.1.criterion', 'Delivery'],
    ['scores.1.score', '72.5'],
  ];
  const swap = (name: string, value: string): [string, string][] =>
    entries.map(([k, v]) => [k, k === name ? value : v]);

  it('sends the contract body with the form key, shows the API average as-is, and rotates the key', async () => {
    api.scoreQuotation.mockResolvedValue([
      { id: '1', averageScore: '1.00' },
      { id: QUOTE, averageScore: '76.25' },
    ]);
    const r = await scoreQuotationAction(scoreStart, form(entries));
    expect(api.scoreQuotation).toHaveBeenCalledWith(
      expect.anything(),
      RFQ,
      QUOTE,
      {
        scores: [
          { criterion: 'Price', score: 80 },
          { criterion: 'Delivery', score: 72.5 },
        ],
      },
      KEY,
    );
    expect(r.saved).toContain('76.25');
    expect(r.count).toBe(1);
    expect(r.key).not.toBe(KEY);
    expect(cache.revalidatePath).toHaveBeenCalledWith(`/procurement/rfqs/${RFQ}`);
  });

  it('says so when the API has no average for the quotation', async () => {
    api.scoreQuotation.mockResolvedValue([]);
    const r = await scoreQuotationAction(scoreStart, form(entries));
    expect(r.saved).toMatch(/saved/i);
    expect(r.saved).not.toMatch(/undefined|null/);
  });

  it('shows field errors without calling the API', async () => {
    const r = await scoreQuotationAction(scoreStart, form(swap('scores.0.score', '120')));
    expect(r.errors['scores.0.score']).toBeTruthy();
    expect(r.key).toBe(KEY);
    expect(api.scoreQuotation).not.toHaveBeenCalled();
  });

  it('refuses a person without the sourcing grant and a form without real ids', async () => {
    session.roles = ['viewer'];
    expect((await scoreQuotationAction(scoreStart, form(entries))).error).toMatch(/sourcing/i);
    session.roles = ['procurement'];
    const r = await scoreQuotationAction(scoreStart, form(swap('quotationId', 'nope')));
    expect(r.reload).toBe(true);
    expect(api.scoreQuotation).not.toHaveBeenCalled();
  });

  it('rotates on a definite refusal, keeps the key on 408, 429, 5xx and the in-progress 409', async () => {
    api.scoreQuotation.mockRejectedValue(apiError(404, 'not_found'));
    const refused = await scoreQuotationAction(scoreStart, form(entries));
    expect(refused.key).not.toBe(KEY);
    expect(refused.error).toMatch(/quotation/i);
    for (const err of [
      new ApiError(408, 'x'),
      new ApiError(429, 'x'),
      new ApiError(502, 'x'),
      IN_PROGRESS,
    ]) {
      api.scoreQuotation.mockRejectedValue(err);
      expect((await scoreQuotationAction(scoreStart, form(entries))).key).toBe(KEY);
    }
  });
});

describe('recommendQuotationAction', () => {
  const entries: [string, string][] = [
    ['idempotencyKey', KEY],
    ['rfqId', RFQ],
    ['vendorQuotationId', QUOTE],
    ['rationale', 'Lowest total.'],
    ['fewerThanThreeReason', ''],
  ];

  it('sends the contract body and returns to the RFQ with a confirmation', async () => {
    api.recommendQuotation.mockResolvedValue({ id: RFQ });
    await expect(recommendQuotationAction(start, form(entries))).rejects.toThrow(
      `redirect /procurement/rfqs/${RFQ}?recommended=1`,
    );
    expect(api.recommendQuotation).toHaveBeenCalledWith(
      expect.anything(),
      RFQ,
      { vendorQuotationId: QUOTE, rationale: 'Lowest total.' },
      KEY,
    );
    expect(cache.revalidatePath).toHaveBeenCalledWith('/procurement/rfqs');
    expect(cache.revalidatePath).toHaveBeenCalledWith(`/procurement/rfqs/${RFQ}`);
  });

  it('words fewer quotations than the minimum without the field name, and rotates the key', async () => {
    api.recommendQuotation.mockRejectedValue(
      apiError(409, 'FEWER_THAN_MIN_QUOTES', 'Only 2 of 3: fewerThanThreeReason is required'),
    );
    const r = await recommendQuotationAction(start, form(entries));
    expect(r.error).toMatch(/fewer quotations than the minimum/i);
    expect(r.error).not.toMatch(/fewerThanThreeReason/);
    expect(r.key).not.toBe(KEY);
  });

  it('shows field errors, refuses without the grant, and keeps the key on 429', async () => {
    const empty = await recommendQuotationAction(
      start,
      form([
        ['rfqId', RFQ],
        ['idempotencyKey', KEY],
      ]),
    );
    expect(empty.errors.vendorQuotationId).toBeTruthy();
    expect(api.recommendQuotation).not.toHaveBeenCalled();
    session.roles = ['viewer'];
    expect((await recommendQuotationAction(start, form(entries))).error).toMatch(/sourcing/i);
    session.roles = ['procurement'];
    api.recommendQuotation.mockRejectedValue(new ApiError(429, 'x'));
    expect((await recommendQuotationAction(start, form(entries))).key).toBe(KEY);
  });
});

describe('commitRfqAction', () => {
  const commitStart = { key: KEY, count: 0 };
  const entries: [string, string][] = [
    ['idempotencyKey', KEY],
    ['rfqId', RFQ],
  ];

  it('submits with the form key and refreshes the RFQ, its list and the purchase request', async () => {
    api.commitRfq.mockResolvedValue({ id: RFQ, purchaseRequestId: PR });
    const r = await commitRfqAction(commitStart, form(entries));
    expect(api.commitRfq).toHaveBeenCalledWith(expect.anything(), RFQ, KEY);
    expect(r.count).toBe(1);
    expect(r.saved).toMatch(/approval/i);
    expect(r.key).not.toBe(KEY);
    for (const path of [
      '/procurement/rfqs',
      `/procurement/rfqs/${RFQ}`,
      '/procurement/requests',
      `/procurement/requests/${PR}`,
    ]) {
      expect(cache.revalidatePath).toHaveBeenCalledWith(path);
    }
  });

  it('no eligible approver (422) says nothing was submitted and rotates the key', async () => {
    api.commitRfq.mockRejectedValue(
      apiError(422, 'NO_ELIGIBLE_APPROVER', 'No Finance approver can decide step 2'),
    );
    const r = await commitRfqAction(commitStart, form(entries));
    expect(r.error).toContain('No Finance approver can decide step 2');
    expect(r.error).toMatch(/nothing was submitted/i);
    expect(r.key).not.toBe(KEY);
    expect(r.count).toBe(0);
  });

  it('a stale RFQ (409) offers a reload', async () => {
    api.commitRfq.mockRejectedValue(
      apiError(409, 'conflict', 'The purchase request is draft, not sourcing'),
    );
    const r = await commitRfqAction(commitStart, form(entries));
    expect(r.reload).toBe(true);
    expect(r.error).toContain('not sourcing');
  });

  it('refuses without the grant or a real id, and keeps the key on 408, 429, 5xx, in-progress', async () => {
    session.roles = ['viewer'];
    expect((await commitRfqAction(commitStart, form(entries))).error).toMatch(/sourcing/i);
    session.roles = ['procurement'];
    expect((await commitRfqAction(commitStart, form([['rfqId', 'x']]))).reload).toBe(true);
    expect(api.commitRfq).not.toHaveBeenCalled();
    for (const err of [
      new ApiError(408, 'x'),
      new ApiError(429, 'x'),
      new ApiError(500, 'x'),
      IN_PROGRESS,
    ]) {
      api.commitRfq.mockRejectedValue(err);
      expect((await commitRfqAction(commitStart, form(entries))).key).toBe(KEY);
    }
  });
});

describe('extendDeadlineAction (F1-Q47)', () => {
  const editStart = { key: KEY, errors: {}, count: 0 };
  const entries = (deadline: string): [string, string][] => [
    ['idempotencyKey', KEY],
    ['rfqId', RFQ],
    ['currentDeadline', '2026-11-20T04:15:00.000Z'],
    ['deadline', deadline],
  ];

  it('sends the new Kathmandu deadline with the form key, refreshes the RFQ and says until when', async () => {
    api.extendRfqDeadline.mockResolvedValue({ deadline: '2030-12-01T11:45:00.000Z' });
    const next = await extendDeadlineAction(editStart, form(entries('2030-12-01T17:30')));
    expect(api.extendRfqDeadline).toHaveBeenCalledWith(
      expect.anything(),
      RFQ,
      { deadline: '2030-12-01T17:30:00+05:45' },
      KEY,
    );
    expect(next.count).toBe(1);
    expect(next.key).not.toBe(KEY);
    expect(next.saved).toContain('Deadline extended to');
    expect(next.saved).toContain('Invited vendors can send quotations until then.');
    expect(cache.revalidatePath.mock.calls.map((c) => String(c[0]))).toContain(
      `/procurement/rfqs/${RFQ}`,
    );
  });

  it('refuses a past deadline next to the field without calling the API', async () => {
    const next = await extendDeadlineAction(editStart, form(entries('2020-01-01T10:00')));
    expect(next.errors.deadline).toMatch(/has passed/);
    expect(next.key).toBe(KEY);
    expect(api.extendRfqDeadline).not.toHaveBeenCalled();
  });

  it("puts the API's 400 refusals next to the field and rotates the key", async () => {
    api.extendRfqDeadline.mockRejectedValueOnce(
      new ApiError(400, 'x', {
        error: {
          code: 'bad_request',
          message: 'The new deadline must be later than the current one.',
          correlationId: 'corr-12345678',
        },
      }),
    );
    const next = await extendDeadlineAction(editStart, form(entries('2030-12-01T17:30')));
    expect(next.errors.deadline).toBe('Choose a deadline later than the current one.');
    expect(next.error).toBeUndefined();
    expect(next.key).not.toBe(KEY);
  });

  it('a closed RFQ (409) asks for a reload; a 5xx keeps the key', async () => {
    api.extendRfqDeadline.mockRejectedValueOnce(
      apiError(409, 'conflict', "Only an open RFQ's deadline can be extended; this one is closed"),
    );
    const closed = await extendDeadlineAction(editStart, form(entries('2030-12-01T17:30')));
    expect(closed.reload).toBe(true);
    expect(closed.error).not.toBeUndefined();
    api.extendRfqDeadline.mockRejectedValueOnce(new ApiError(503, 'x'));
    const down = await extendDeadlineAction(editStart, form(entries('2030-12-01T17:30')));
    expect(down.key).toBe(KEY);
  });

  it('refuses a form without a real RFQ id and a person without the grant, before any call', async () => {
    const bad = await extendDeadlineAction(
      editStart,
      form([...entries('2030-12-01T17:30').filter(([k]) => k !== 'rfqId'), ['rfqId', 'x']]),
    );
    expect(bad.reload).toBe(true);
    session.roles = ['viewer'];
    const denied = await extendDeadlineAction(editStart, form(entries('2030-12-01T17:30')));
    expect(denied.error).toMatch(/sourcing/);
    expect(api.extendRfqDeadline).not.toHaveBeenCalled();
  });
});

describe('a quotation after the deadline (F1-Q47)', () => {
  it('says the deadline passed instead of asking for a reload, and rotates the key', async () => {
    api.recordQuotation.mockRejectedValueOnce(
      apiError(
        409,
        'rfq_deadline_passed',
        'The quotation deadline of this RFQ has passed. Procurement can extend it to take more quotations.',
      ),
    );
    const next = await recordQuotationAction(start, form(quoteEntries));
    expect(next.error).toMatch(/deadline has passed/);
    expect(next.reload).toBeUndefined();
    expect(next.key).not.toBe(KEY);
  });
});
