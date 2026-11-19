import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hasPermission } from '@/components/p2/customers/permissions';

import { __resetEnvForTests } from './env';
import { getGrants, grantScope, hasGrant } from './grants';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const me = {
  userId: '312345678901234567',
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'staff',
  partyId: null,
  roles: ['sales'],
  correlationId: 'req-12345678',
};

const fetchMock = vi.fn<typeof fetch>();
let token = 0;
/** A new token per test: React `cache` keys on it, and a render pass may share answers. */
const session = () => ({ accessToken: `eyJ.token-${++token}.sig` });

beforeEach(() => {
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
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('getGrants', () => {
  it('answers the live grants from /v1/me for sales, not the role defaults', async () => {
    // An admin removed customer.write from sales and widened verification.read; the API reports the live rows.
    fetchMock.mockResolvedValue(
      Response.json({
        ...me,
        permissions: [
          { permission: 'customer.read', scope: 'all' },
          { permission: 'quotation.read', scope: 'own' },
          { permission: 'verification.read', scope: 'all' },
        ],
      }),
    );
    const grants = await getGrants(session());

    expect(hasGrant(grants, 'customer.read')).toBe(true);
    expect(hasGrant(grants, 'customer.write')).toBe(false);
    expect(grantScope(grants, 'quotation.read')).toBe('own');
    expect(grantScope(grants, 'verification.read')).toBe('all');
    // The old default-role check says the opposite for both, which is the dead end this replaces.
    expect(hasPermission(['sales'], 'customer.write')).toBe(true);
    const [url] = (fetchMock.mock.calls[0] ?? []) as [unknown?];
    expect(url instanceof URL ? url.href : url).toBe('http://api:3001/v1/me');
  });

  it('answers no grants when the API is unreachable, refuses, or sends no list', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection refused'));
    expect((await getGrants(session())).size).toBe(0);

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    expect((await getGrants(session())).size).toBe(0);

    fetchMock.mockResolvedValueOnce(Response.json(me));
    expect((await getGrants(session())).size).toBe(0);
  });

  it('keeps only permission and scope from the response', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ ...me, permissions: [{ permission: 'customer.read', scope: 'own' }] }),
    );
    const grants = await getGrants(session());
    expect([...grants.entries()]).toEqual([['customer.read', 'own']]);
  });
});
