import { describe, expect, it } from 'vitest';

import {
  ENDPOINTS,
  FORCE_MFA_POLICY,
  PORTAL_LOGIN_POLICY,
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

// An answer is a plain value, an Error (rejects), or a function of the call (for answers that
// depend on the request, such as "reject the first condition shape").
function recording(answers: Record<string, unknown>): { transport: Transport; calls: Call[] } {
  const calls: Call[] = [];
  const answer = (call: Call): Promise<unknown> => {
    calls.push(call);
    try {
      const raw = answers[call.path];
      const value = typeof raw === 'function' ? (raw as (c: Call) => unknown)(call) : raw;
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(value ?? {});
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return {
    calls,
    transport: {
      post: (path, body, headers) => answer({ method: 'POST', path, body, headers }),
      get: (path, headers) => answer({ method: 'GET', path, body: undefined, headers }),
      put: (path, body, headers) => answer({ method: 'PUT', path, body, headers }),
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

  it('reads and adds instance (IAM) members through admin v1, with no org header', async () => {
    const { transport, calls } = recording({
      [ENDPOINTS.listIamMembers]: {
        result: [
          { userId: 'u0', roles: ['IAM_OWNER'] },
          { userId: 'u1', roles: ['IAM_ORG_MANAGER'] },
        ],
      },
    });
    const api = client(transport);
    await expect(api.listIamMemberRoles('u1')).resolves.toEqual(['IAM_ORG_MANAGER']);
    await expect(api.listIamMemberRoles('u9')).resolves.toBeUndefined();
    await api.addIamMember('u2', ['IAM_ORG_MANAGER']);
    expect(calls.map((c) => [c.method, c.path, c.body, c.headers])).toEqual([
      ['POST', '/admin/v1/members/_search', {}, undefined],
      ['POST', '/admin/v1/members/_search', {}, undefined],
      ['POST', '/admin/v1/members', { userId: 'u2', roles: ['IAM_ORG_MANAGER'] }, undefined],
    ]);
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

describe('ensureOrgLoginPolicy (pins the customer org policy)', () => {
  const inherited = {
    isDefault: true,
    policy: {
      isDefault: true,
      allowUsernamePassword: true,
      allowRegister: false,
      allowExternalIdp: true,
      forceMfa: true,
      forceMfaLocalOnly: false,
      mfaInitSkipLifetime: '0s',
      passwordCheckLifetime: '864000s',
      secondFactors: ['SECOND_FACTOR_TYPE_OTP'],
      multiFactors: [],
    },
  };
  const custom = (over: Record<string, unknown>) => ({
    isDefault: false,
    policy: { ...inherited.policy, isDefault: false, ...over },
  });

  it('turns an inherited policy into a custom one even when the values already match', async () => {
    const { transport, calls } = recording({ [ENDPOINTS.orgLoginPolicy]: inherited });
    expect(await client(transport).ensureOrgLoginPolicy('cust-org', PORTAL_LOGIN_POLICY)).toBe(
      true,
    );
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(calls.every((c) => c.headers?.['x-zitadel-orgid'] === 'cust-org')).toBe(true);
    expect(calls[1]?.body).toEqual({
      allowUsernamePassword: true,
      allowExternalIdp: true,
      passwordCheckLifetime: '864000s',
      ...PORTAL_LOGIN_POLICY,
      secondFactors: ['SECOND_FACTOR_TYPE_OTP'],
      multiFactors: [],
    });
  });

  it('updates a custom policy that differs, keeping every other setting', async () => {
    const { transport, calls } = recording({
      [ENDPOINTS.orgLoginPolicy]: custom({ allowRegister: true, forceMfa: false }),
    });
    expect(await client(transport).ensureOrgLoginPolicy('cust-org', PORTAL_LOGIN_POLICY)).toBe(
      true,
    );
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(calls[1]?.body).toEqual({
      allowUsernamePassword: true,
      allowExternalIdp: true,
      passwordCheckLifetime: '864000s',
      ...PORTAL_LOGIN_POLICY,
    });
  });

  it('sends nothing but the read when a custom policy already matches', async () => {
    const { transport, calls } = recording({ [ENDPOINTS.orgLoginPolicy]: custom({}) });
    expect(await client(transport).ensureOrgLoginPolicy('cust-org', PORTAL_LOGIN_POLICY)).toBe(
      false,
    );
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it.each([
    { omitted: ['forceMfaLocalOnly'] },
    { omitted: ['mfaInitSkipLifetime'] },
    { omitted: ['forceMfaLocalOnly', 'mfaInitSkipLifetime'] },
  ])('does not rewrite a custom policy when protobuf JSON omits $omitted', async ({ omitted }) => {
    const existing = custom({});
    const policy: Record<string, unknown> = { ...existing.policy };
    for (const field of omitted) delete policy[field];
    const { transport, calls } = recording({
      [ENDPOINTS.orgLoginPolicy]: (call: Call) =>
        call.method === 'GET'
          ? { ...existing, policy }
          : new ZitadelError(
              call.path,
              400,
              '{"code":9,"message":"Errors.Org.LoginPolicy.NotChanged (Org-5M9vdd)"}',
            ),
    });
    expect(await client(transport).ensureOrgLoginPolicy('cust-org', PORTAL_LOGIN_POLICY)).toBe(
      false,
    );
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('updates a custom policy whose omitted false boolean differs from a true patch', async () => {
    // Protobuf JSON omits false: forceMfa is absent here, so it is false and must be updated.
    const { forceMfa: _omit, ...rest } = inherited.policy;
    const { transport, calls } = recording({
      [ENDPOINTS.orgLoginPolicy]: { isDefault: false, policy: { ...rest, isDefault: false } },
    });
    expect(await client(transport).ensureOrgLoginPolicy('cust-org', PORTAL_LOGIN_POLICY)).toBe(
      true,
    );
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
  });

  it('falls back to an update when the custom policy appeared during the create', async () => {
    const { transport, calls } = recording({
      [ENDPOINTS.orgLoginPolicy]: (call: Call) =>
        call.method === 'POST'
          ? new ZitadelError(ENDPOINTS.orgLoginPolicy, 409, 'already_exists')
          : inherited,
    });
    expect(await client(transport).ensureOrgLoginPolicy('cust-org', PORTAL_LOGIN_POLICY)).toBe(
      true,
    );
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'PUT']);
  });

  it('refuses to copy identity-provider links into a custom policy', async () => {
    const withIdp = { ...inherited, policy: { ...inherited.policy, idps: [{ idpId: 'i1' }] } };
    const { transport, calls } = recording({ [ENDPOINTS.orgLoginPolicy]: withIdp });
    await expect(
      client(transport).ensureOrgLoginPolicy('cust-org', PORTAL_LOGIN_POLICY),
    ).rejects.toThrow(/identity provider/i);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});

const zitadelError = (path: string, status: number, detail: string): ZitadelError =>
  new ZitadelError(path, status, detail);

describe('ZitadelClient P1 additions: TOTP', () => {
  it('registerTotp POSTs to the user v2 totp path and returns uri and secret', async () => {
    const path = ENDPOINTS.registerTotp('u1');
    const { transport, calls } = recording({
      [path]: { uri: 'otpauth://totp/x?secret=ABC', secret: 'ABC' },
    });
    const reg = await client(transport).registerTotp('u1');
    expect(reg).toEqual({ uri: 'otpauth://totp/x?secret=ABC', secret: 'ABC' });
    expect(calls).toEqual([
      { method: 'POST', path: '/v2/users/u1/totp', body: {}, headers: undefined },
    ]);
  });

  it('registerTotp rejects an answer without a secret', async () => {
    const { transport } = recording({ [ENDPOINTS.registerTotp('u1')]: { uri: 'x' } });
    await expect(client(transport).registerTotp('u1')).rejects.toThrow(/RegisterTOTP/);
  });

  it('verifyTotpRegistration POSTs the code', async () => {
    const { transport, calls } = recording({});
    await client(transport).verifyTotpRegistration('u1', '287082');
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v2/users/u1/totp/verify',
        body: { code: '287082' },
        headers: undefined,
      },
    ]);
  });

  it('listAuthMethods GETs the method types and defaults to none', async () => {
    const path = ENDPOINTS.listAuthMethods('u1');
    const { transport, calls } = recording({
      [path]: {
        authMethodTypes: ['AUTHENTICATION_METHOD_TYPE_PASSWORD', 'AUTHENTICATION_METHOD_TYPE_TOTP'],
      },
    });
    const methods = await client(transport).listAuthMethods('u1');
    expect(methods).toContain('AUTHENTICATION_METHOD_TYPE_TOTP');
    expect(calls).toEqual([
      {
        method: 'GET',
        path: '/v2/users/u1/authentication_methods',
        body: undefined,
        headers: undefined,
      },
    ]);
    // Protobuf JSON omits empty arrays.
    expect(await client(recording({}).transport).listAuthMethods('u1')).toEqual([]);
  });

  it('encodes user ids in paths', async () => {
    const { transport, calls } = recording({});
    await client(transport).verifyTotpRegistration('a/b', '1');
    expect(calls[0]?.path).toBe('/v2/users/a%2Fb/totp/verify');
  });
});

describe('ZitadelClient P1 additions: login policy and second factors', () => {
  const policy = {
    allowUsernamePassword: true,
    passwordlessType: 'PASSWORDLESS_TYPE_ALLOWED',
    hidePasswordReset: true,
    defaultRedirectUri: 'https://app.localhost/',
    isDefault: true,
    details: { sequence: '4' },
  };

  it('getLoginPolicy GETs the policy object', async () => {
    const { transport, calls } = recording({ [ENDPOINTS.loginPolicy]: { policy } });
    expect(await client(transport).getLoginPolicy()).toEqual(policy);
    expect(calls).toEqual([
      { method: 'GET', path: '/admin/v1/policies/login', body: undefined, headers: undefined },
    ]);
  });

  it('updateLoginPolicy PUTs the existing fields plus the MFA patch, without read-only fields', async () => {
    const { transport, calls } = recording({ [ENDPOINTS.loginPolicy]: { policy } });
    const changed = await client(transport).updateLoginPolicy(FORCE_MFA_POLICY);
    expect(changed).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    const put = calls[1];
    expect(put?.path).toBe('/admin/v1/policies/login');
    expect(put?.body).toEqual({
      allowUsernamePassword: true,
      passwordlessType: 'PASSWORDLESS_TYPE_ALLOWED',
      hidePasswordReset: true,
      defaultRedirectUri: 'https://app.localhost/',
      forceMfa: true,
      forceMfaLocalOnly: false,
      mfaInitSkipLifetime: '0s',
    });
  });

  it('updateLoginPolicy does not write when the policy already matches (missing false/0s count as equal)', async () => {
    const { transport, calls } = recording({
      [ENDPOINTS.loginPolicy]: { policy: { ...policy, forceMfa: true } },
    });
    expect(await client(transport).updateLoginPolicy(FORCE_MFA_POLICY)).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('updateLoginPolicy treats a "not changed" answer as success but rethrows other errors', async () => {
    const get = { policy };
    const notChanged = recording({
      [ENDPOINTS.loginPolicy]: (call: Call) =>
        call.method === 'GET'
          ? get
          : zitadelError(call.path, 400, 'COMMAND-3Nf2t Policy not changed'),
    });
    expect(await client(notChanged.transport).updateLoginPolicy(FORCE_MFA_POLICY)).toBe(false);

    const denied = recording({
      [ENDPOINTS.loginPolicy]: (call: Call) =>
        call.method === 'GET' ? get : zitadelError(call.path, 403, 'permission_denied'),
    });
    await expect(client(denied.transport).updateLoginPolicy(FORCE_MFA_POLICY)).rejects.toThrow(
      /403/,
    );
  });

  it('addSecondFactor POSTs the type and reports true', async () => {
    const { transport, calls } = recording({});
    expect(await client(transport).addSecondFactor('SECOND_FACTOR_TYPE_OTP')).toBe(true);
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/admin/v1/policies/login/second_factors',
        body: { type: 'SECOND_FACTOR_TYPE_OTP' },
        headers: undefined,
      },
    ]);
  });

  it('addSecondFactor counts "already exists" (409 or message) as success and rethrows others', async () => {
    const path = ENDPOINTS.loginSecondFactors;
    for (const err of [
      zitadelError(path, 409, 'already_exists'),
      zitadelError(path, 400, 'COMMAND-Eg2ds MFA type already exists'),
    ]) {
      const { transport } = recording({ [path]: err });
      expect(await client(transport).addSecondFactor('SECOND_FACTOR_TYPE_OTP')).toBe(false);
    }
    const { transport } = recording({ [path]: zitadelError(path, 500, 'boom') });
    await expect(client(transport).addSecondFactor('SECOND_FACTOR_TYPE_OTP')).rejects.toThrow(
      /500/,
    );
  });
});

describe('ZitadelClient P1 additions: OIDC settings', () => {
  const settings = {
    accessTokenLifetime: '43200s',
    idTokenLifetime: '43200s',
    refreshTokenIdleExpiration: '1296000s',
    refreshTokenExpiration: '7776000s',
    details: { sequence: '2' },
  };

  it('getOidcSettings GETs the settings object', async () => {
    const { transport, calls } = recording({ [ENDPOINTS.oidcSettings]: { settings } });
    expect(await client(transport).getOidcSettings()).toEqual(settings);
    expect(calls).toEqual([
      { method: 'GET', path: '/admin/v1/settings/oidc', body: undefined, headers: undefined },
    ]);
  });

  it('updateOidcSettings PUTs the new access-token lifetime and keeps the other lifetimes', async () => {
    const { transport, calls } = recording({ [ENDPOINTS.oidcSettings]: { settings } });
    expect(await client(transport).updateOidcSettings({ accessTokenLifetime: '900s' })).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(calls[1]?.path).toBe('/admin/v1/settings/oidc');
    expect(calls[1]?.body).toEqual({
      accessTokenLifetime: '900s',
      idTokenLifetime: '43200s',
      refreshTokenIdleExpiration: '1296000s',
      refreshTokenExpiration: '7776000s',
    });
  });

  it('updateOidcSettings skips the write when the lifetime is already 900s', async () => {
    const { transport, calls } = recording({
      [ENDPOINTS.oidcSettings]: { settings: { ...settings, accessTokenLifetime: '900s' } },
    });
    expect(await client(transport).updateOidcSettings({ accessTokenLifetime: '900s' })).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('ZitadelClient P1 additions: personal access tokens', () => {
  it('addPat POSTs the expiry and returns tokenId and token', async () => {
    const { transport, calls } = recording({
      [ENDPOINTS.pats('u1')]: { tokenId: 't1', token: 'PAT-VALUE' },
    });
    const pat = await client(transport).addPat('u1', '2030-01-01T00:00:00Z');
    expect(pat).toEqual({ tokenId: 't1', token: 'PAT-VALUE' });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/management/v1/users/u1/pats',
        body: { expirationDate: '2030-01-01T00:00:00Z' },
        headers: undefined,
      },
    ]);
  });

  it('addPat and listPats send the org header only when an org id is given', async () => {
    const { transport, calls } = recording({
      [ENDPOINTS.pats('u1')]: { tokenId: 't1', token: 'x' },
      [ENDPOINTS.searchPats('u1')]: {
        result: [{ id: 't1', expirationDate: '2030-01-01T00:00:00Z' }, { id: 't2' }],
      },
    });
    const c = client(transport);
    await c.addPat('u1', '2030-01-01T00:00:00Z', 'org1');
    const pats = await c.listPats('u1', 'org1');
    expect(calls[0]?.headers).toEqual({ 'x-zitadel-orgid': 'org1' });
    expect(calls[1]).toEqual({
      method: 'POST',
      path: '/management/v1/users/u1/pats/_search',
      body: {},
      headers: { 'x-zitadel-orgid': 'org1' },
    });
    expect(pats).toEqual([{ id: 't1', expirationDate: '2030-01-01T00:00:00Z' }, { id: 't2' }]);
    await c.listPats('u1');
    expect(calls[2]?.headers).toBeUndefined();
  });

  it('listPats returns an empty list when ZITADEL omits the result', async () => {
    expect(await client(recording({}).transport).listPats('u1')).toEqual([]);
  });
});

describe('ZitadelClient P1 additions: Actions v2', () => {
  const targetSpec = {
    name: 'bos-user-sync',
    endpoint: 'http://host.docker.internal:3001/v1/hooks/zitadel',
    timeout: '10s',
    restAsync: {},
  } as const;

  it('createTarget POSTs the spec and returns id and signingKey', async () => {
    const { transport, calls } = recording({
      [ENDPOINTS.targets]: { id: 'tg1', creationDate: '2026-11-08T00:00:00Z', signingKey: 'KEY' },
    });
    expect(await client(transport).createTarget(targetSpec)).toEqual({
      id: 'tg1',
      signingKey: 'KEY',
    });
    expect(calls).toEqual([
      { method: 'POST', path: '/v2/actions/targets', body: targetSpec, headers: undefined },
    ]);
  });

  it('createTarget rejects an answer without a signing key', async () => {
    const { transport } = recording({ [ENDPOINTS.targets]: { id: 'tg1' } });
    await expect(client(transport).createTarget(targetSpec)).rejects.toThrow(/CreateTarget/);
  });

  it('listTargets POSTs an empty search and returns id, name and endpoint', async () => {
    const { transport, calls } = recording({
      [ENDPOINTS.searchTargets]: {
        targets: [{ id: 'tg1', name: 'bos-user-sync', endpoint: 'http://x', timeout: '10s' }],
      },
    });
    expect(await client(transport).listTargets()).toEqual([
      { id: 'tg1', name: 'bos-user-sync', endpoint: 'http://x' },
    ]);
    expect(calls).toEqual([
      { method: 'POST', path: '/v2/actions/targets/search', body: {}, headers: undefined },
    ]);
    expect(await client(recording({}).transport).listTargets()).toEqual([]);
  });

  it('setExecution PUTs the condition and target ids', async () => {
    const { transport, calls } = recording({});
    await client(transport).setExecution({ event: { group: 'user' } }, ['tg1']);
    expect(calls).toEqual([
      {
        method: 'PUT',
        path: '/v2/actions/executions',
        body: { condition: { event: { group: 'user' } }, targets: ['tg1'] },
        headers: undefined,
      },
    ]);
  });

  it('setUserEventExecution stops at the first accepted shape', async () => {
    const { transport, calls } = recording({});
    expect(await client(transport).setUserEventExecution('tg1')).toEqual({
      event: { group: 'user' },
    });
    expect(calls).toHaveLength(1);
  });

  it('setUserEventExecution falls back in order: group -> event -> all', async () => {
    const reject = (call: Call): unknown => {
      const condition = (call.body as { condition: { event: Record<string, unknown> } }).condition;
      return 'group' in condition.event
        ? zitadelError(call.path, 400, 'invalid_argument unknown condition')
        : {};
    };
    const second = recording({ [ENDPOINTS.executions]: reject });
    expect(await client(second.transport).setUserEventExecution('tg1')).toEqual({
      event: { event: 'user.human.added' },
    });
    expect(second.calls.map((c) => (c.body as { condition: unknown }).condition)).toEqual([
      { event: { group: 'user' } },
      { event: { event: 'user.human.added' } },
    ]);
    expect(second.calls.every((c) => (c.body as { targets: string[] }).targets[0] === 'tg1')).toBe(
      true,
    );

    const third = recording({
      [ENDPOINTS.executions]: (call: Call) => {
        const event = (call.body as { condition: { event: Record<string, unknown> } }).condition
          .event;
        return 'all' in event ? {} : zitadelError(call.path, 400, 'invalid_argument');
      },
    });
    expect(await client(third.transport).setUserEventExecution('tg1')).toEqual({
      event: { all: true },
    });
    expect(third.calls).toHaveLength(3);
  });

  it('setUserEventExecution throws a summary when every shape is rejected', async () => {
    const { transport, calls } = recording({
      [ENDPOINTS.executions]: (call: Call) => zitadelError(call.path, 400, 'invalid_argument'),
    });
    await expect(client(transport).setUserEventExecution('tg1')).rejects.toThrow(
      /rejected every user-event condition shape/,
    );
    expect(calls).toHaveLength(3);
  });

  it('setUserEventExecution does not try other shapes after a 403', async () => {
    const { transport, calls } = recording({
      [ENDPOINTS.executions]: (call: Call) => zitadelError(call.path, 403, 'permission_denied'),
    });
    await expect(client(transport).setUserEventExecution('tg1')).rejects.toThrow(/403/);
    expect(calls).toHaveLength(1);
  });
});

describe('ZitadelClient P1 additions: deactivateUser', () => {
  it('POSTs to the deactivate path and reports true', async () => {
    const { transport, calls } = recording({});
    expect(await client(transport).deactivateUser('u1')).toBe(true);
    expect(calls).toEqual([
      { method: 'POST', path: '/v2/users/u1/deactivate', body: {}, headers: undefined },
    ]);
  });

  it('treats "already deactivated" as success and rethrows other errors', async () => {
    const path = ENDPOINTS.deactivateUser('u1');
    const already = recording({
      [path]: zitadelError(path, 400, 'FAILED_PRECONDITION User already deactivated'),
    });
    expect(await client(already.transport).deactivateUser('u1')).toBe(false);

    const missing = recording({ [path]: zitadelError(path, 404, 'not_found User not found') });
    await expect(client(missing.transport).deactivateUser('u1')).rejects.toThrow(/404/);
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

  it('sends GET without a body and PUT with a JSON body, both with the bearer token', async () => {
    const seen: { method: string | undefined; body: unknown; auth: string | undefined }[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      seen.push({
        method: init?.method,
        body: init?.body,
        auth: (init?.headers as Record<string, string> | undefined)?.['authorization'],
      });
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    };
    const transport = createFetchTransport('https://auth.localhost', 'PAT', fetchImpl);
    expect(await transport.get('/admin/v1/policies/login')).toEqual({ ok: true });
    await transport.put('/admin/v1/policies/login', { forceMfa: true }, { 'x-zitadel-orgid': 'o' });
    expect(seen).toEqual([
      { method: 'GET', body: undefined, auth: 'Bearer PAT' },
      { method: 'PUT', body: '{"forceMfa":true}', auth: 'Bearer PAT' },
    ]);
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
