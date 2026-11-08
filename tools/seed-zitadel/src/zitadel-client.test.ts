import { describe, expect, it } from 'vitest';

import {
  ENDPOINTS,
  ZitadelClient,
  ZitadelError,
  createFetchTransport,
  type Transport,
} from './zitadel-client.js';

interface Call {
  path: string;
  body: unknown;
  headers: Record<string, string> | undefined;
}

function recording(answers: Record<string, unknown>): { transport: Transport; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    transport: {
      post(path, body, headers) {
        calls.push({ path, body, headers });
        return Promise.resolve(answers[path] ?? {});
      },
    },
  };
}

const client = (transport: Transport): ZitadelClient =>
  new ZitadelClient({ transport, baseUrl: 'https://auth.localhost', projectionWaitMs: 0 });

describe('ZitadelClient request shapes', () => {
  it('creates the OIDC app as web + code + NONE auth with JWT access tokens and role assertion', async () => {
    const { transport, calls } = recording({
      [ENDPOINTS.createApp]: { applicationId: 'a1', oidcConfiguration: { clientId: 'c1' } },
    });
    const app = await client(transport).createOidcApp('p1', {
      name: 'workspace',
      redirectUris: ['https://app.localhost/auth/callback'],
      postLogoutRedirectUris: ['https://app.localhost/'],
    });
    expect(app.clientId).toBe('c1');
    expect(calls[0]?.body).toMatchObject({
      projectId: 'p1',
      oidcConfiguration: {
        responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
        applicationType: 'OIDC_APP_TYPE_WEB',
        authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
        accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
        accessTokenRoleAssertion: true,
        developmentMode: true,
      },
    });
  });

  it('creates the project with role assertion on', async () => {
    const { transport, calls } = recording({ [ENDPOINTS.createProject]: { projectId: 'p1' } });
    await client(transport).createProject('org1', 'business-os');
    expect(calls[0]?.body).toMatchObject({
      organizationId: 'org1',
      name: 'business-os',
      projectRoleAssertion: true,
    });
  });

  it('creates machine users with JWT access tokens', async () => {
    const { transport, calls } = recording({ [ENDPOINTS.createUser]: { id: 'u1' } });
    await client(transport).createMachineUser({
      orgId: 'o',
      username: 'bos-loadtest',
      name: 'n',
      description: 'd',
    });
    expect(calls[0]?.body).toMatchObject({ machine: { accessTokenType: 'ACCESS_TOKEN_TYPE_JWT' } });
  });

  it('marks human emails verified and does not force a password change', async () => {
    const { transport, calls } = recording({
      [ENDPOINTS.createUser]: { id: 'u1' },
      [ENDPOINTS.listUsers]: {
        result: [{ userId: 'u1', preferredLoginName: 'founder@dev.bos.test' }],
      },
    });
    const user = await client(transport).createHumanUser({
      orgId: 'o',
      username: 'founder@dev.bos.test',
      email: 'founder@dev.bos.test',
      givenName: 'Dev',
      familyName: 'Founder',
      password: 'x'.repeat(24),
    });
    expect(user.preferredLoginName).toBe('founder@dev.bos.test');
    expect(calls[0]?.body).toMatchObject({
      human: { email: { isVerified: true }, password: { changeRequired: false } },
    });
  });

  it('sends the org id header for management v1 calls', async () => {
    const { transport, calls } = recording({
      [ENDPOINTS.listOrgMembers]: { result: [{ userId: 'u1', roles: ['ORG_USER_MANAGER'] }] },
    });
    const roles = await client(transport).listOrgMemberRoles('org1', 'u1');
    expect(roles).toEqual(['ORG_USER_MANAGER']);
    expect(calls[0]?.headers).toEqual({ 'x-zitadel-orgid': 'org1' });
  });

  it('rejects responses that do not match the expected shape', async () => {
    const { transport } = recording({ [ENDPOINTS.createProject]: { nope: true } });
    await expect(client(transport).createProject('o', 'n')).rejects.toThrow(/CreateProject/);
  });
});

describe('createFetchTransport', () => {
  it('sends Connect JSON with the bearer token and keeps the token out of errors', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen = { url, init: init ?? {} };
      return Promise.resolve(
        new Response(JSON.stringify({ code: 'permission_denied', message: 'nope' }), {
          status: 403,
        }),
      );
    };
    const transport = createFetchTransport('https://auth.localhost/', 'SECRET-PAT', fetchImpl);
    const error = await transport.post('/x.Y/Z', { a: 1 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ZitadelError);
    expect((error as ZitadelError).message).toContain('permission_denied');
    expect((error as ZitadelError).message).not.toContain('SECRET-PAT');
    expect(seen?.url).toBe('https://auth.localhost/x.Y/Z');
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers['connect-protocol-version']).toBe('1');
    expect(headers['authorization']).toBe('Bearer SECRET-PAT');
  });
});
