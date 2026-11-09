import { vi } from 'vitest';

import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

/** Shared setup for the vendor write tests. Not imported by any page or route. */

export const DOC = '0f8fad5b-d9cb-469f-a165-70867728950e';
export const VER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const IDEM = '3b241101-e2bb-4255-8caf-4136c566a962';
export const PO = '9b2d7a1e-5c3f-4e8a-8f10-2a6b7c8d9e01';

export const vendorSession = (orgKind: Session['orgKind'] = 'vendor'): Session => ({
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgKind,
  partyId: '00000000-0000-4000-8000-0000000000aa',
  roles: [],
  accessToken: 'eyJ.secret-access-token.sig',
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
});

/** The portal's server environment, so API calls resolve to `http://api:3001`. */
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
  new Response(JSON.stringify(body), { status });

/** What a `redirect()` throws in these tests. */
export class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

export async function redirectOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof Redirect)) throw new Error('expected a redirect');
  return err.to;
}

/** The nth call a `fetch` mock saw, with its URL, headers and JSON body (when it has one). */
export function callOf(
  fetchMock: { mock: { calls: unknown[][] } },
  n: number,
): { url: string; headers: Headers; body: unknown; init: RequestInit } {
  const [url, init] = (fetchMock.mock.calls[n] ?? []) as [URL | string, RequestInit | undefined];
  const init2 = init ?? {};
  return {
    url: url instanceof URL ? url.href : String(url),
    headers: new Headers(init2.headers),
    body: typeof init2.body === 'string' ? (JSON.parse(init2.body) as unknown) : init2.body,
    init: init2,
  };
}
