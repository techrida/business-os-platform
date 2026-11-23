import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { acceptAction, rejectAction } = await import('./actions');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const IDEM = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'customer',
  partyId: '00000000-0000-4000-8000-0000000000aa',
  roles: [],
  accessToken: 'eyJ.secret-access-token.sig',
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  f.set('quotationId', ID);
  f.set('idempotencyKey', IDEM);
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
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

function lastRequest(): { url: string; headers: Headers; body: unknown } {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  return {
    url: url instanceof URL ? url.href : (url as string),
    headers: new Headers(init?.headers),
    body: JSON.parse(init?.body as string) as unknown,
  };
}

beforeEach(() => {
  for (const [k, v] of Object.entries({
    API_INTERNAL_URL: 'http://api:3001',
    OIDC_ISSUER: 'https://auth.test',
    OIDC_CLIENT_ID: 'client-123',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
    OIDC_AUDIENCE: 'proj-42',
    PORTAL_PUBLIC_URL: 'https://app.test',
    VALKEY_URL: 'redis://valkey.test:6379',
    SESSION_ENC_KEY: Buffer.alloc(32, 5).toString('base64'),
  })) {
    vi.stubEnv(k, v);
  }
  __resetEnvForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  getSession.mockReset();
  getSession.mockResolvedValue(session);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('acceptAction', () => {
  it('asks for a name and the confirmation before calling the API, keeping the key', async () => {
    const noName = await acceptAction({ key: IDEM }, form({ acceptedByName: '  ', confirm: 'on' }));
    expect(noName.key).toBe(IDEM);
    expect(noName.nameError).toBeTruthy();
    const noConfirm = await acceptAction({ key: IDEM }, form({ acceptedByName: 'Jules' }));
    expect(noConfirm.key).toBe(IDEM);
    expect(noConfirm.confirmError).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs {acceptedByName, confirm:true} with the Idempotency-Key, then shows the result', async () => {
    fetchMock.mockResolvedValue(json({}));
    const to = await redirectOf(
      acceptAction({ key: IDEM }, form({ acceptedByName: ' Jules Winnfield ', confirm: 'on' })),
    );
    expect(to).toBe(`/quotations/${ID}?responded=accepted`);
    const req = lastRequest();
    expect(req.url).toBe(`http://api:3001/v1/portal/quotations/${ID}/accept`);
    expect(req.headers.get('idempotency-key')).toBe(IDEM);
    expect(req.body).toEqual({ acceptedByName: 'Jules Winnfield', confirm: true });
  });

  it('on 409 asks for a reload and rotates the key; after a 503 it keeps the key', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'conflict' } }, 409));
    const stale = await acceptAction({ key: IDEM }, form({ acceptedByName: 'J', confirm: 'on' }));
    expect(stale.reload).toBe(true);
    expect(stale.key).not.toBe(IDEM);
    expect(stale.error).toMatch(/reload/i);

    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
    const down = await acceptAction({ key: IDEM }, form({ acceptedByName: 'J', confirm: 'on' }));
    expect(down.key).toBe(IDEM);
    expect(down.reload).toBeUndefined();
    expect(down.error).toBeTruthy();
  });

  it('sends the customer to the "no longer open" page when the deal was lost while the page was open (R6D)', async () => {
    const closed = () =>
      json(
        { error: { code: 'quotation_closed', message: 'This quotation is no longer open' } },
        409,
      );
    fetchMock.mockResolvedValueOnce(closed());
    expect(
      await redirectOf(acceptAction({ key: IDEM }, form({ acceptedByName: 'J', confirm: 'on' }))),
    ).toBe(`/quotations/${ID}`);
    fetchMock.mockResolvedValueOnce(closed());
    expect(await redirectOf(rejectAction({ key: IDEM }, form({ comment: 'No' })))).toBe(
      `/quotations/${ID}`,
    );
  });

  it('never answers an acceptance with "contact us": the API records it whatever the evidence policy (F1-Q28)', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        { error: { code: 'evidence_policy_unmet', message: 'policy 7 needs evidence kind x' } },
        422,
      ),
    );
    const res = await acceptAction({ key: IDEM }, form({ acceptedByName: 'J', confirm: 'on' }));
    expect(res.error).toBe('We could not record your response. Check the form and try again.');
    expect(res.error).not.toMatch(/contact us/i);
  });

  it('keeps the generic wording for any other 422', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'bad_request', message: 'x' } }, 422));
    const res = await acceptAction({ key: IDEM }, form({ acceptedByName: 'J', confirm: 'on' }));
    expect(res.error).toBe('We could not record your response. Check the form and try again.');
  });

  it('never shows API detail text, and answers a 404 or 403 as "Quotation not found"', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: 'forbidden', message: 'party 00aa does not own quotation' } }, 403),
    );
    const res = await acceptAction({ key: IDEM }, form({ acceptedByName: 'J', confirm: 'on' }));
    expect(res.error).toBe('Quotation not found.');
  });

  it('refuses a tampered id without calling the API, and sends a signed-out user to sign in', async () => {
    const f = form({ acceptedByName: 'J', confirm: 'on' });
    f.set('quotationId', '../admin');
    expect((await acceptAction({ key: IDEM }, f)).reload).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    getSession.mockResolvedValue(null);
    const to = await redirectOf(
      acceptAction({ key: IDEM }, form({ acceptedByName: 'J', confirm: 'on' })),
    );
    expect(to).toBe(`/auth/login?returnTo=${encodeURIComponent(`/quotations/${ID}`)}`);
  });
});

// Server actions run no layout, so each one checks the kind itself. A vendor session gets the same
// answer as a signed-out visitor and the API is never called.
describe('customer-only actions', () => {
  it.each([
    ['acceptAction', acceptAction, { acceptedByName: 'J', confirm: 'on' }],
    ['rejectAction', rejectAction, { comment: 'Over budget' }],
  ])('%s refuses a vendor session like a signed-out one', async (_name, action, fields) => {
    getSession.mockResolvedValue({ ...session, orgKind: 'vendor' });
    const to = await redirectOf(action({ key: IDEM }, form(fields)));
    expect(to).toBe(`/auth/login?returnTo=${encodeURIComponent(`/quotations/${ID}`)}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('rejectAction', () => {
  it('needs a comment, then POSTs it with the key and shows the result', async () => {
    const empty = await rejectAction({ key: IDEM }, form({ comment: '   ' }));
    expect(empty.key).toBe(IDEM);
    expect(empty.commentError).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const to = await redirectOf(rejectAction({ key: IDEM }, form({ comment: 'Over budget' })));
    expect(to).toBe(`/quotations/${ID}?responded=rejected`);
    const req = lastRequest();
    expect(req.url).toBe(`http://api:3001/v1/portal/quotations/${ID}/reject`);
    expect(req.headers.get('idempotency-key')).toBe(IDEM);
    expect(req.body).toEqual({ comment: 'Over budget' });
  });
});
