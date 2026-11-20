import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

import { findPaymentReferenceMatches } from './api-payments';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const ID_A = '11111111-1111-4111-8111-111111111111';

const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: ID_A,
  orgKind: 'staff',
  roles: ['finance'],
  accessToken: 'eyJ.secret-access-token.sig',
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

const match = {
  id: ID_A,
  number: null,
  customerName: 'Everest Foods',
  receivedOn: '2026-11-05',
  amount: '250.50',
  currency: 'NPR',
  status: 'submitted',
};

const fetchMock = vi.fn<typeof fetch>();
const reply = (body: unknown, status = 200): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

function lastUrl(): string {
  const [url] = fetchMock.mock.calls.at(-1) ?? [];
  return url instanceof Request ? url.url : url instanceof URL ? url.href : (url ?? '');
}

beforeEach(() => {
  vi.stubEnv('API_INTERNAL_URL', 'http://api:3001');
  for (const [k, v] of Object.entries({
    OIDC_ISSUER: 'https://auth.test',
    OIDC_CLIENT_ID: 'client-123',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
    OIDC_AUDIENCE: 'proj-42',
    WORKSPACE_PUBLIC_URL: 'https://app.test',
    VALKEY_URL: 'redis://valkey.test:6379',
    SESSION_ENC_KEY: Buffer.alloc(32, 5).toString('base64'),
  })) {
    vi.stubEnv(k, v);
  }
  __resetEnvForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('findPaymentReferenceMatches', () => {
  it('asks for payments with the same bank reference and returns the matches', async () => {
    fetchMock.mockResolvedValue(reply({ matches: [match] }));
    expect(await findPaymentReferenceMatches(session, 'NIC 77812 & co')).toEqual([match]);
    expect(lastUrl()).toBe(
      'http://api:3001/v1/payments/reference-matches?bankReference=NIC+77812+%26+co',
    );
  });

  it('refuses a body that drifts from the route, and passes a failure on', async () => {
    fetchMock.mockResolvedValue(reply({ matches: [{ ...match, amount: 250.5 }] }));
    await expect(findPaymentReferenceMatches(session, 'NIC')).rejects.toMatchObject({
      status: 502,
    });
    fetchMock.mockResolvedValue(reply({ message: 'Forbidden' }, 403));
    const failure = findPaymentReferenceMatches(session, 'NIC');
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ status: 403 });
  });
});
