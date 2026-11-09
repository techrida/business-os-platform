import { renderToStaticMarkup } from 'react-dom/server';
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
} from '../_upload/test-kit';

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

const { requestBankChangeAction } = await import('./actions');
const { BankForm } = await import('./_components/bank-form');

const fetchMock = vi.fn<typeof fetch>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = '0123456789012';

const dto = {
  id: DOC,
  vendorPartyId: PO,
  bankName: 'Nabil Bank',
  branch: null,
  accountName: 'Himal Traders Pvt Ltd',
  accountLast4: '9012',
  status: 'proposed',
  proposedVia: 'portal',
  verifiedAt: null,
};

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  f.set('idempotencyKey', IDEM);
  f.set('bankName', 'Nabil Bank');
  f.set('branch', '');
  f.set('accountName', 'Himal Traders Pvt Ltd');
  f.set('accountNumber', NUMBER);
  f.set('confirmAccountNumber', NUMBER);
  f.set('swift', '');
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const send = (fields: Record<string, string> = {}) =>
  requestBankChangeAction({ key: IDEM }, form(fields));

/** Every outcome an action can have must leave the number out of what it hands back. */
const noNumber = (state: unknown) => expect(JSON.stringify(state)).not.toContain(NUMBER);

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

describe('requestBankChangeAction', () => {
  it('sends the account with the form key, strips spaces, and sends no party id or document', async () => {
    fetchMock.mockResolvedValueOnce(json(dto, 201));
    const state = await send({
      accountNumber: '0123 4567 89012',
      confirmAccountNumber: NUMBER,
      swift: 'NARBNPKA',
      branch: ' Kamaladi ',
    });
    const r = callOf(fetchMock, 0);
    expect(r.url).toBe('http://api:3001/v1/portal/vendor/bank-change-requests');
    expect(r.headers.get('idempotency-key')).toBe(IDEM);
    expect(r.body).toEqual({
      bankName: 'Nabil Bank',
      accountName: 'Himal Traders Pvt Ltd',
      accountNumber: NUMBER,
      branch: 'Kamaladi',
      swift: 'NARBNPKA',
    });
    // The page reads no bank data and the form shows the answer from this state: a revalidate
    // would remount it and lose the confirmation.
    expect(revalidatePath).not.toHaveBeenCalled();
    // Success shows the bank and the last four, and rotates the key for the next request.
    expect(state.received).toEqual({ bankName: 'Nabil Bank', last4: '9012' });
    expect(state.key).toMatch(UUID);
    expect(state.key).not.toBe(IDEM);
    noNumber(state);
    expect(JSON.stringify(state)).not.toContain(PO);
  });

  it('still reports success when the API answer cannot be read, without a made-up last four', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 201 }));
    const state = await send();
    expect(state.received).toEqual({ bankName: null, last4: null });
    noNumber(state);
  });

  it('names each bad field, keeps the unused key and never echoes the number', async () => {
    const short = await send({ accountNumber: '123', confirmAccountNumber: '123' });
    expect(short.fieldErrors?.accountNumber).toMatch(/6 to 34/);
    expect(short.key).toBe(IDEM);
    const odd = await send({ accountNumber: '0123*456789', confirmAccountNumber: '0123*456789' });
    expect(odd.fieldErrors?.accountNumber).toBeDefined();
    expect(JSON.stringify(odd)).not.toContain('0123*456789');

    const mismatch = await send({ confirmAccountNumber: '0123456789999' });
    expect(Object.keys(mismatch.fieldErrors ?? {})).toEqual(['confirmAccountNumber']);
    noNumber(mismatch);
    expect(JSON.stringify(mismatch)).not.toContain('0123456789999');

    const empty = await send({ bankName: '  ', accountName: '', swift: 'abc' });
    expect(Object.keys(empty.fieldErrors ?? {}).sort()).toEqual([
      'accountName',
      'bankName',
      'swift',
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a customer session without any API call, and a visitor goes to sign in', async () => {
    getSession.mockResolvedValue(vendorSession('customer'));
    const state = await send();
    expect(state.error).toMatch(/vendor account/);
    noNumber(state);
    getSession.mockResolvedValue(null);
    expect(await redirectOf(send())).toBe('/auth/login?returnTo=%2Fvendor%2Fbank-account');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the key across the in-progress 409 and a timeout so the retry reuses it, with no number in either state', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'idempotency_in_progress' } }, 409));
    const first = await send();
    expect(first.key).toBe(IDEM);
    noNumber(first);
    fetchMock.mockRejectedValueOnce(new TypeError('socket hang up'));
    const second = await requestBankChangeAction(first, form({ idempotencyKey: first.key }));
    expect(second.key).toBe(IDEM);
    noNumber(second);
    fetchMock.mockResolvedValueOnce(json(dto, 201));
    const done = await requestBankChangeAction(second, form({ idempotencyKey: second.key }));
    expect(done.received?.last4).toBe('9012');
    expect([0, 1, 2].map((n) => callOf(fetchMock, n).headers.get('idempotency-key'))).toEqual([
      IDEM,
      IDEM,
      IDEM,
    ]);
  });

  it('answers a refusal in its own words, rotates the key, and leaves the number out even if the API echoed it', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: 'validation_failed', message: `bad ${NUMBER}` } }, 400),
    );
    const bad = await send();
    expect(bad.key).not.toBe(IDEM);
    expect(bad.error).toMatch(/Check the details/);
    noNumber(bad);
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'forbidden' } }, 403));
    const forbidden = await send();
    expect(forbidden.error).toMatch(/cannot change bank details/);
    noNumber(forbidden);
    fetchMock.mockResolvedValueOnce(json({ error: {} }, 503));
    const down = await send();
    expect(down.key).toBe(IDEM);
    noNumber(down);
  });
});

describe('BankForm markup', () => {
  const markup = (state: Parameters<typeof BankForm>[0]['initialState']) =>
    renderToStaticMarkup(<BankForm idempotencyKey={IDEM} initialState={state} />);

  it('never contains the account number, whatever state the action left it in', () => {
    const states = [
      { key: IDEM },
      { key: IDEM, fieldErrors: { accountNumber: 'Enter the account number.' } },
      { key: IDEM, error: 'We could not confirm your bank account request just now.' },
      { key: IDEM, received: { bankName: 'Nabil Bank', last4: '9012' } },
      { key: IDEM, received: { bankName: null, last4: null } },
    ];
    for (const state of states) expect(markup(state)).not.toContain(NUMBER);
  });

  it('confirms with the bank and the last four digits only', () => {
    const html = markup({ key: IDEM, received: { bankName: 'Nabil Bank', last4: '9012' } });
    expect(html).toContain('the Nabil Bank account ending 9012');
    expect(html).toContain('check it with you before we pay into it');
    expect(markup({ key: IDEM, received: { bankName: null, last4: null } })).toContain(
      'We received your request. ',
    );
  });

  it('has labelled fields, the key, and a number field that is not autofilled or spell-checked', () => {
    const html = markup(undefined);
    for (const label of ['Bank name', 'Account name', 'Account number', 'Account number again']) {
      expect(html).toContain(`>${label}</label>`);
    }
    expect(html).toContain(`name="idempotencyKey" value="${IDEM}"`);
    expect(html).toMatch(/name="accountNumber"[^>]*/);
    expect(html).not.toContain('name="documentId"');
    expect(html).not.toContain('supportingDocumentId');
    expect(html).not.toContain('type="file"');
  });
});
