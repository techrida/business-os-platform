import { avatarColour } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch } from '@/lib/api';
import { listApprovalPeople } from '@/lib/api-admin';
import type { Session } from '@/lib/session';
import { IDLE } from '../action-state';
import {
  addMemberAction,
  createDelegationAction,
  publishVersionAction,
  saveDraftAction,
} from './actions';
import WorkflowsPage from './page';
import { WorkflowEditor } from './workflow-editor';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('../guard', () => ({ requireSection: () => Promise.resolve(session) }));
/** The live grants the page gates on (`/v1/me`); by default a workflow editor who also manages groups and delegations. */
let held: Set<string>;
const EDITOR = [
  'approvals.definitions.read',
  'approvals.definitions.write',
  'approvals.groups.write',
  'approvals.delegations.write',
];
vi.mock('@/lib/live-permissions', () => ({
  getPermissionCheck: () => Promise.resolve((permission: string) => held.has(permission)),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
let session: Session;
const first = '11111111-1111-4111-8111-000000000200';
const second = '22222222-2222-4222-8222-222222222222';
const group = '33333333-3333-4333-8333-333333333333';
const person = (id: string) => ({
  id,
  displayName: id === second ? 'Second page person' : 'Mina',
  email: null,
});
const version = (spec: unknown) => ({
  id: group,
  version: 2,
  status: 'draft',
  spec,
  publishedAt: null,
});
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

function jsonBody(body: unknown): unknown {
  if (typeof body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(body) as unknown;
}

beforeEach(() => {
  vi.resetAllMocks();
  held = new Set(EDITOR);
  session = { accessToken: 'caller-token', orgKind: 'staff', roles: ['management'] } as Session;
  const respond = (caller: Session, path: string, init?: RequestInit): Response => {
    expect(caller).toBe(session);
    const url = new URL(path, 'http://api.test');
    if (url.pathname === '/v1/admin/users') return Response.json({}, { status: 403 });
    if (url.pathname.endsWith('/people')) {
      return Response.json(
        url.searchParams.has('after')
          ? { items: [person(second)], nextAfter: null }
          : {
              items: Array.from({ length: 200 }, (_, i) =>
                person(`11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`),
              ),
              nextAfter: first,
            },
      );
    }
    if (init?.method === 'POST') {
      if (path.endsWith('/versions')) return Response.json(version({}));
      if (path.endsWith('/members')) return new Response(null, { status: 204 });
      return Response.json({ id: group });
    }
    if (path === '/v1/admin/approval-groups')
      return Response.json([{ id: group, key: 'review', name: 'Reviewers', memberUserIds: [] }]);
    return Response.json([]);
  };
  vi.mocked(apiFetch).mockImplementation((...args) => Promise.resolve(respond(...args)));
});

it('enables named group and delegation assignments without general directory access', async () => {
  const html = renderToStaticMarkup(await WorkflowsPage());
  expect(html).toContain(`<option value="${second}">Second page person</option>`);
  expect(html).not.toMatch(/disabled=""[^>]*>Add</);
  expect(html).not.toMatch(/disabled=""[^>]*>Create delegation</);
  expect((await addMemberAction(IDLE, form({ groupId: group, userId: second }))).status).toBe('ok');
  expect(
    (
      await createDelegationAction(
        IDLE,
        form({
          fromUserId: first,
          toUserId: second,
          startsAt: '2026-11-10T09:00',
          endsAt: '2026-11-11T09:00',
        }),
      )
    ).status,
  ).toBe('ok');
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, , init]) => init?.method === 'POST');
  expect(writes.map(([, path]) => path)).toEqual([
    `/v1/admin/approval-groups/${group}/members`,
    '/v1/admin/delegations',
  ]);
  expect(jsonBody(writes[0]?.[2]?.body)).toEqual({ userId: second });
  expect(jsonBody(writes[1]?.[2]?.body)).toMatchObject({
    fromUserId: first,
    toUserId: second,
  });
});

it("seeds a group member's avatar colour from their user id", async () => {
  const respond = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((caller, path, init) =>
    path === '/v1/admin/approval-groups' && init?.method !== 'POST'
      ? Promise.resolve(
          Response.json([{ id: group, key: 'review', name: 'Reviewers', memberUserIds: [second] }]),
        )
      : respond(caller, path, init),
  );
  // The id must not land on the unseeded colour, or this check would pass without a seed.
  expect(avatarColour(second)).not.toBe(avatarColour(null));
  const html = renderToStaticMarkup(await WorkflowsPage());
  expect(html).toContain(`--avatar-fill:${avatarColour(second)}`);
});

it('offers and saves a new approver from the second API page through the normal editor', async () => {
  const people = await listApprovalPeople(session, 'workflows');
  expect(vi.mocked(apiFetch).mock.calls.map(([, path]) => path)).toEqual([
    '/v1/admin/workflows/people?limit=200',
    `/v1/admin/workflows/people?limit=200&after=${first}`,
  ]);
  const spec = {
    documentType: 'test_memo',
    steps: [{ id: 'review', kind: 'user', user: second, reason: 'Review' }],
    rules: [],
  };
  const html = renderToStaticMarkup(
    <WorkflowEditor
      action={saveDraftAction}
      mode="version"
      workflowKey="memo"
      documentType="test_memo"
      initialSpec={spec}
      submitLabel="Save"
      groupKeys={[]}
      users={people.map((u) => ({
        id: u.id,
        label: u.displayName!,
        name: u.displayName!,
        email: null,
      }))}
    />,
  );
  expect(html).toContain(`<option value="${second}" selected="">Second page person</option>`);
  const encoded = html.match(/name="spec" value="([^"]*)"/)?.[1];
  expect(encoded).toBeDefined();
  const serialized = encoded!.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  expect((await saveDraftAction(IDLE, form({ key: 'memo', spec: serialized }))).status).toBe('ok');
  const write = vi.mocked(apiFetch).mock.calls.find(([, path]) => path.endsWith('/versions'));
  expect(jsonBody(write?.[2]?.body)).toMatchObject({ spec: { steps: [{ user: second }] } });
});

