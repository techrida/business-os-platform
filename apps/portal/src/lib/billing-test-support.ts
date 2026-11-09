import { vi } from 'vitest';

import { __resetEnvForTests } from './env';
import type { Session } from './session';

/** Shared setup for the billing tests: a customer session, the env the BFF reads, and JSON answers. Not imported by app code. */

export const session: Session = {
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

export const ID = '1f8fad5b-d9cb-469f-a165-70867728950e';
export const IDEM = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

export function stubPortalEnv(): void {
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
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export function callOf(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, n = -1) {
  const [url, init] = fetchMock.mock.calls.at(n) ?? [];
  const requestInit = init ?? {};
  const href = url instanceof Request ? url.url : url instanceof URL ? url.href : (url ?? '');
  return { url: href, init: requestInit, headers: new Headers(requestInit.headers) };
}
