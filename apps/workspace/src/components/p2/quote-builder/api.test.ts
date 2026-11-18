import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

import { createQuotation, submitVersion } from './api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const QID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TAX = '33333333-3333-4333-8333-333333333333';
const KEY = '44444444-4444-4444-8444-444444444444';
const WHEN = '2026-11-08T05:45:00.000Z';

const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: QID,
  orgKind: 'staff',
  roles: ['sales'],
  accessToken: 'eyJ.secret-access-token.sig',
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

const created = {
  id: QID,
  number: 'QT-2082-0042',
  customerId: OTHER,
  opportunityId: OTHER,
  currentVersionId: OTHER,
  ownerUserId: null,
  status: 'draft',
  version: 1,
  createdAt: WHEN,
  updatedAt: WHEN,
};

const body = {
  opportunityId: OTHER,
  currency: 'NPR' as const,
  issueDate: '2026-11-08',
  validUntil: '2026-12-08',
  lines: [{ description: 'Work', uom: 'lot', quantity: '1', unitPrice: '100', taxCodeId: TAX }],
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const sentHeaders = (): Headers => new Headers(fetchMock.mock.calls[0]?.[1]?.headers);

describe('createQuotation', () => {
  it('sends the Idempotency-Key the API requires on POST /v1/quotations', async () => {
    fetchMock.mockResolvedValue(reply(201, created));
    const got = await createQuotation(session, body, KEY);
    expect(got.id).toBe(QID);
    expect(new URL(fetchMock.mock.calls[0]?.[0] as URL | string).pathname).toBe('/v1/quotations');
    expect(sentHeaders().get('idempotency-key')).toBe(KEY);
  });
});

describe('submitVersion', () => {
  it('sends the Idempotency-Key the API requires on submit, with expectedVersion', async () => {
    fetchMock.mockResolvedValue(reply(200, { status: 'submitted' }));
    await submitVersion(session, QID, OTHER, 3, KEY);
    expect(new URL(fetchMock.mock.calls[0]?.[0] as URL | string).pathname).toBe(
      `/v1/quotations/${QID}/versions/${OTHER}/submit`,
    );
    expect(sentHeaders().get('idempotency-key')).toBe(KEY);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      expectedVersion: 3,
    });
  });

  it('sends the chosen first-step approver when there is one', async () => {
    fetchMock.mockResolvedValue(reply(200, { status: 'submitted' }));
    await submitVersion(session, QID, OTHER, 3, KEY, TAX);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      expectedVersion: 3,
      approverUserId: TAX,
    });
  });
});