it('includes second-page users in workflow page selectors without directory read', async () => {
  const respond = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((caller, path, init) => {
    if (path === '/v1/admin/workflows') {
      return Promise.resolve(
        Response.json([
          {
            id: group,
            key: 'memo',
            name: 'Memo review',
            documentType: 'test_memo',
            currentVersionId: null,
            versions: [
              version({
                documentType: 'test_memo',
                steps: [{ id: 'review', kind: 'user', user: first, reason: 'Review' }],
                rules: [],
              }),
            ],
          },
        ]),
      );
    }
    return respond(caller, path, init);
  });
  const html = renderToStaticMarkup(await WorkflowsPage());
  const workflows = html.slice(0, html.indexOf('id="groups"'));
  expect(workflows).toContain(`<option value="${second}">Second page person</option>`);
});

it('includes second-page users in workflow page selectors when the general directory is allowed', async () => {
  session = { ...session, roles: ['founder'] };
  const respond = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((caller, path, init) => {
    if (path.startsWith('/v1/admin/users?')) {
      const after = new URL(path, 'http://api.test').searchParams.get('after');
      const items = after
        ? [person(second)]
        : Array.from({ length: 200 }, (_, i) =>
            person(`11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`),
          );
      return Promise.resolve(
        Response.json({
          items: items.map((u) => ({
            ...u,
            status: 'active',
            idpOrgId: group,
            roles: [],
            department: null,
            createdAt: '2026-11-19T00:00:00.000Z',
            lastActiveAt: null,
          })),
          nextAfter: after ? null : first,
          nextPage: null,
        }),
      );
    }
    if (path === '/v1/admin/workflows') {
      return Promise.resolve(
        Response.json([
          {
            id: group,
            key: 'memo',
            name: 'Memo review',
            documentType: 'test_memo',
            currentVersionId: null,
            versions: [
              version({
                documentType: 'test_memo',
                steps: [{ id: 'review', kind: 'user', user: first, reason: 'Review' }],
                rules: [],
              }),
            ],
          },
        ]),
      );
    }
    return respond(caller, path, init);
  });
  const html = renderToStaticMarkup(await WorkflowsPage());
  const workflows = html.slice(0, html.indexOf('id="groups"'));
  expect(workflows).toContain(`<option value="${second}">Second page person</option>`);
});

// The timing block of the new-workflow form: from its first label to the submit button.
const newWorkflowTimes = (html: string): string[] => {
  const end = html.indexOf('Create as draft');
  const form = html.slice(html.lastIndexOf('Remind after (hours)', end), end);
  return [
    form.match(/value="(\d+)"/)?.[1] ?? '',
    form.match(/Escalate after \(hours\)[\s\S]*?value="(\d+)"/)?.[1] ?? '',
    form.match(/<option value="([a-z_]+)" selected="">/)?.[1] ?? '',
  ];
};

