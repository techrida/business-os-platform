import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { submitKycDocumentAction } = await import('./actions');

const fetchMock = vi.fn<typeof fetch>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  f.set('idempotencyKey', IDEM);
  f.set('docType', 'pan_certificate');
  f.set('documentId', DOC);
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const send = (fields: Record<string, string> = {}, key = IDEM) =>
  submitKycDocumentAction({ key }, form(fields));

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

describe('submitKycDocumentAction', () => {
  it('sends the checklist item and file with the form key, then goes back to the page with a notice', async () => {
    fetchMock.mockResolvedValueOnce(json({ state: 'submitted' }, 201));
    const to = await redirectOf(send());
    expect(to).toBe('/vendor/onboarding/upload?sent=1');
    expect(revalidatePath).toHaveBeenCalledWith('/vendor');
    const r = callOf(fetchMock, 0);
    expect(r.url).toBe('http://api:3001/v1/portal/vendor/kyc-documents');
    expect(r.headers.get('idempotency-key')).toBe(IDEM);
    expect(r.body).toEqual({ docType: 'pan_certificate', documentId: DOC });
  });

  it('sends the expiry only with a tax clearance', async () => {
    fetchMock.mockResolvedValue(json({}, 201));
    await redirectOf(send({ docType: 'tax_clearance', validUntil: '2999-07-15' }));
    expect(callOf(fetchMock, 0).body).toEqual({
      docType: 'tax_clearance',
      documentId: DOC,
      validUntil: '2999-07-15',
    });
    await redirectOf(send({ validUntil: '2999-07-15' }));
    expect(callOf(fetchMock, 1).body).toEqual({ docType: 'pan_certificate', documentId: DOC });
  });

  it('names each missing field and keeps the unused key, without calling the API', async () => {
    const none = await send({ docType: 'lunch_menu', documentId: '' });
    expect(none.key).toBe(IDEM);
    expect(Object.keys(none.fieldErrors ?? {}).sort()).toEqual(['docType', 'file']);

    const clearance = await send({ docType: 'tax_clearance' });
    expect(clearance.fieldErrors?.validUntil).toMatch(/expires/);
    const lapsed = await send({ docType: 'tax_clearance', validUntil: '2020-01-01' });
    expect(lapsed.fieldErrors?.validUntil).toMatch(/today or later/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a customer session without any API call', async () => {
    getSession.mockResolvedValue(vendorSession('customer'));
    const state = await send();
    expect(state.error).toMatch(/vendor account/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a visitor without a session to sign in and back', async () => {
    getSession.mockResolvedValue(null);
    expect(await redirectOf(send())).toBe('/auth/login?returnTo=%2Fvendor%2Fonboarding%2Fupload');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Same key on the retry: the API replays the first request instead of creating a second one.
  it('keeps the key across the in-progress 409 and an unknown outcome, so a retry reuses it', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'idempotency_in_progress' } }, 409));
    const first = await send();
    expect(first.key).toBe(IDEM);
    expect(first.error).toMatch(/still being recorded/);

    fetchMock.mockRejectedValueOnce(new TypeError('socket hang up'));
    const second = await submitKycDocumentAction(first, form({ idempotencyKey: first.key }));
    expect(second.key).toBe(IDEM);
    expect(second.error).toMatch(/only be recorded once/);

    fetchMock.mockResolvedValueOnce(json({}, 201));
    await redirectOf(submitKycDocumentAction(second, form({ idempotencyKey: second.key })));
    const keys = [0, 1, 2].map((n) => callOf(fetchMock, n).headers.get('idempotency-key'));
    expect(keys).toEqual([IDEM, IDEM, IDEM]);
  });

  it('keeps the key after a 5xx and falls back to the state key for a lost or tampered field', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 503));
    expect((await send()).key).toBe(IDEM);
    fetchMock.mockResolvedValueOnce(json({}, 201));
    const f = form({ idempotencyKey: 'x' });
    await redirectOf(submitKycDocumentAction({ key: IDEM }, f));
    expect(callOf(fetchMock, 1).headers.get('idempotency-key')).toBe(IDEM);
  });

  it('rotates the key after a definite refusal and answers in its own words', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: 'validation_failed', message: 'internal-detail' } }, 400),
    );
    const bad = await send();
    expect(bad.key).toMatch(UUID);
    expect(bad.key).not.toBe(IDEM);
    expect(bad.error).toBe('We could not record your document. Check the details and try again.');
    expect(JSON.stringify(bad)).not.toContain('internal-detail');

    fetchMock.mockResolvedValueOnce(json({ error: { code: 'forbidden' } }, 403));
    const forbidden = await send();
    expect(forbidden.key).not.toBe(IDEM);
    expect(forbidden.error).toMatch(/cannot send documents/);
  });

  it('sends a 401 from the API to sign in', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401));
    expect(await redirectOf(send())).toContain('/auth/login');
  });
});
