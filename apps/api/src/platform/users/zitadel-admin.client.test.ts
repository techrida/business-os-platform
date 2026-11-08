// Unit tests of the ZITADEL admin client calls K8 (portal access) added: the path and body of each request,
// and how "already exists" answers turn into a lookup instead of an error. fetch is stubbed; no ZITADEL runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoreConfig } from '../config/config';
import { ZITADEL_ENDPOINTS, ZitadelAdminClient, ZitadelHttpError } from './zitadel-admin.client';

interface Call {
  path: string;
  body: Record<string, unknown>;
}

let calls: Call[];
let answers: Array<{ status: number; body: unknown }>;

function client(): ZitadelAdminClient {
  return new ZitadelAdminClient({
    ZITADEL_API_URL: 'http://zitadel.test/',
    ZITADEL_PROVISIONER_TOKEN: 'pat',
  } as CoreConfig);
}

beforeEach(() => {
  calls = [];
  answers = [];
  vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
    calls.push({
      path: url.replace('http://zitadel.test', ''),
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    const next = answers.shift() ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
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
