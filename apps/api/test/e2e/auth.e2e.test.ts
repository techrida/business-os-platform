// End to end: real AppModule, real Postgres (as bos_app), real Valkey, and tokens shaped like the
// ones ZITADEL issues. Each 401 case below is wrong in exactly ONE way (the token is otherwise
// signed with the trusted key and carries a valid org), so a pass shows that specific check works.
import { ErrorBodySchema, MeResponseSchema } from '@bos/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { CLIENT_ID, PROJECT_ID, startApp, type TestApp } from './support/app';
import { zitadelClaims } from './support/test-issuer';

const e2e = inject('e2e');

let t: TestApp;

beforeAll(async () => {
  t = await startApp();
});

afterAll(async () => {
  await t?.close();
});

/** Every error body must be the shared ErrorBody, with a correlation id that is also the header. */
function expectErrorBody(
  res: { status: number; body: unknown; headers: Record<string, unknown> },
  status: number,
  code: string,
): void {
  expect(res.status).toBe(status);
  const body = ErrorBodySchema.parse(res.body);
  expect(body.error.code).toBe(code);
  expect(res.headers['x-request-id']).toBe(body.error.correlationId);
}

const staffClaims = () =>
  zitadelClaims({
    projectId: PROJECT_ID,
    // Must be the client the API allow-lists (OIDC_CLIENT_ID), or every case below is rejected on
    // `azp` and the one thing it means to test is never reached.
    clientId: CLIENT_ID,
    userId: 'user-e2e-1',
    orgId: e2e.staff.zitadelOrgId,
    roles: ['founder'],
  });

describe('authentication: GET /v1/me must answer 401', () => {
  it('without a token', async () => {
    expectErrorBody(await t.http().get('/v1/me'), 401, 'unauthenticated');
  });

  it('with a malformed Authorization header', async () => {
    const res = await t.http().get('/v1/me').set('authorization', 'Bearer not-a-jwt');
    expectErrorBody(res, 401, 'unauthenticated');
  });

  it('with a forged signature (a different key, same kid)', async () => {
    const token = await t.issuer.mint(staffClaims(), { signWith: 'forged' });
    const res = await t.http().get('/v1/me').set('authorization', `Bearer ${token}`);
    expectErrorBody(res, 401, 'unauthenticated');
  });

  it('with a foreign issuer (trusted key, wrong iss)', async () => {
    const token = await t.issuer.mint(staffClaims(), { issuer: 'https://evil.example.test' });
    const res = await t.http().get('/v1/me').set('authorization', `Bearer ${token}`);
    expectErrorBody(res, 401, 'unauthenticated');
  });

  it('with the wrong audience (trusted key, another project)', async () => {
    const token = await t.issuer.mint(staffClaims(), { audience: ['999999999999999999'] });
    const res = await t.http().get('/v1/me').set('authorization', `Bearer ${token}`);
    expectErrorBody(res, 401, 'unauthenticated');
  });

  it('with an expired token (older than the 30 s clock tolerance)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await t.issuer.mint(staffClaims(), {
      issuedAt: now - 3600,
      expiresAt: now - 120,
    });
    const res = await t.http().get('/v1/me').set('authorization', `Bearer ${token}`);
    expectErrorBody(res, 401, 'unauthenticated');
  });

  it('with an azp that is not an allowed client (trusted key, otherwise valid claims)', async () => {
    const token = await t.issuer.mint({ ...staffClaims(), azp: 'some-other-client' });
    const res = await t.http().get('/v1/me').set('authorization', `Bearer ${token}`);
    expectErrorBody(res, 401, 'unauthenticated');
  });

  it('with alg: none (unsigned, otherwise valid claims)', async () => {
    const token = t.issuer.mintUnsigned(staffClaims(), { audience: [PROJECT_ID, CLIENT_ID] });
    // Sanity: this really is an unsigned token, so the test cannot pass by accident of format.
    const header = JSON.parse(
      Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'),
    ) as {
      alg: string;
    };
    expect(header.alg).toBe('none');
    const res = await t.http().get('/v1/me').set('authorization', `Bearer ${token}`);
    expectErrorBody(res, 401, 'unauthenticated');
  });

  it('with x-dev-user / x-test-user headers and no token (there is no header bypass)', async () => {
    const res = await t
      .http()
      .get('/v1/me')
      .set('x-dev-user', 'admin')
      .set('x-test-user', 'admin')
      .set('x-user-id', 'admin');
    expectErrorBody(res, 401, 'unauthenticated');
  });
});

