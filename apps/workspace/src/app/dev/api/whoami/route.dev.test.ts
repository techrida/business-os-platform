import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same module ids the route imports, so these mocks replace the real session and API client
// (which need Valkey and a running API).
vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/api', () => ({ getMe: vi.fn() }));

import { getMe } from '@/lib/api';
import { getSession } from '@/lib/session';

import { GET, dynamic, runtime } from './route.dev';

const getSessionMock = vi.mocked(getSession);
const getMeMock = vi.mocked(getMe);

const session = {
  id: 'session-id-secret',
  sub: 'user-1',
  orgId: 'org-from-session',
  orgKind: 'customer',
  roles: ['from-session'],
  accessToken: 'access-token-secret',
  refreshToken: 'refresh-token-secret',
  idToken: 'id-token-secret',
  accessExp: 1,
  createdAt: 1,
  lastSeenAt: 1,
};

const me = {
  userId: 'user-1',
  tenantId: '1b2c3d4e-5f60-4a71-8b92-c3d4e5f60718',
  organizationId: '2c3d4e5f-6071-4b82-9ca3-d4e5f6071829',
  orgKind: 'staff',
  roles: ['admin', 'viewer'],
  correlationId: 'corr-12345678',
  // Not in the contract today. A future field must not leak through the allow-list.
  internalNote: 'must-not-appear',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'development');
  getSessionMock.mockResolvedValue(session as never);
  getMeMock.mockResolvedValue(me as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /dev/api/whoami', () => {
  it('is a Node.js, never-cached route', () => {
    expect(runtime).toBe('nodejs');
    expect(dynamic).toBe('force-dynamic');
  });

  it.each(['production', 'test'])(
    'returns 404 when NODE_ENV is %s, before any lookup',
    async (env) => {
      vi.stubEnv('NODE_ENV', env);
      const res = await GET();
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('');
      expect(getSessionMock).not.toHaveBeenCalled();
      expect(getMeMock).not.toHaveBeenCalled();
    },
  );

  it('returns 401 signed_out without a session and does not call the API', async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'signed_out' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(getMeMock).not.toHaveBeenCalled();
  });

  it('returns 200 with exactly the six allow-listed fields, taken from /v1/me', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(getMeMock).toHaveBeenCalledWith(session);

    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['correlationId', 'orgKind', 'organizationId', 'roles', 'tenantId', 'userId'].sort(),
    );
    expect(body).toEqual({
      userId: me.userId,
      tenantId: me.tenantId,
      organizationId: me.organizationId,
      correlationId: me.correlationId,
      orgKind: me.orgKind,
      roles: me.roles,
    });
    for (const secret of [
      'access-token-secret',
      'refresh-token-secret',
      'id-token-secret',
      'session-id-secret',
      'must-not-appear',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('returns 502 api_unreachable when getMe throws', async () => {
    getMeMock.mockRejectedValue(new Error('ECONNREFUSED access-token-secret'));
    const res = await GET();
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'api_unreachable' });
    expect(text).not.toContain('access-token-secret');
  });
});
