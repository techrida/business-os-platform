// Unit tests of the ZITADEL admin client calls K8 (portal access) added: the path and body of each request,
// and how "already exists" answers turn into a lookup instead of an error. fetch is stubbed; no ZITADEL runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreConfig } from '../config/config';
import { runOutsideOperationDeadline, runWithOperationDeadline } from './operation-deadline';
import {
  PORTAL_LOGIN_POLICY,
  ZITADEL_ENDPOINTS,
  ZitadelAdminClient,
  ZitadelHttpError,
} from './zitadel-admin.client';

interface Call {
  path: string;
  body: Record<string, unknown>;
}

let calls: Call[];
/** The HTTP method and `x-zitadel-orgid` header of each request, in the same order as `calls`. */
let sent: Array<{ method: string; orgId: string | undefined }>;
let answers: Array<{ status: number; body: unknown }>;

function client(): ZitadelAdminClient {
  return new ZitadelAdminClient({
    ZITADEL_API_URL: 'http://zitadel.test/',
    ZITADEL_PROVISIONER_TOKEN: 'pat',
  } as CoreConfig);
}

beforeEach(() => {
  calls = [];
  sent = [];
  answers = [];
  vi.stubGlobal(
    'fetch',
    (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
      calls.push({
        path: url.replace('http://zitadel.test', ''),
        body: init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>),
      });
      sent.push({ method: init.method, orgId: init.headers['x-zitadel-orgid'] });
      const next = answers.shift() ?? { status: 200, body: {} };
      return Promise.resolve(
        new Response(JSON.stringify(next.body), {
          status: next.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('organizations', () => {
  it('finds an org by its exact name (the seed findOrgByName query)', async () => {
    answers.push({
      status: 200,
      body: {
        result: [
          { id: 'o-other', name: 'Acme [p-1] extra' },
          { id: 'o-1', name: 'Acme [p-1]' },
        ],
      },
    });
    await expect(client().findOrganizationByName('Acme [p-1]')).resolves.toBe('o-1');
    expect(calls).toEqual([
      {
        path: ZITADEL_ENDPOINTS.listOrganizations,
        body: {
          queries: [{ nameQuery: { name: 'Acme [p-1]', method: 'TEXT_QUERY_METHOD_EQUALS' } }],
        },
      },
    ]);
  });

  it('answers null when no org has the name', async () => {
    answers.push({ status: 200, body: { result: [] } });
    await expect(client().findOrganizationByName('nobody')).resolves.toBeNull();
  });

  it('creates an org and returns its id (the seed createOrg body)', async () => {
    answers.push({ status: 200, body: { organizationId: 'o-new' } });
    await expect(client().createOrganization('Acme [p-1]')).resolves.toBe('o-new');
    expect(calls).toEqual([
      { path: ZITADEL_ENDPOINTS.addOrganization, body: { name: 'Acme [p-1]' } },
    ]);
  });
});

describe('ensureProjectGrant', () => {
  it('grants the project to the org with the given role keys', async () => {
    answers.push(
      { status: 200, body: { projects: [{ projectId: 'proj-1', name: 'business-os' }] } },
      { status: 200, body: {} },
    );
    await client().ensureProjectGrant('o-1', ['customer_user']);
    expect(calls[1]).toEqual({
      path: ZITADEL_ENDPOINTS.createProjectGrant,
      body: { projectId: 'proj-1', grantedOrganizationId: 'o-1', roleKeys: ['customer_user'] },
    });
  });

  it('treats "already exists" as done, so a retry does not fail', async () => {
    answers.push(
      { status: 200, body: { projects: [{ projectId: 'proj-1', name: 'business-os' }] } },
      { status: 409, body: { code: 'already_exists', message: 'Project grant already exists' } },
    );
    await expect(client().ensureProjectGrant('o-1', ['customer_user'])).resolves.toBeUndefined();
  });

  it('still throws any other error', async () => {
    answers.push(
      { status: 200, body: { projects: [{ projectId: 'proj-1', name: 'business-os' }] } },
      { status: 403, body: { code: 'permission_denied', message: 'No' } },
    );
    await expect(client().ensureProjectGrant('o-1', ['customer_user'])).rejects.toBeInstanceOf(
      ZitadelHttpError,
    );
  });
});

describe('findHumanByUsername', () => {
  it('looks the user up by exact username inside one org (the seed findUser query)', async () => {
    answers.push({
      status: 200,
      body: {
        result: [
          {
            userId: 'u-1',
            state: 'USER_STATE_INITIAL',
            username: 'ana@acme.test',
            details: { resourceOwner: 'o-1' },
            human: { email: { email: 'ana@acme.test' }, profile: { displayName: 'Ana B' } },
          },
        ],
      },
    });
    const user = await client().findHumanByUsername('o-1', 'ana@acme.test');
    expect(user).toMatchObject({ id: 'u-1', orgId: 'o-1', status: 'invited' });
    expect(calls).toEqual([
      {
        path: ZITADEL_ENDPOINTS.listUsers,
        body: {
          queries: [
            { userNameQuery: { userName: 'ana@acme.test', method: 'TEXT_QUERY_METHOD_EQUALS' } },
            { organizationIdQuery: { organizationId: 'o-1' } },
          ],
        },
      },
    ]);
  });

  it('ignores a row from another org or with another username', async () => {
    answers.push({
      status: 200,
      body: {
        result: [
          { userId: 'u-2', username: 'ana@acme.test', details: { resourceOwner: 'o-2' } },
          { userId: 'u-3', username: 'bob@acme.test', details: { resourceOwner: 'o-1' } },
        ],
      },
    });
    await expect(client().findHumanByUsername('o-1', 'ana@acme.test')).resolves.toBeNull();
  });
});

describe('ensureOrgLoginPolicy', () => {
  // What GetLoginPolicy answers for an org that inherits the instance policy (protobuf JSON omits false).
  const inherited = {
    policy: {
      isDefault: true,
      allowUsernamePassword: true,
      allowRegister: true,
      passwordlessType: 'PASSWORDLESS_TYPE_ALLOWED',
      passwordCheckLifetime: '864000s',
      secondFactors: ['SECOND_FACTOR_TYPE_OTP'],
      multiFactors: ['MULTI_FACTOR_TYPE_U2F_WITH_VERIFICATION'],
    },
  };
  /** The org's own policy is a full replacement, so every setting read must be sent back. */
  const carried = {
    allowUsernamePassword: true,
    passwordlessType: 'PASSWORDLESS_TYPE_ALLOWED',
    passwordCheckLifetime: '864000s',
  };

  it('pins self-registration off and MFA on in a new custom policy when the org inherits the instance one', async () => {
    answers.push({ status: 200, body: inherited }, { status: 200, body: {} });
    await expect(client().ensureOrgLoginPolicy('o-1', PORTAL_LOGIN_POLICY)).resolves.toBe(
      'created',
    );
    expect(calls).toEqual([
      { path: ZITADEL_ENDPOINTS.orgLoginPolicy, body: {} },
      {
        path: ZITADEL_ENDPOINTS.orgLoginPolicy,
        body: {
          ...carried,
          allowRegister: false,
          forceMfa: true,
          forceMfaLocalOnly: false,
          mfaInitSkipLifetime: '0s',
          secondFactors: ['SECOND_FACTOR_TYPE_OTP'],
          multiFactors: ['MULTI_FACTOR_TYPE_U2F_WITH_VERIFICATION'],
        },
      },
    ]);
    // Every call names the customer org: without the header management v1 would change the staff org.
    expect(sent).toEqual([
      { method: 'GET', orgId: 'o-1' },
      { method: 'POST', orgId: 'o-1' },
    ]);
  });

  it('updates an existing custom policy that still allows self-registration or skips MFA', async () => {
    answers.push(
      {
        status: 200,
        body: { policy: { ...inherited.policy, isDefault: false, allowRegister: false } },
      },
      { status: 200, body: {} },
    );
    await expect(client().ensureOrgLoginPolicy('o-1', PORTAL_LOGIN_POLICY)).resolves.toBe(
      'updated',
    );
    expect(calls[1]).toEqual({
      path: ZITADEL_ENDPOINTS.orgLoginPolicy,
      body: {
        ...carried,
        allowRegister: false,
        forceMfa: true,
        forceMfaLocalOnly: false,
        mfaInitSkipLifetime: '0s',
      },
    });
    expect(sent).toEqual([
      { method: 'GET', orgId: 'o-1' },
      { method: 'PUT', orgId: 'o-1' },
    ]);
  });

  it('writes nothing when the custom policy already matches', async () => {
    answers.push({
      status: 200,
      body: {
        policy: {
          ...carried,
          isDefault: false,
          forceMfa: true,
          mfaInitSkipLifetime: '0s',
        },
      },
    });
    await expect(client().ensureOrgLoginPolicy('o-1', PORTAL_LOGIN_POLICY)).resolves.toBe(
      'unchanged',
    );
    expect(sent).toEqual([{ method: 'GET', orgId: 'o-1' }]);
  });

  it('still pins an inherited policy that happens to match, so a later instance change cannot open the org', async () => {
    answers.push(
      {
        status: 200,
        body: { policy: { isDefault: true, forceMfa: true, mfaInitSkipLifetime: '0s' } },
      },
      { status: 200, body: {} },
    );
    await expect(client().ensureOrgLoginPolicy('o-1', PORTAL_LOGIN_POLICY)).resolves.toBe(
      'created',
    );
    expect(sent.map((s) => s.method)).toEqual(['GET', 'POST']);
  });

  it('falls back to an update when a concurrent grant created the custom policy first', async () => {
    answers.push(
      { status: 200, body: inherited },
      { status: 409, body: { code: 'already_exists', message: 'Policy already exists' } },
      { status: 200, body: {} },
    );
    await expect(client().ensureOrgLoginPolicy('o-1', PORTAL_LOGIN_POLICY)).resolves.toBe(
      'updated',
    );
    expect(sent).toEqual([
      { method: 'GET', orgId: 'o-1' },
      { method: 'POST', orgId: 'o-1' },
      { method: 'PUT', orgId: 'o-1' },
    ]);
    expect(calls[2]?.body).not.toHaveProperty('secondFactors');
  });

  it('refuses, writing nothing, when the inherited policy links identity providers it cannot copy', async () => {
    answers.push({
      status: 200,
      body: { policy: { ...inherited.policy, idps: [{ idpId: 'idp-1' }] } },
    });
    await expect(client().ensureOrgLoginPolicy('o-1', PORTAL_LOGIN_POLICY)).rejects.toThrow(
      /identity provider/,
    );
    expect(sent).toHaveLength(1);
  });
});

describe('user lock state (F1-Q4)', () => {
  it('reads a LOCKED user as inactive and locked, with the date ZITADEL last changed it', async () => {
    answers.push({
      status: 200,
      body: {
        user: {
          userId: 'u-1',
          state: 'USER_STATE_LOCKED',
          details: { resourceOwner: 'o-1', changeDate: '2026-11-20T10:00:00Z' },
        },
      },
    });

    await expect(client().getUser('u-1')).resolves.toMatchObject({
      status: 'inactive',
      locked: true,
      changedAt: new Date('2026-11-20T10:00:00Z'),
    });
  });

  it('reads a deactivated user as inactive but not locked', async () => {
    answers.push({
      status: 200,
      body: {
        user: { userId: 'u-1', state: 'USER_STATE_INACTIVE', details: { resourceOwner: 'o-1' } },
      },
    });

    await expect(client().getUser('u-1')).resolves.toMatchObject({
      status: 'inactive',
      locked: false,
      changedAt: null,
    });
  });
});

describe('lockUser and unlockUser (F1-Q5)', () => {
  it.each([
    ['lockUser', '/zitadel.user.v2.UserService/LockUser'],
    ['unlockUser', '/zitadel.user.v2.UserService/UnlockUser'],
  ] as const)('%s posts { userId } to %s', async (method, path) => {
    await client()[method]('u-1');

    expect(calls).toEqual([{ path, body: { userId: 'u-1' } }]);
    expect(sent[0]?.method).toBe('POST');
  });

  it('turns a refusal into a ZitadelHttpError with the status', async () => {
    answers.push({ status: 400, body: { code: 'failed_precondition', message: 'not active' } });

    await expect(client().lockUser('u-1')).rejects.toMatchObject({ status: 400 });
  });
});

describe('ensureOrgLockoutPolicy (F1-Q4)', () => {
  const WANT = { maxPasswordAttempts: 5, maxOtpAttempts: 5 };
  const PATH = '/management/v1/policies/lockout';

  it('gives an org that inherits the default (no limits, as v4.20.1 sends it) a custom policy', async () => {
    answers.push({
      status: 200,
      body: {
        policy: { details: { sequence: '22' }, isDefault: true, showLockoutFailure: true },
        isDefault: true,
      },
    });

    await expect(client().ensureOrgLockoutPolicy('o-1', WANT)).resolves.toBe('created');

    expect(calls.map((c) => c.path)).toEqual([PATH, PATH]);
    expect(sent).toEqual([
      { method: 'GET', orgId: 'o-1' },
      { method: 'POST', orgId: 'o-1' },
    ]);
    // Every other setting is carried over; the read-only fields are not sent back.
    expect(calls[1]?.body).toEqual({ showLockoutFailure: true, ...WANT });
  });

  it('updates a custom policy whose limits differ (uint64 arrives as a string)', async () => {
    answers.push({
      status: 200,
      body: { policy: { maxPasswordAttempts: '10', maxOtpAttempts: '5' }, isDefault: false },
    });

    await expect(client().ensureOrgLockoutPolicy('o-1', WANT)).resolves.toBe('updated');

    expect(sent.map((s) => s.method)).toEqual(['GET', 'PUT']);
    expect(calls[1]?.body).toEqual(WANT);
  });

  it('leaves a matching custom policy alone', async () => {
    answers.push({
      status: 200,
      body: { policy: { maxPasswordAttempts: '5', maxOtpAttempts: '5' }, isDefault: false },
    });

    await expect(client().ensureOrgLockoutPolicy('o-1', WANT)).resolves.toBe('unchanged');

    expect(sent.map((s) => s.method)).toEqual(['GET']);
  });

  it('updates instead when another process created the custom policy first (409)', async () => {
    answers.push(
      { status: 200, body: { policy: { isDefault: true }, isDefault: true } },
      { status: 409, body: { code: 'already_exists', message: 'exists' } },
    );

    await expect(client().ensureOrgLockoutPolicy('o-1', WANT)).resolves.toBe('updated');

    expect(sent.map((s) => s.method)).toEqual(['GET', 'POST', 'PUT']);
  });
});

describe('listGrants (FU8)', () => {
  const project = { status: 200, body: { projects: [{ projectId: 'p1', name: 'business-os' }] } };

  it('refuses an omitted authorizations list when the count is positive: a broken answer is not "no roles"', async () => {
    answers.push(project, { status: 200, body: { details: { totalResult: '2' } } });

    await expect(client().listGrants('u-1', 'o-1')).rejects.toThrow(/positive count/);
  });

  it('reads an omitted list with no count (or a zero count) as no roles', async () => {
    const c = client();
    answers.push(project, { status: 200, body: {} });
    expect(await c.listGrants('u-1', 'o-1')).toEqual([]);

    answers.push({ status: 200, body: { details: { totalResult: '0' } } });
    expect(await c.listGrants('u-1', 'o-1')).toEqual([]);
  });
});

describe('operation deadline (round 4)', () => {
  const past = <T>(fn: () => Promise<T>) =>
    runWithOperationDeadline(5, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return fn();
    });

  it('starts no mutating request once the deadline has passed, also inside setGrants after its read', async () => {
    const c = client();
    answers.push(
      { status: 200, body: { projects: [{ projectId: 'p1', name: 'business-os' }] } },
      {
        status: 200,
        body: {
          authorizations: [{ id: 'a1', organization: { id: 'o-1' }, roles: [{ key: 'sales' }] }],
        },
      },
    );

    // The read runs, then the deadline check stops the write.
    await expect(
      runWithOperationDeadline(40, async () => {
        const read = c.listGrants('u-1', 'o-1');
        await read;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return c.setGrants('u-1', 'o-1', ['finance']);
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      calls.every(
        (x) =>
          !/Authorization(Update|Create|Delete)|UpdateAuthorization|DeleteAuthorization|CreateAuthorization/.test(
            x.path,
          ),
      ),
    ).toBe(true);

    calls.length = 0;
    const mutations: Array<() => Promise<unknown>> = [
      () => c.lockUser('u-1'),
      () => c.unlockUser('u-1'),
      () => c.deactivateUser('u-1'),
      () => c.reactivateUser('u-1'),
      () => c.sendInviteCode('u-1'),
      () => c.createHuman('o-1', { email: 'a@b.test', givenName: 'A', familyName: 'B' }),
    ];
    for (const call of mutations) {
      await expect(past(call)).rejects.toMatchObject({ status: 503 });
    }
    expect(calls).toEqual([]);
  });

  it('keeps the lease fence for the best-effort close: past it no close starts, before it the close goes out', async () => {
    const c = client();
    // Past the fence (the lease may already belong to another holder): the close outside the deadline still stops.
    await expect(
      runWithOperationDeadline(
        60_000,
        () => runOutsideOperationDeadline(() => c.lockUser('u-1')),
        Date.now() - 1,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toEqual([]);

    // Past the deadline but inside the fence: the close is sent.
    answers.push({ status: 200, body: {} });
    await runWithOperationDeadline(
      5,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        await runOutsideOperationDeadline(() => c.lockUser('u-1'));
      },
      Date.now() + 60_000,
    );
    expect(calls).toHaveLength(1);
  });

  it('checks the deadline after resolving the project id, right before createAuthorization (round 5)', async () => {
    const c = client();
    const target = c as unknown as { bosProjectId(): Promise<string> };
    let resolved = 0;
    vi.spyOn(target, 'bosProjectId').mockImplementation(async () => {
      // The read in setGrants resolves it at once; the second resolution (for the create) is slow.
      if (++resolved === 2) await new Promise((resolve) => setTimeout(resolve, 60));
      return 'p1';
    });
    answers.push({ status: 200, body: {} }); // no authorizations yet

    await expect(
      runWithOperationDeadline(40, () => c.setGrants('u-1', 'o-1', ['finance'])),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls.some((x) => /CreateAuthorization/.test(x.path))).toBe(false);
  });
});
