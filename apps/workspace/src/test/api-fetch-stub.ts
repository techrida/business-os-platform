// Page tests that let the real API client (env check, fetch, zod parse) run against a stubbed `fetch`, so a field
// the API sends but the client schema drops fails the test instead of passing through a mocked client.
import {
  DEFAULT_ROLE_PERMISSIONS,
  type MeResponse,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { vi } from 'vitest';

import { __resetEnvForTests } from '@/lib/env';

/** The env the API client validates before any fetch; without it no request would reach the stub. */
export function stubApiEnv(): void {
  for (const [k, v] of Object.entries({
    API_INTERNAL_URL: 'http://api:3001',
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
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const forbidden = (): Response =>
  json(403, { error: { code: 'forbidden', message: 'Forbidden', correlationId: 'c' } });

/**
 * Stubs `fetch` with `routes` (path → body, answered 200); any other path is a 403, as for a role without the
 * directory. Returns the mock so a test can read which paths were asked.
 */
export function stubApi(routes: () => Record<string, unknown>) {
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const path = new URL(input as URL | string).pathname;
    const table = routes();
    return Promise.resolve(path in table ? json(200, table[path]) : forbidden());
  });
  stubApiEnv();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The `GET /v1/me` body of a staff user holding `role` as seeded (its default grants), for a `/v1/me` route. */
export function meAs(role: RoleKey): MeResponse {
  return {
    userId: 'user-1',
    tenantId: '00000000-0000-4000-8000-000000000001',
    organizationId: '00000000-0000-4000-8000-000000000001',
    orgKind: 'staff',
    partyId: null,
    roles: [role],
    correlationId: 'corr-12345678',
    permissions: (Object.entries(DEFAULT_ROLE_PERMISSIONS[role]) as [Permission, Scope][]).map(
      ([permission, scope]) => ({ permission, scope }),
    ),
  };
}

/** Page text without tags, for `toContain` checks. */
export const textOf = (html: string): string => html.replace(/<[^>]*>/g, ' ');