describe('GET /v1/me with a valid token', () => {
  it('answers 200 for a staff user, with the seeded tenant and org, and echoes x-request-id', async () => {
    const token = await t.token(e2e.staff, { userId: 'user-staff-1', roles: ['founder'] });
    const res = await t
      .http()
      .get('/v1/me')
      .set('authorization', `Bearer ${token}`)
      .set('x-request-id', 'e2e-correlation-0001');

    expect(res.status).toBe(200);
    const me = MeResponseSchema.parse(res.body);
    expect(me).toEqual({
      userId: 'user-staff-1',
      tenantId: e2e.tenantId,
      organizationId: e2e.staff.organizationId,
      orgKind: 'staff',
      partyId: null,
      roles: ['founder'],
      correlationId: 'e2e-correlation-0001',
      permissions: expect.any(Array) as unknown,
      // Added by later rounds (stale expectation, not a regression): the caller's own users row id and picture
      // (U12 avatar), the name for the shell's user card (U15a-Q2 `displayName`), and the membership level and
      // department (D50 level grants, apps/api me.ts / packages/contracts me.ts). This seeded user has no name,
      // picture or department.
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      avatarDocumentId: null,
      displayName: null,
      level: 'staff',
      departmentId: null,
    });
    // Founder holds every permission at scope all, read from the seeded role rows.
    expect(me.permissions).toContainEqual({ permission: 'customer.write', scope: 'all' });
    expect(me.permissions?.every((g) => g.scope === 'all')).toBe(true);
    expect(res.headers['x-request-id']).toBe('e2e-correlation-0001');
  });

  it('answers orgKind customer for a token from the customer org', async () => {
    const token = await t.token(e2e.customer, {
      userId: 'user-customer-1',
      roles: ['customer_user'],
    });
    const res = await t.http().get('/v1/me').set('authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const me = MeResponseSchema.parse(res.body);
    expect(me.orgKind).toBe('customer');
    // A portal user acts in the tenant's default entity and is identified by its party (ADR 0027).
    expect(me.organizationId).toBe(e2e.customer.organizationId);
    expect(me.partyId).toBe(e2e.customer.partyId);
    expect(me.partyId).not.toBeNull();
    expect(me.tenantId).toBe(e2e.tenantId);
    expect(me.roles).toEqual(['customer_user']);
  });

  it('shows only roles granted in the caller own org, never one granted in another org', async () => {
    // A staff user who is `founder` only in the customer org, and `sales` in their own org.
    const token = await t.issuer.mint(
      zitadelClaims({
        projectId: PROJECT_ID,
        clientId: CLIENT_ID,
        userId: 'user-staff-cross-org',
        orgId: e2e.staff.zitadelOrgId,
        roles: ['sales'],
        rolesInOtherOrgs: { [e2e.customer.zitadelOrgId]: ['founder'] },
      }),
    );
    const res = await t.http().get('/v1/me').set('authorization', `Bearer ${token}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const me = MeResponseSchema.parse(res.body);
    expect(me.organizationId).toBe(e2e.staff.organizationId);
    expect(me.roles).toEqual(['sales']);
  });

  it('answers 403 forbidden for a valid token whose org is not registered', async () => {
    const token = await t.token({ zitadelOrgId: '310000000000999999' });
    const res = await t.http().get('/v1/me').set('authorization', `Bearer ${token}`);
    expectErrorBody(res, 403, 'forbidden');
    // The message must not reveal which orgs exist.
    expect(JSON.stringify(res.body)).not.toContain('310000000000999999');
  });

  it('answers 403 forbidden for a valid token that names no organization', async () => {
    const claims = { ...staffClaims() };
    delete claims['urn:zitadel:iam:user:resourceowner:id'];
    const token = await t.issuer.mint(claims);
    const res = await t.http().get('/v1/me').set('authorization', `Bearer ${token}`);
    expectErrorBody(res, 403, 'forbidden');
  });
});

describe('health', () => {
  it('GET /health/live is 200 without a token', async () => {
    const res = await t.http().get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready is 200 without a token once the JWKS warm-up has run', async () => {
    // The warm-up runs in the background after bootstrap, so readiness may need a moment.
    const deadline = Date.now() + 10_000;
    let res = await t.http().get('/health/ready');
    while (res.status !== 200 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      res = await t.http().get('/health/ready');
    }
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as { status: string; info?: Record<string, { status: string }> };
    expect(body.status).toBe('ok');
    // Postgres, Valkey and JWKS are each reported, so a dependency cannot silently drop out.
    expect(Object.keys(body.info ?? {}).sort()).toEqual(['db', 'jwks', 'valkey']);
  });
});

describe('POST /v1/telemetry/vitals', () => {
  const lcp = { name: 'LCP', value: 1234, route: '/', id: 'v3-1700000000000-1' };

  it('answers 401 without a token', async () => {
    expectErrorBody(await t.http().post('/v1/telemetry/vitals').send(lcp), 401, 'unauthenticated');
  });

  it('answers 202 for a valid LCP sample', async () => {
    const token = await t.token(e2e.staff, { roles: ['sales'] });
    const res = await t
      .http()
      .post('/v1/telemetry/vitals')
      .set('authorization', `Bearer ${token}`)
      .send(lcp);
    expect(res.status).toBe(202);
  });

  it('answers 413 payload_too_large for a 3 KB body (valid JSON, under the 16 kb parser limit)', async () => {
    const token = await t.token(e2e.staff, { roles: ['sales'] });
    const body = { ...lcp, id: 'x'.repeat(3000) };
    expect(JSON.stringify(body).length).toBeGreaterThan(3000);
    const res = await t
      .http()
      .post('/v1/telemetry/vitals')
      .set('authorization', `Bearer ${token}`)
      .send(body);
    expectErrorBody(res, 413, 'payload_too_large');
  });

  it('answers 413 payload_too_large for a body over the 16 kb parser limit', async () => {
    const token = await t.token(e2e.staff, { roles: ['sales'] });
    const res = await t
      .http()
      .post('/v1/telemetry/vitals')
      .set('authorization', `Bearer ${token}`)
      .send({ ...lcp, id: 'x'.repeat(20_000) });
    expectErrorBody(res, 413, 'payload_too_large');
  });

  it('answers 400 bad_request for a sample that fails validation', async () => {
    const token = await t.token(e2e.staff, { roles: ['sales'] });
    const res = await t
      .http()
      .post('/v1/telemetry/vitals')
      .set('authorization', `Bearer ${token}`)
      .send({ ...lcp, name: 'NOPE' });
    expectErrorBody(res, 400, 'bad_request');
  });
});

describe('the anonymous company logo: GET /v1/public/logo/:tenantId (R6Q20b)', () => {
  it('is reached with no token through the real guard chain: a refusal is the 404 error body, never a 401', async () => {
    const res = await t.http().get('/v1/public/logo/00000000-0000-4000-8000-000000000001');
    expectErrorBody(res, 404, 'not_found');
    expect(res.headers['cache-control'] ?? '').not.toContain('public');
  });

  it('does not make the per-document form, or anything else under /v1/public, a public route', async () => {
    const tenant = '00000000-0000-4000-8000-000000000001';
    for (const path of [`/v1/public/logo/${tenant}/${tenant}`, '/v1/public/me', '/v1/public']) {
      expect((await t.http().get(path)).status, path).not.toBe(200);
    }
  });
});
