import { avatarColour } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

import { apiFetch } from '@/lib/api';
import { listApprovalPeople } from '@/lib/api-admin';
import type { Session } from '@/lib/session';
import { IDLE } from '../action-state';
import { addMemberAction, createDelegationAction, saveDraftAction } from './actions';
import WorkflowsPage from './page';
import { WorkflowEditor } from './workflow-editor';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('../guard', () => ({ requireSection: () => Promise.resolve(session) }));
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
    path === '/v1/admin/settings/approvals.sla_defaults'
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

it('starts the new-workflow form from the built-in times when the saved ones cannot be read', async () => {
  const respond = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((caller, path, init) =>
    path === '/v1/admin/settings/approvals.sla_defaults'
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
