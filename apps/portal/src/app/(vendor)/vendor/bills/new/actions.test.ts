import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

import {
  callOf,
  DOC,
  IDEM,
  json,
  PO,
  Redirect,
  redirectOf,
  stubPortalEnv,
  vendorSession,
} from '../../_upload/test-kit';

vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
const revalidatePath = vi.fn<(path: string) => void>();
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const { submitBillAction } = await import('./actions');

const fetchMock = vi.fn<typeof fetch>();

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  f.set('idempotencyKey', IDEM);
  f.set('documentId', DOC);
  f.set('vendorInvoiceNo', 'INV-77');
  f.set('invoiceDate', '2026-11-01');
  f.set('currency', 'NPR');
  f.set('claimedTotal', '20,18,180.00');
  f.set('purchaseOrderId', '');
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const send = (fields: Record<string, string> = {}) => submitBillAction({ key: IDEM }, form(fields));

beforeEach(() => {
  stubPortalEnv();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  revalidatePath.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue(vendorSession());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('submitBillAction', () => {
  it('sends the claim with the form key, takes the lakh commas out of the total and sends no party id', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 'received' }, 201));
    const to = await redirectOf(send({ purchaseOrderId: PO }));
    expect(to).toBe('/vendor/bills/new?sent=1');
    expect(revalidatePath).toHaveBeenCalledWith('/vendor/bills');
    const r = callOf(fetchMock, 0);
    expect(r.url).toBe('http://api:3001/v1/portal/vendor/bill-submissions');
    expect(r.headers.get('idempotency-key')).toBe(IDEM);
    expect(r.body).toEqual({
      documentId: DOC,
      vendorInvoiceNo: 'INV-77',
      invoiceDate: '2026-11-01',
      currency: 'NPR',
      claimedTotal: '2018180.00',
      purchaseOrderId: PO,
    });
  });

  it('leaves the purchase order out when none is chosen', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 201));
    await redirectOf(send());
    expect(callOf(fetchMock, 0).body).not.toHaveProperty('purchaseOrderId');
  });

  it('names each bad field and keeps the unused key, without calling the API', async () => {
    const state = await send({
      documentId: '',
      vendorInvoiceNo: '   ',
      invoiceDate: '11/01/2026',
      currency: 'EUR',
      claimedTotal: '-5',
      purchaseOrderId: 'not-an-id',
    });
    expect(state.key).toBe(IDEM);
    expect(Object.keys(state.fieldErrors ?? {}).sort()).toEqual([
      'claimedTotal',
      'currency',
      'file',
      'invoiceDate',
      'purchaseOrderId',
      'vendorInvoiceNo',
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a customer session without any API call, and a visitor goes to sign in', async () => {
    getSession.mockResolvedValue(vendorSession('customer'));
    expect((await send()).error).toMatch(/vendor account/);
    getSession.mockResolvedValue(null);
    expect(await redirectOf(send())).toBe('/auth/login?returnTo=%2Fvendor%2Fbills%2Fnew');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the key across the in-progress 409 and a timeout, so the retry reuses it', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'idempotency_in_progress' } }, 409));
    const first = await send();
    expect(first.key).toBe(IDEM);
    fetchMock.mockRejectedValueOnce(new TypeError('socket hang up'));
    const second = await submitBillAction(first, form({ idempotencyKey: first.key }));
    expect(second.key).toBe(IDEM);
    fetchMock.mockResolvedValueOnce(json({}, 201));
    await redirectOf(submitBillAction(second, form({ idempotencyKey: second.key })));
    expect([0, 1, 2].map((n) => callOf(fetchMock, n).headers.get('idempotency-key'))).toEqual([
      IDEM,
      IDEM,
      IDEM,
    ]);
  });

  it('says the attached file is infected, naming it, and rotates the key (TR-Q12e)', async () => {
    const message =
      'A virus was found in this file. Remove it or upload a clean copy, then try again.';
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: 'document_infected', message, correlationId: 'corr-1' } }, 409),
    );
    const state = await send();
    expect(state.error).toBe(message);
    expect(state.key).not.toBe(IDEM);
  });

  it('rotates the key after a definite refusal', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'validation_failed' } }, 400));
    const state = await send();
    expect(state.key).not.toBe(IDEM);
    expect(state.error).toMatch(/Check the details/);
  });

  it('shows a 404 on the purchase order against that field, and on the file as a message', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: {} }, 404));
    const po = await send({ purchaseOrderId: PO });
    expect(po.fieldErrors?.purchaseOrderId).toMatch(/could not find that purchase order/);
    expect(po.key).not.toBe(IDEM);
    fetchMock.mockResolvedValueOnce(json({ error: {} }, 404));
    const file = await send();
    expect(file.error).toMatch(/upload it again/);
  });

  it('names a currency the company switched off against the currency field, and rotates the key', async () => {
    // The body the API's error filter sends for D44 (`currencyNotEnabled` in the API).
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'CURRENCY_NOT_ENABLED',
            message: 'Currency USD is not enabled for this company',
            correlationId: 'req-12345678',
            details: { currency: 'USD' },
          },
        },
        422,
      ),
    );
    const state = await send({ currency: 'USD' });
    expect(callOf(fetchMock, 0).body).toMatchObject({ currency: 'USD' });
    expect(state.fieldErrors?.currency).toBe(
      'USD is switched off for the company. Choose another currency.',
    );
    expect(state.error).toBeUndefined();
    expect(state.key).not.toBe(IDEM);
  });

  it('shows a 403 as the account, not the form', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'forbidden' } }, 403));
    const state = await send();
    expect(state.error).toMatch(/cannot send bills/);
    expect(state.fieldErrors).toBeUndefined();
  });
});

describe('submitBillAction total with a space', () => {
  it('says to remove the space for `10 50`, and keeps the generic message for other refusals', async () => {
    expect((await send({ claimedTotal: '10 50' })).fieldErrors?.claimedTotal).toBe(
      'Remove the space inside the number.',
    );
    expect((await send({ claimedTotal: '-5' })).fieldErrors?.claimedTotal).toMatch(/zero or more/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
