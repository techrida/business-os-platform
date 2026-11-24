import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RFQ_ID } from '@/components/vendor/rfq-fixtures';
import type { Session } from '@/lib/session';

import {
  callOf,
  DOC,
  IDEM,
  json,
  Redirect,
  redirectOf,
  stubPortalEnv,
  vendorSession,
} from '../../../_upload/test-kit';

vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));

const { submitQuoteAction } = await import('./actions');

const fetchMock = vi.fn<typeof fetch>();

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  f.set('idempotencyKey', IDEM);
  f.set('rfqId', RFQ_ID);
  f.set('documentId', DOC);
  f.set('currency', 'NPR');
  f.set('total', '20,18,180.00');
  f.set('vendorRef', '');
  f.set('validUntil', '');
  f.set('deliveryDays', '');
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const send = (fields: Record<string, string> = {}) =>
  submitQuoteAction({ key: IDEM }, form(fields));

beforeEach(() => {
  stubPortalEnv();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  getSession.mockReset();
  getSession.mockResolvedValue(vendorSession());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('submitQuoteAction', () => {
  it('sends the quotation with the form key, the request from the page and the typed total, then redirects', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 'received' }, 201));
    const to = await redirectOf(
      send({ vendorRef: ' Q-77 ', validUntil: '2026-12-31', deliveryDays: '14' }),
    );
    expect(to).toBe(`/vendor/rfqs/${RFQ_ID}/quote?sent=1`);
    const r = callOf(fetchMock, 0);
    expect(r.url).toBe('http://api:3001/v1/portal/vendor/quotation-submissions');
    expect(r.headers.get('idempotency-key')).toBe(IDEM);
    expect(r.body).toEqual({
      rfqId: RFQ_ID,
      documentId: DOC,
      currency: 'NPR',
      total: '2018180.00',
      vendorRef: 'Q-77',
      validUntil: '2026-12-31',
      deliveryDays: 14,
    });
  });

  it('leaves the optional fields out when they are empty', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 201));
    await redirectOf(send());
    const body = callOf(fetchMock, 0).body as Record<string, unknown>;
    for (const k of ['vendorRef', 'validUntil', 'deliveryDays']) expect(body).not.toHaveProperty(k);
  });

  it('refuses a delivery time that is not a whole number of days, without calling the API', async () => {
    for (const bad of ['1.5', '-3', '2 weeks', '1e3', '5000']) {
      const state = await send({ deliveryDays: bad });
      expect(Object.keys(state.fieldErrors ?? {})).toEqual(['deliveryDays']);
      expect(state.key).toBe(IDEM);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses `2w` as a delivery time with the whole-days words, and sends nothing', async () => {
    // The delivery box only types digits, so this reaches the action only from a hand-made request.
    const state = await send({ deliveryDays: '2w' });
    expect(Object.keys(state.fieldErrors ?? {})).toEqual(['deliveryDays']);
    expect(state.fieldErrors?.deliveryDays).toMatch(/whole number of days/);
    expect(state.key).toBe(IDEM);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a non-numeric total (`twelve`) and an empty total as the same field, without calling the API', async () => {
    const words = await send({ total: 'twelve' });
    const empty = await send({ total: '' });
    expect(Object.keys(words.fieldErrors ?? {})).toEqual(['total']);
    expect(Object.keys(empty.fieldErrors ?? {})).toEqual(['total']);
    expect(words.fieldErrors?.total).toMatch(/Enter the total of your quotation/);
    expect(words.key).toBe(IDEM);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names each bad field and keeps the unused key, without calling the API', async () => {
    const state = await send({
      documentId: '',
      currency: 'EUR',
      total: '-5',
      vendorRef: 'x'.repeat(65),
      validUntil: '31/12/2026',
    });
    expect(state.key).toBe(IDEM);
    expect(Object.keys(state.fieldErrors ?? {}).sort()).toEqual([
      'currency',
      'file',
      'total',
      'validUntil',
      'vendorRef',
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a request id that is not an id, and sends nothing', async () => {
    const state = await send({ rfqId: 'not-an-id' });
    expect(state.error).toMatch(/Reload the page/);
    expect(state.key).toBe(IDEM);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a customer session without any API call, and a visitor goes to sign in and back', async () => {
    getSession.mockResolvedValue(vendorSession('customer'));
    expect((await send()).error).toMatch(/vendor account/);
    getSession.mockResolvedValue(null);
    expect(await redirectOf(send())).toBe(
      `/auth/login?returnTo=${encodeURIComponent(`/vendor/rfqs/${RFQ_ID}/quote`)}`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['its code', { code: 'rfq_deadline_passed', message: 'x' }],
    [
      'its sentence while the filter says conflict',
      {
        code: 'conflict',
        message:
          'The quotation deadline of this RFQ has passed. Procurement can extend it to take more quotations.',
      },
    ],
  ])(
    'says the deadline passed on the 409 read by %s, and rotates the key (F1-Q47)',
    async (_, error) => {
      fetchMock.mockResolvedValueOnce(json({ error }, 409));
      const state = await send();
      expect(state.error).toBe(
        'The deadline for this request has passed. We can no longer take a quotation for this request. If we extend the deadline, the new date will show here.',
      );
      expect(state.key).not.toBe(IDEM);
    },
  );

  it('keeps the key across the in-progress 409 and a 5xx, so the retry reuses it', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'idempotency_in_progress' } }, 409));
    const first = await send();
    expect(first.key).toBe(IDEM);
    fetchMock.mockResolvedValueOnce(json({ error: {} }, 503));
    const second = await submitQuoteAction(first, form({ idempotencyKey: first.key }));
    expect(second.key).toBe(IDEM);
    fetchMock.mockResolvedValueOnce(json({}, 201));
    await redirectOf(submitQuoteAction(second, form({ idempotencyKey: second.key })));
    expect([0, 1, 2].map((n) => callOf(fetchMock, n).headers.get('idempotency-key'))).toEqual([
      IDEM,
      IDEM,
      IDEM,
    ]);
  });

  it('rotates the key after a definite 4xx refusal', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'validation_failed' } }, 400));
    const state = await send();
    expect(state.key).not.toBe(IDEM);
    expect(state.error).toMatch(/Check the details/);
  });

  it('shows a 404 as one message about the request or the file, and rotates the key', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: {} }, 404));
    const state = await send();
    expect(state.error).toMatch(/no longer available/);
    expect(state.fieldErrors).toBeUndefined();
    expect(state.key).not.toBe(IDEM);
  });

  it('shows a 403 as the account, not the form', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'forbidden' } }, 403));
    const state = await send();
    expect(state.error).toMatch(/cannot send quotations/);
    expect(state.fieldErrors).toBeUndefined();
  });

  it('names a currency the company switched off (422 CURRENCY_NOT_ENABLED) and rotates the key', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'CURRENCY_NOT_ENABLED',
            message: 'Currency INR is not enabled for this company',
            correlationId: 'req-12345678',
            details: { currency: 'INR' },
          },
        },
        422,
      ),
    );
    const state = await send({ currency: 'INR' });
    expect(callOf(fetchMock, 0).body).toMatchObject({ currency: 'INR' });
    expect(state.fieldErrors).toEqual({
      currency: 'INR is switched off for the company. Choose another currency.',
    });
    expect(state.error).toBeUndefined();
    expect(state.key).not.toBe(IDEM);
  });

  it('keeps the generic words for any other 422', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'validation_failed' } }, 422));
    const state = await send();
    expect(state.error).toMatch(/Check the details/);
  });
});

describe('submitQuoteAction numbers with a space', () => {
  it('says to remove the space in the total and the delivery days, but not for `2 weeks`', async () => {
    const state = await send({ total: '10 50', deliveryDays: '1 4' });
    expect(state.fieldErrors?.total).toBe('Remove the space inside the number.');
    expect(state.fieldErrors?.deliveryDays).toBe('Remove the space inside the number.');
    const words = await send({ deliveryDays: '2 weeks' });
    expect(words.fieldErrors?.deliveryDays).toMatch(/whole number of days/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
