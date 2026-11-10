import { describe, expect, it } from 'vitest';

import {
  ENDPOINTS,
  ZitadelClient,
  ZitadelError,
  createFetchTransport,
  type Transport,
} from './zitadel-client.js';

interface Call {
  method: 'GET' | 'POST' | 'PUT';
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
        calls.push({ method: 'POST', path, body, headers });
        return Promise.resolve(answers[path] ?? {});
      },
      get(path, headers) {
        calls.push({ method: 'GET', path, body: undefined, headers });
        return Promise.resolve(answers[path] ?? {});
      },
      put(path, body, headers) {
        calls.push({ method: 'PUT', path, body, headers });
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

  it('creates the project requiring an authorization (a role) to sign in (CR-02)', async () => {
    const { transport, calls } = recording({ [ENDPOINTS.createProject]: { projectId: 'p1' } });
    await client(transport).createProject('org1', 'business-os');
    expect(calls[0]?.body).toMatchObject({ authorizationRequired: true });
  });

  it('reports whether an existing project requires an authorization (absent means false)', async () => {
    const project = (extra: object) => ({
      projects: [{ projectId: 'p1', organizationId: 'org1', name: 'business-os', ...extra }],
    });
    const off = recording({ [ENDPOINTS.listProjects]: project({}) });
    expect(
      (await client(off.transport).findProject('org1', 'business-os'))?.authorizationRequired,
    ).toBe(false);
    const on = recording({ [ENDPOINTS.listProjects]: project({ authorizationRequired: true }) });
    expect(
      (await client(on.transport).findProject('org1', 'business-os'))?.authorizationRequired,
    ).toBe(true);
  });

  it('turns authorizationRequired on for an existing project without touching other flags', async () => {
    const { transport, calls } = recording({});
    await client(transport).enableAuthorizationRequired('p1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(ENDPOINTS.updateProject);
    expect(calls[0]?.body).toEqual({ projectId: 'p1', authorizationRequired: true });
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

describe('ensureOrgLoginPolicyNoRegister (management v1 login policy, CR-02)', () => {
  // What GET /management/v1/policies/login returns for an org that inherits the instance default.
  const inherited = {
    isDefault: true,
    policy: {
      isDefault: true,
      allowUsernamePassword: true,
      allowRegister: true,
      allowExternalIdp: true,
      passwordlessType: 'PASSWORDLESS_TYPE_ALLOWED',
      passwordCheckLifetime: '864000s',
      secondFactors: ['SECOND_FACTOR_TYPE_OTP'],
      multiFactors: ['MULTI_FACTOR_TYPE_U2F_WITH_VERIFICATION'],
      details: { sequence: '1' },
    },
  };

  it('creates a custom org policy from the inherited one with allowRegister false', async () => {
    const { transport, calls } = recording({ [ENDPOINTS.orgLoginPolicy]: inherited });
    const changed = await client(transport).ensureOrgLoginPolicyNoRegister('staff-org');
    expect(changed).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(calls.every((c) => c.path === ENDPOINTS.orgLoginPolicy)).toBe(true);
    expect(calls.every((c) => c.headers?.['x-zitadel-orgid'] === 'staff-org')).toBe(true);
    expect(calls[1]?.body).toEqual({
      allowUsernamePassword: true,
      allowRegister: false,
      allowExternalIdp: true,
      passwordlessType: 'PASSWORDLESS_TYPE_ALLOWED',
      passwordCheckLifetime: '864000s',
      secondFactors: ['SECOND_FACTOR_TYPE_OTP'],
      multiFactors: ['MULTI_FACTOR_TYPE_U2F_WITH_VERIFICATION'],
    });
  });

  it('updates an existing custom org policy, keeping every other setting', async () => {
    const custom = {
      isDefault: false,
      policy: { ...inherited.policy, isDefault: false, forceMfa: true },
    };
    const { transport, calls } = recording({ [ENDPOINTS.orgLoginPolicy]: custom });
    expect(await client(transport).ensureOrgLoginPolicyNoRegister('staff-org')).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    // Update has no factor lists (they are managed by their own endpoints) and must not drop the rest.
    expect(calls[1]?.body).toEqual({
      allowUsernamePassword: true,
      allowRegister: false,
      allowExternalIdp: true,
      forceMfa: true,
      passwordlessType: 'PASSWORDLESS_TYPE_ALLOWED',
      passwordCheckLifetime: '864000s',
    });
  });

  it('sends nothing but the read when self-registration is already off', async () => {
    const off = {
      isDefault: false,
      policy: { ...inherited.policy, isDefault: false, allowRegister: false },
    };
    const { transport, calls } = recording({ [ENDPOINTS.orgLoginPolicy]: off });
    expect(await client(transport).ensureOrgLoginPolicyNoRegister('staff-org')).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('refuses to copy identity-provider links into a custom policy instead of dropping them', async () => {
    const withIdp = { ...inherited, policy: { ...inherited.policy, idps: [{ idpId: 'i1' }] } };
    const { transport, calls } = recording({ [ENDPOINTS.orgLoginPolicy]: withIdp });
    await expect(client(transport).ensureOrgLoginPolicyNoRegister('o')).rejects.toThrow(
      /identity provider/i,
    );
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('createFetchTransport', () => {
  it('uses GET without a body and PUT with a JSON body for the REST endpoints', async () => {
    const seen: { method: string | undefined; body: unknown; org: string | undefined }[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      seen.push({ method: init?.method, body: init?.body, org: headers['x-zitadel-orgid'] });
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    };
    const transport = createFetchTransport('https://auth.localhost', 'PAT', fetchImpl);
    await transport.get('/a', { 'x-zitadel-orgid': 'o1' });
    await transport.put('/b', { x: 1 });
    expect(seen[0]).toEqual({ method: 'GET', body: undefined, org: 'o1' });
    expect(seen[1]).toMatchObject({ method: 'PUT', body: '{"x":1}' });
  });

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
