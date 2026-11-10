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
vi.mock('../guard', () => ({ requireSession: () => Promise.resolve(session) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const session = { accessToken: 'caller-token', orgKind: 'staff' } as Session;
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