it('starts the new-workflow form from the saved default reminder times', async () => {
  const respond = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((caller, path, init) =>
    path === '/v1/admin/approval-sla-defaults'
      ? Promise.resolve(
          Response.json({
            key: 'approvals.sla_defaults',
            value: {
              remindAfterHours: 8,
              escalateAfterHours: 36,
              escalateTo: { role: 'management' },
            },
            version: 3,
          }),
        )
      : respond(caller, path, init),
  );
  const [remind, escalate, role] = newWorkflowTimes(renderToStaticMarkup(await WorkflowsPage()));
  expect(remind).toBe('8');
  expect(escalate).toBe('36');
  expect(role).toBe('management');
});

it('starts a non-admin workflow editor from the saved times, which the admin settings route refuses them', async () => {
  // The API as a Management user who may edit workflows sees it: the general settings route is
  // admin-only (403), and the workflow-editor read answers with the saved value.
  const respond = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((caller, path, init) => {
    if (path.startsWith('/v1/admin/settings/'))
      return Promise.resolve(Response.json({ code: 'forbidden' }, { status: 403 }));
    if (path === '/v1/admin/approval-sla-defaults')
      return Promise.resolve(
        Response.json({
          key: 'approvals.sla_defaults',
          value: {
            remindAfterHours: 8,
            escalateAfterHours: 36,
            escalateTo: { role: 'management' },
          },
          version: 3,
        }),
      );
    return respond(caller, path, init);
  });
  const [remind, escalate, role] = newWorkflowTimes(renderToStaticMarkup(await WorkflowsPage()));
  expect(remind).toBe('8');
  expect(escalate).toBe('36');
  expect(role).toBe('management');
});

it('starts the new-workflow form from the built-in times when the saved ones cannot be read', async () => {
  const respond = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((caller, path, init) =>
    path === '/v1/admin/approval-sla-defaults'
      ? Promise.resolve(Response.json({}, { status: 503 }))
      : respond(caller, path, init),
  );
  const [remind, escalate, role] = newWorkflowTimes(renderToStaticMarkup(await WorkflowsPage()));
  expect(remind).toBe('24');
  expect(escalate).toBe('72');
  expect(role).toBe('founder');
});

it('rejects a stuck cursor instead of silently returning an incomplete picker', async () => {
  vi.mocked(apiFetch).mockImplementation(() =>
    Promise.resolve(Response.json({ items: [person(first)], nextAfter: first })),
  );
  await expect(listApprovalPeople(session, 'workflows')).rejects.toThrow(
    'People pagination did not advance',
  );
});

it('rejects a failed second page rather than exposing partial assignment choices', async () => {
  vi.mocked(apiFetch).mockImplementation((_caller, path) =>
    Promise.resolve(
      path.includes('after=')
        ? Response.json({}, { status: 503 })
        : Response.json({ items: [person(first)], nextAfter: first }),
    ),
  );
  await expect(listApprovalPeople(session, 'workflows')).rejects.toThrow();
});

