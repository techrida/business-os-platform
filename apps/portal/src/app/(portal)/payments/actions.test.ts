import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callOf, ID, IDEM, json, session, stubPortalEnv } from '@/lib/billing-test-support';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}
class NotFound extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFound();
  },
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { submitPaymentAction } = await import('./actions');

const PROOF = '2f8fad5b-d9cb-469f-a165-70867728950e';
const fetchMock = vi.fn<typeof fetch>();

const GOOD: Record<string, string> = {
  currency: 'NPR',
  amount: '20,18,180.00',
  method: 'bank_transfer',
  receivedOn: '2026-01-15',
  bankReference: ' TXN-1 ',
  tdsWithheld: '',
  withholdingCode: '',
};

function form(over: Record<string, string> = {}, proofs: string[] = [PROOF]): FormData {
  const f = new FormData();
  f.set('idempotencyKey', IDEM);
  for (const [k, v] of Object.entries({ ...GOOD, ...over })) f.set(k, v);
  for (const p of proofs) f.append('proofDocumentId', p);
  return f;
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof Redirect)) throw new Error('expected a redirect');
  return err.to;
}

beforeEach(() => {
  stubPortalEnv();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  getSession.mockReset();
  getSession.mockResolvedValue(session);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('submitPaymentAction validation', () => {
  it('says what is wrong, field by field, without calling the API, and keeps the unused key', async () => {
    const bad = await submitPaymentAction(
      { key: IDEM },
      form({ amount: '0.00', method: 'barter', receivedOn: '2999-01-01', currency: 'EUR' }, []),
    );
    expect(bad.key).toBe(IDEM);
    expect(Object.keys(bad.fieldErrors ?? {}).sort()).toEqual(
      ['amount', 'currency', 'method', 'proof', 'receivedOn'].sort(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires the withholding code when tax was withheld, and ignores a tampered proof id', async () => {
    const tds = await submitPaymentAction({ key: IDEM }, form({ tdsWithheld: '1,000.00' }));
    expect(tds.fieldErrors?.withholdingCode).toBeTruthy();
    const tampered = await submitPaymentAction({ key: IDEM }, form({}, ['../admin']));
    expect(tampered.fieldErrors?.proof).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('submitPaymentAction submit', () => {
  it('answers a vendor session with a uniform 404 before validating the form or calling the API', async () => {
    getSession.mockResolvedValue({ ...session, orgKind: 'vendor' });
    await expect(
      submitPaymentAction({ key: IDEM }, form({ amount: '0.00' }, [])),
    ).rejects.toBeInstanceOf(NotFound);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips lakh commas, POSTs the strict body with the Idempotency-Key and no customer id, then shows the list', async () => {
    fetchMock.mockResolvedValue(json({ id: ID }, 201));
    const to = await redirectOf(submitPaymentAction({ key: IDEM }, form()));
    expect(to).toBe('/payments?submitted=1');
    const { url, headers, init } = callOf(fetchMock);
    expect(url).toBe('http://api:3001/v1/portal/payments');
    expect(headers.get('idempotency-key')).toBe(IDEM);
    expect(JSON.parse(init.body as string)).toEqual({
      currency: 'NPR',
      amount: '2018180.00',
      tdsWithheld: '0.00',
      method: 'bank_transfer',
      receivedOn: '2026-01-15',
      bankReference: 'TXN-1',
      proofDocumentIds: [PROOF],
    });
  });

  it('keeps the key and the proof across a 503 and a 409, so a retry sends the same request', async () => {
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
    const down = await submitPaymentAction({ key: IDEM }, form());
    expect(down.key).toBe(IDEM);
    expect(down.error).toMatch(/only be recorded once/);
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'idempotency_in_progress' } }, 409));
    const busy = await submitPaymentAction({ key: down.key }, form());
    expect(busy.key).toBe(IDEM);
    fetchMock.mockResolvedValueOnce(json({ id: ID }, 201));
    await redirectOf(submitPaymentAction({ key: busy.key }, form()));
    const [a, b, c] = fetchMock.mock.calls.map(([, init]) => ({
      key: new Headers(init?.headers).get('idempotency-key'),
      body: init?.body,
    }));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('rotates the key after a definite refusal and never shows the API text', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: 'forbidden', message: 'party 00aa does not own proof 2f8f' } }, 403),
    );
    const res = await submitPaymentAction({ key: IDEM }, form());
    expect(res.key).not.toBe(IDEM);
    expect(res.error).toBeTruthy();
    expect(res.error).not.toMatch(/party|proof 2f8f/);
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'validation_failed' } }, 422));
    const bad = await submitPaymentAction({ key: IDEM }, form());
    expect(bad.key).not.toBe(IDEM);
    expect(bad.error).toMatch(/Check the details/);
  });

  it('sends a signed-out user, and a 401 from the API, to sign in and back to the form', async () => {
    const back = `/auth/login?returnTo=${encodeURIComponent(`/payments/new?invoice=${ID}`)}`;
    getSession.mockResolvedValue(null);
    expect(await redirectOf(submitPaymentAction({ key: IDEM }, form({ invoice: ID })))).toBe(back);
    getSession.mockResolvedValue(session);
    fetchMock.mockResolvedValueOnce(json({}, 401));
    expect(await redirectOf(submitPaymentAction({ key: IDEM }, form({ invoice: ID })))).toBe(back);
  });

  it('falls back to the state key when the hidden key was tampered with', async () => {
    fetchMock.mockResolvedValue(json({ id: ID }, 201));
    const f = form();
    f.set('idempotencyKey', 'x y');
    await redirectOf(submitPaymentAction({ key: IDEM }, f));
    expect(callOf(fetchMock).headers.get('idempotency-key')).toBe(IDEM);
  });
});

describe('submitPaymentAction amount with a space', () => {
  it('says to remove the space for `10 50`, not the generic message', async () => {
    const state = await submitPaymentAction(
      { key: IDEM },
      form({ amount: '10 50', tdsWithheld: '1 000' }),
    );
    expect(state.fieldErrors?.amount).toBe('Remove the space inside the number.');
    expect(state.fieldErrors?.tdsWithheld).toBe('Remove the space inside the number.');
    const other = await submitPaymentAction({ key: IDEM }, form({ amount: '0.00' }));
    expect(other.fieldErrors?.amount).toMatch(/above zero/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
