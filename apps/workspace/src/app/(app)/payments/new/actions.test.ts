import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CUSTOMER_ID, PAYMENT_ID, PROOF_ID, payment } from '../_lib/fixtures';
import { UNAVAILABLE_MESSAGE } from '../_lib/failure';

import { recordPaymentAction } from './actions';
import {
  INVALID_PROOF_MESSAGE,
  NO_RECORD_WORDS,
  NOT_FOUND_MESSAGE,
  type RecordPaymentState,
  STALE_MESSAGE,
  UNKNOWN_CODE_MESSAGE,
} from './form-state';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  apiFetch: vi.fn(),
  getMe: vi.fn(),
  findPaymentReferenceMatches: vi.fn(),
  getInvoice: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
  getMe: mocks.getMe,
}));
vi.mock('@/lib/api-payments', () => ({
  findPaymentReferenceMatches: mocks.findPaymentReferenceMatches,
}));
// The invoice read of a form opened from an invoice (item 3b); mocked so it never takes an apiFetch call.
vi.mock('@/lib/api-billing', () => ({ getInvoice: mocks.getInvoice }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

/** GET /v1/me with the live grants Settings > Access gives the caller's roles. */
const liveGrants = (...permissions: string[]) => ({
  permissions: permissions.map((permission) => ({ permission, scope: 'all' })),
});

const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROOF_2 = '99999999-9999-4999-8999-999999999999';
const prev: RecordPaymentState = { key: KEY };

function form(over: Record<string, string | string[]> = {}): FormData {
  const f = new FormData();
  const fields: Record<string, string | string[]> = {
    idempotencyKey: KEY,
    customerId: CUSTOMER_ID,
    currency: 'NPR',
    amount: '1000000.00',
    method: 'bank_transfer',
    receivedOn: '2020-01-02',
    bankReference: 'NIC-77812',
    tdsWithheld: '',
    withholdingCode: '',
    proofDocumentId: [PROOF_ID],
    ...over,
  };
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
  }
  return f;
}

function answer(status: number, body: unknown = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}
const call = (n: number) => mocks.apiFetch.mock.calls[n] as [unknown, string, RequestInit];
const sentKey = (n: number) => (call(n)[2].headers as Record<string, string>)['idempotency-key'];
const sentBody = (n: number) => JSON.parse(call(n)[2].body as string) as Record<string, unknown>;
const refusal = (status: number, code: string, message = 'x') =>
  answer(status, { error: { code, message, correlationId: 'c' } });

/** The action finishes with `redirect`, which throws; this returns its target or the state. */
async function run(f: FormData, state: RecordPaymentState = prev) {
  try {
    return { state: await recordPaymentAction(state, f), to: null as string | null };
  } catch (err) {
    const m = /^REDIRECT:(.*)$/.exec(err instanceof Error ? err.message : '');
    if (m === null) throw err;
    return { state: null, to: m[1] ?? null };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
  // Without a live answer the gate falls back to the role defaults.
  mocks.getMe.mockRejectedValue(new Error('GET /v1/me failed'));
  // No earlier payment carries the reference unless a test says so.
  mocks.findPaymentReferenceMatches.mockResolvedValue([]);
});

describe('recordPaymentAction', () => {
  it('posts the contract body with the page key and opens the new payment', async () => {
    mocks.apiFetch.mockImplementation(() => answer(201, payment()));
    const out = await run(form({ proofDocumentId: [PROOF_ID, PROOF_2, PROOF_ID] }));
    expect(out.to).toBe(`/payments/${PAYMENT_ID}`);
    const [, path, init] = call(0);
    expect(path).toBe('/v1/payments');
    expect(init.method).toBe('POST');
    expect(sentKey(0)).toBe(KEY);
    expect(sentBody(0)).toEqual({
      customerId: CUSTOMER_ID,
      currency: 'NPR',
      amount: '1000000',
      method: 'bank_transfer',
      receivedOn: '2020-01-02',
      bankReference: 'NIC-77812',
      tdsWithheld: '0.00',
      proofDocumentIds: [PROOF_ID, PROOF_2],
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/payments');
  });

  it('sends the same body for padded and trimmed text, so a retry under one key matches', async () => {
    // A form posted before hydration carries `12,50,000.00`; the hydrated one posts `1250000`.
    await run(form({ amount: '12,50,000.00' }));
    await run(form({ amount: '1250000' }));
    expect(sentBody(0)).toEqual(sentBody(1));
    expect(sentBody(0)).toMatchObject({ amount: '1250000' });
  });

  it('turns typed lakh grouping into plain digits and sends tax with its code', async () => {
    mocks.apiFetch.mockImplementation(() => answer(201, payment()));
    await run(
      form({
        amount: '20,18,180.00',
        tdsWithheld: '15,000.00',
        withholdingCode: ' TDS-1.5 ',
        bankReference: '',
      }),
    );
    expect(sentBody(0)).toMatchObject({
      amount: '2018180',
      tdsWithheld: '15000',
      withholdingCode: 'TDS-1.5',
    });
    expect(sentBody(0)).not.toHaveProperty('bankReference');
  });

  it('asks for the withholding code when tax was withheld, and sends nothing', async () => {
    const out = await run(form({ tdsWithheld: '15000.00', withholdingCode: '  ' }));
    expect(out.state?.fieldErrors?.withholdingCode).toMatch(/withholding code/);
    expect(out.state?.key).toBe(KEY);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('needs no code when no tax was withheld', async () => {
    mocks.apiFetch.mockImplementation(() => answer(201, payment()));
    for (const tds of ['', '0', '0.00']) {
      mocks.apiFetch.mockClear();
      const out = await run(form({ tdsWithheld: tds }));
      expect(out.to).toBe(`/payments/${PAYMENT_ID}`);
    }
  });

  it('requires at least one proof file, and ignores ids that are not UUIDs', async () => {
    for (const ids of [[], ['not-a-uuid', '../x']]) {
      const out = await run(form({ proofDocumentId: ids }));
      expect(out.state?.fieldErrors?.proof).toMatch(/bank slip or receipt/);
    }
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('names every wrong field at once and keeps the unused key', async () => {
    const out = await run(
      form({
        customerId: 'nope',
        amount: '12.345',
        method: 'barter',
        currency: 'EUR',
        receivedOn: '2999-01-01',
        proofDocumentId: [],
      }),
    );
    expect(Object.keys(out.state?.fieldErrors ?? {}).sort()).toEqual([
      'amount',
      'currency',
      'customerId',
      'method',
      'proof',
      'receivedOn',
    ]);
    expect(out.state?.key).toBe(KEY);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('does not let a negative or zero amount through', async () => {
    for (const amount of ['0', '0.00', '-5.00', '']) {
      const out = await run(form({ amount }));
      expect(out.state?.fieldErrors?.amount).toBeDefined();
    }
  });

  it('names the space in "10 50" instead of the generic amount message, and sends nothing', async () => {
    const out = await run(
      form({ amount: '10 50', tdsWithheld: '1 250.00', withholdingCode: 'TDS-1' }),
    );
    // Old code gave the generic "Enter the amount received..." words, which the digits seem to satisfy.
    expect(out.state?.fieldErrors?.amount).toBe('Remove the space inside the number.');
    expect(out.state?.fieldErrors?.tdsWithheld).toBe('Remove the space inside the number.');
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('keeps the decimal-comma hint for "10,50"', async () => {
    const out = await run(form({ amount: '10,50' }));
    expect(out.state?.fieldErrors?.amount).toMatch(/^Use a point for decimals\. Enter the amount/);
  });

  it('refuses a role without payment.record before calling the API', async () => {
    for (const roles of [[], ['management'], ['sales']]) {
      mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles });
      const out = await run(form());
      expect(out.state?.error).toBe(NO_RECORD_WORDS);
    }
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('records for a role granted payment.record in Settings > Access, by the live grants', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['management'] });
    mocks.getMe.mockResolvedValue(liveGrants('payment.read', 'payment.record'));
    mocks.apiFetch.mockImplementation(() => answer(201, payment()));
    const out = await run(form());
    expect(out.to).toBe(`/payments/${PAYMENT_ID}`);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a role whose payment.record was taken away, and an empty live list, before calling the API', async () => {
    mocks.getMe.mockResolvedValue(liveGrants('payment.read'));
    expect((await run(form())).state?.error).toBe(NO_RECORD_WORDS);
    mocks.getMe.mockResolvedValue(liveGrants());
    expect((await run(form())).state?.error).toBe(NO_RECORD_WORDS);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('says plainly to wait and retry on 422 invalid_proof, with a new key', async () => {
    mocks.apiFetch.mockImplementation(() => refusal(422, 'invalid_proof', 'internal detail'));
    const out = await run(form());
    expect(out.state?.error).toBe(INVALID_PROOF_MESSAGE);
    expect(out.state?.error).toMatch(/Wait a moment/);
    expect(out.state?.error).not.toMatch(/internal detail/);
    expect(out.state?.key).not.toBe(KEY);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('reuses the key after a timeout, a 5xx, a dropped connection and the in-progress 409', async () => {
    const cases: (() => Promise<Response>)[] = [
      () => answer(503, {}),
      () => answer(500, { error: { code: 'internal', message: 'boom', correlationId: 'c' } }),
      () => Promise.reject(new TypeError('fetch failed')),
      () =>
        refusal(409, 'conflict', 'A request with this Idempotency-Key is still being processed'),
    ];
    for (const make of cases) {
      mocks.apiFetch.mockImplementation(make);
      const out = await run(form());
      expect(out.state?.key).toBe(KEY);
      expect(out.state?.error).toBeTruthy();
    }
  });

  it('words an unknown outcome as safe to retry', async () => {
    mocks.apiFetch.mockImplementation(() => answer(502, {}));
    const out = await run(form());
    expect(out.state?.error).toBe(UNAVAILABLE_MESSAGE);
  });

  it('takes a new key after a definite refusal, so the next try is a new decision', async () => {
    for (const make of [
      () => refusal(400, 'validation_failed', 'bad field'),
      () => refusal(403, 'forbidden'),
      () => refusal(404, 'not_found'),
      () => refusal(422, 'unprocessable'),
    ]) {
      mocks.apiFetch.mockImplementation(make);
      const out = await run(form());
      expect(out.state?.key).not.toBe(KEY);
      expect(out.state?.key).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('words a missing customer and a stale page in the form’s own terms', async () => {
    mocks.apiFetch.mockImplementation(() => refusal(404, 'not_found'));
    expect((await run(form())).state?.error).toBe(NOT_FOUND_MESSAGE);
    mocks.apiFetch.mockImplementation(() => refusal(409, 'conflict', 'changed'));
    const stale = await run(form());
    expect(stale.state?.error).toBe(STALE_MESSAGE);
    expect(stale.state?.reload).toBe(true);
  });

  it('shows an unknown withholding code on its own field, and an unknown customer in words', async () => {
    mocks.apiFetch.mockImplementation(() =>
      refusal(422, 'unknown_withholding_code', 'No code TDS-9'),
    );
    const code = await run(form({ tdsWithheld: '15.00', withholdingCode: 'TDS-9' }));
    expect(code.state?.fieldErrors?.withholdingCode).toBe(UNKNOWN_CODE_MESSAGE);
    expect(code.state?.error).toBeUndefined();
    expect(code.state?.key).not.toBe(KEY);
    mocks.apiFetch.mockImplementation(() => refusal(422, 'unknown_customer', 'No such customer'));
    expect((await run(form())).state?.error).toBe(NOT_FOUND_MESSAGE);
  });

  it('sends a signed-out person to sign in and back to the form', async () => {
    mocks.apiFetch.mockImplementation(() => answer(401, {}));
    const out = await run(form());
    expect(out.to).toBe('/auth/login?returnTo=%2Fpayments%2Fnew');
  });

  it('falls back to the state key when the hidden key was tampered with', async () => {
    mocks.apiFetch.mockImplementation(() => answer(201, payment()));
    await run(form({ idempotencyKey: 'x' }));
    expect(sentKey(0)).toBe(KEY);
  });

  it('treats an API answer that breaks the contract as a failure, not a success', async () => {
    mocks.apiFetch.mockImplementation(() => answer(201, { id: PAYMENT_ID }));
    const out = await run(form());
    expect(out.to).toBeNull();
    expect(out.state?.key).toBe(KEY);
    expect(out.state?.error).toBeTruthy();
  });
});

// Item 3b: a form opened from an invoice pays that invoice's customer, read again here as the caller.
describe('recordPaymentAction from an invoice', () => {
  const INVOICE_ID = '11111111-1111-4111-8111-111111111111';
  const TAMPERED = '44444444-4444-4444-8444-444444444444';

  it('posts the invoice’s customer and ignores a tampered customer field', async () => {
    mocks.getInvoice.mockResolvedValue({ invoice: { id: INVOICE_ID, customerId: CUSTOMER_ID } });
    mocks.apiFetch.mockImplementation(() => answer(201, payment()));
    const out = await run(form({ invoiceId: INVOICE_ID, customerId: TAMPERED }));
    expect(out.to).toBe(`/payments/${PAYMENT_ID}`);
    expect(mocks.getInvoice).toHaveBeenCalledWith(expect.anything(), INVOICE_ID);
    expect(call(0)[1]).toBe('/v1/payments');
    expect(sentBody(0)['customerId']).toBe(CUSTOMER_ID);
    expect(sentBody(0)).not.toHaveProperty('invoiceId');
  });

  it('records nothing and offers a reload, keeping the key, when the invoice cannot be read', async () => {
    mocks.getInvoice.mockRejectedValue(new Error('403'));
    const out = await run(form({ invoiceId: INVOICE_ID }));
    expect(out.to).toBeNull();
    expect(out.state).toMatchObject({ key: KEY, reload: true });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('reads no invoice for the standalone form, nor for an invoice id that is not a UUID', async () => {
    mocks.apiFetch.mockImplementation(() => answer(201, payment()));
    await run(form());
    await run(form({ invoiceId: 'not-a-uuid' }));
    expect(mocks.getInvoice).not.toHaveBeenCalled();
    expect(sentBody(0)['customerId']).toBe(CUSTOMER_ID);
    expect(sentBody(1)['customerId']).toBe(CUSTOMER_ID);
  });
});

describe('recordPaymentAction with a bank reference already on file (TR-Q12d)', () => {
  const EARLIER = '55555555-5555-4555-8555-555555555555';
  const LATER = '66666666-6666-4666-8666-666666666666';
  const earlier = {
    id: EARLIER,
    number: 'RCPT-2026-00012',
    customerName: 'Everest Foods',
    receivedOn: '2026-11-05',
    amount: '250.50',
    currency: 'NPR',
    status: 'verified',
  };

  it('checks the trimmed reference, shows the earlier payments and records nothing, keeping the key', async () => {
    mocks.findPaymentReferenceMatches.mockResolvedValue([earlier]);
    const out = await run(form({ bankReference: '  NIC-77812 ' }));
    expect(mocks.findPaymentReferenceMatches).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 't' }),
      'NIC-77812',
    );
    expect(out.state).toEqual({ key: KEY, referenceMatches: [earlier] });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('records the payment once the person confirms it is a different one', async () => {
    mocks.findPaymentReferenceMatches.mockResolvedValue([earlier]);
    mocks.apiFetch.mockImplementation(() => answer(201, payment()));
    const out = await run(form({ referenceConfirmed: EARLIER }));
    expect(out.to).toBe(`/payments/${PAYMENT_ID}`);
    expect(sentKey(0)).toBe(KEY);
    expect(sentBody(0)).toMatchObject({ bankReference: 'NIC-77812' });
    expect(sentBody(0)).not.toHaveProperty('referenceConfirmed');
  });

  it('warns again when a payment the person was not shown has the reference', async () => {
    mocks.findPaymentReferenceMatches.mockResolvedValue([{ ...earlier, id: LATER }, earlier]);
    const out = await run(form({ referenceConfirmed: `${EARLIER},not-an-id` }));
    expect(out.state?.referenceMatches?.map((m) => m.id)).toEqual([LATER, EARLIER]);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('still records the payment when the check cannot be read', async () => {
    mocks.findPaymentReferenceMatches.mockRejectedValue(new Error('GET failed with 503'));
    mocks.apiFetch.mockImplementation(() => answer(201, payment()));
    const out = await run(form());
    expect(out.to).toBe(`/payments/${PAYMENT_ID}`);
  });

  it('does not check a payment with no bank reference, or a form with a wrong field', async () => {
    mocks.apiFetch.mockImplementation(() => answer(201, payment()));
    await run(form({ bankReference: '   ' }));
    await run(form({ amount: '0' }));
    expect(mocks.findPaymentReferenceMatches).not.toHaveBeenCalled();
  });
});