describe('publishing needs a second person (F1-Q11)', () => {
  const MANAGEMENT = ['approvals.definitions.read', 'approvals.definitions.publish'];
  const draft = (over: Record<string, unknown>) => ({
    id: group,
    key: 'memo',
    name: 'Memo review',
    documentType: 'test_memo',
    currentVersionId: null,
    versions: [
      {
        ...version({ documentType: 'test_memo', steps: [], rules: [] }),
        createdBy: first,
        createdByName: 'Sita Editor',
        publishedBy: null,
        savedByCaller: false,
        ...over,
      },
    ],
  });
  function answer(workflow: unknown) {
    const respond = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation((caller, path, init) =>
      path === '/v1/admin/workflows'
        ? Promise.resolve(Response.json([workflow]))
        : respond(caller, path, init),
    );
  }
  const workflowsPart = (html: string) => html.slice(html.indexOf('id="workflows"'));
  const SOLE_HINT = 'You are the only person who can publish this; a reason is required.';

  it('lets a Management member publish a draft someone else saved, and shows only what they can use', async () => {
    held = new Set(MANAGEMENT);
    answer(draft({}));
    const html = renderToStaticMarkup(await WorkflowsPage());
    expect(workflowsPart(html)).toMatch(/>Publish</);
    expect(html).toContain('a Management member other than that person publishes it');
    // The editor's name comes from the workflow list: Management cannot read the user directory.
    expect(html).toContain('Saved by Sita Editor');
    // No editors, groups, delegations or reminder times for a role that cannot change them.
    expect(html).not.toContain('Edit as a new draft');
    expect(html).not.toContain('New workflow');
    expect(html).not.toContain('id="groups"');
    expect(html).not.toContain('id="delegations"');
    expect(html).not.toContain('id="timing"');
    const paths = vi.mocked(apiFetch).mock.calls.map(([, path]) => path);
    expect(paths.some((p) => p.startsWith('/v1/admin/approval-groups'))).toBe(false);
    expect(paths.some((p) => p.startsWith('/v1/admin/delegations'))).toBe(false);
  });

  it('explains instead of offering Publish to the person who saved the draft', async () => {
    held = new Set([...EDITOR, 'approvals.definitions.publish']);
    answer(draft({ savedByCaller: true }));
    const html = workflowsPart(renderToStaticMarkup(await WorkflowsPage()));
    expect(html).not.toMatch(/>Publish</);
    expect(html).toContain('You saved this draft, so another Management member publishes it.');
  });

  it('explains instead of offering Publish to an editor without the publish permission', async () => {
    answer(draft({}));
    const html = workflowsPart(renderToStaticMarkup(await WorkflowsPage()));
    expect(html).not.toMatch(/>Publish</);
    expect(html).toContain('Waiting for a Management member other than its editor to publish it.');
  });

  it('keeps the second-person explanation and no reason field when the caller is not the only publisher', async () => {
    held = new Set([...EDITOR, 'approvals.definitions.publish']);
    answer(draft({ savedByCaller: true, publishSoleEligible: false }));
    const html = workflowsPart(renderToStaticMarkup(await WorkflowsPage()));
    expect(html).toContain('You saved this draft, so another Management member publishes it.');
    expect(html).not.toContain(SOLE_HINT);
    expect(html).not.toContain('name="reason"');
  });

  it('asks the only possible publisher for a reason and offers Publish on their own draft', async () => {
    held = new Set([...EDITOR, 'approvals.definitions.publish']);
    answer(draft({ savedByCaller: true, publishSoleEligible: true }));
    const html = workflowsPart(renderToStaticMarkup(await WorkflowsPage()));
    expect(html).toContain(SOLE_HINT);
    expect(html).toMatch(/<textarea[^>]*name="reason"[^>]*required=""/);
    expect(html).toMatch(/<textarea[^>]*maxLength="500"/);
    expect(html).toMatch(/>Publish</);
    expect(html).not.toContain('so another Management member publishes it');
  });

  it('asks for a draft with no recorded editor to be saved again', async () => {
    held = new Set(MANAGEMENT);
    answer(draft({ createdBy: null }));
    const html = workflowsPart(renderToStaticMarkup(await WorkflowsPage()));
    expect(html).not.toMatch(/>Publish</);
    expect(html).toContain('Save it again as a new draft to publish it.');
  });
});

describe('publishVersionAction and the small-team rule (F1-Q11 a)', () => {
  const published = {
    ...version({}),
    status: 'published',
    publishedAt: '2026-11-21T00:00:00.000Z',
  };
  const publishCalls = () =>
    vi.mocked(apiFetch).mock.calls.filter(([, path]) => path.endsWith('/publish'));

  it('sends the typed reason, trimmed, with the publish', async () => {
    vi.mocked(apiFetch).mockImplementation(() => Promise.resolve(Response.json(published)));
    const result = await publishVersionAction(
      IDLE,
      form({ key: 'memo', version: '2', reason: '  Only founder on the team  ' }),
    );
    expect(result.status).toBe('ok');
    const [call] = publishCalls();
    expect(call?.[1]).toBe('/v1/admin/workflows/memo/versions/2/publish');
    expect(jsonBody(call?.[2]?.body)).toEqual({ reason: 'Only founder on the team' });
  });

  it('publishes without a body when no reason is typed (the usual second-person publish)', async () => {
    vi.mocked(apiFetch).mockImplementation(() => Promise.resolve(Response.json(published)));
    await publishVersionAction(IDLE, form({ key: 'memo', version: '2', reason: '   ' }));
    expect(publishCalls()[0]?.[2]?.body).toBeUndefined();
  });

  it('refuses a reason over 500 characters before calling the API', async () => {
    const result = await publishVersionAction(
      IDLE,
      form({ key: 'memo', version: '2', reason: 'x'.repeat(501) }),
    );
    expect(result).toMatchObject({ status: 'error' });
    expect(publishCalls()).toHaveLength(0);
  });

  it('says plainly that a reason is needed when the API refuses with sole_eligible_reason_required', async () => {
    vi.mocked(apiFetch).mockImplementation(() =>
      Promise.resolve(
        Response.json(
          {
            error: {
              code: 'bad_request',
              correlationId: 'corr-1',
              reason: 'sole_eligible_reason_required',
              message: 'API wording that the screen replaces.',
            },
          },
          { status: 400 },
        ),
      ),
    );
    const result = await publishVersionAction(IDLE, form({ key: 'memo', version: '2' }));
    expect(result).toMatchObject({
      status: 'error',
      message:
        'You are the only person who can publish this, so give a reason for publishing your own draft.',
    });
  });
});
