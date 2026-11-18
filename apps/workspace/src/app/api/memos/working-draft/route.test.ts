import { createRequire } from 'node:module';

import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { MemoDetail } from '@/lib/api-kernel';
import { __resetEnvForTests } from '@/lib/env';
import { MEMO_DRAFT_LIMITS, type MemoDraftSnapshot } from '@/lib/memo-working-draft-types';
import { __setRedisForTests, type Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock('@/lib/oidc', () => ({ refreshTokens: vi.fn() }));

// The real session module supplies Valkey (an ioredis-mock injected below); only the cookie lookup is replaced.
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session')>()),
  getSession: () => getSession(),
}));

// The real access rules run; only the two API reads they depend on are scripted.
const getMemo = vi.fn<(session: Session, id: string) => Promise<MemoDetail>>();
const getMemoDirectory = vi.fn<(session: Session) => Promise<{ currentUserId: string }>>();
vi.mock('@/lib/api-kernel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-kernel')>()),
  getMemo: (session: Session, id: string) => getMemo(session, id),
  getMemoDirectory: (session: Session) => getMemoDirectory(session),
}));

const RedisMock = createRequire(import.meta.url)('ioredis-mock') as new () => Redis;

const { GET, PUT, DELETE } = await import('./route');
const { memoDraftAccount } = await import('@/lib/memo-working-draft');

const ORIGIN = 'https://app.test';
const MEMO = '22222222-2222-4222-8222-222222222222';
const ALICE_DB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB_DB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const staff = (sub: string): Session => ({
  id: 'A'.repeat(43),
  sub,
  orgId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'staff',
  roles: ['sales'],
  accessToken: 'token',
  accessExp: 2_000_000_000,
  createdAt: 1,
  lastSeenAt: 1,
});
const ALICE = staff('alice');
const BOB = staff('bob');

const memoOf = (over: Partial<MemoDetail> = {}): MemoDetail =>
  ({
    id: MEMO,
    ownerUserId: ALICE_DB_ID,
    canUpdate: true,
    status: 'draft',
    ...over,
  }) as MemoDetail;

const FIELDS = { title: 'Budget', body: 'Partly typed body', amount: '10', currency: 'NPR' };

function url(memoId?: string): string {
  return `${ORIGIN}/api/memos/working-draft${memoId === undefined ? '' : `?memoId=${memoId}`}`;
}

function call(
  method: 'GET' | 'PUT' | 'DELETE',
  opts: {
    memoId?: string;
    body?: unknown;
    raw?: string;
    origin?: string | null;
    length?: number;
    account?: Session;
  } = {},
): Request {
  const text = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-bos-draft-account': memoDraftAccount(opts.account ?? ALICE),
  };
  if (opts.origin !== null && method !== 'GET') headers.origin = opts.origin ?? ORIGIN;
  if (text !== undefined)
    headers['content-length'] = String(opts.length ?? Buffer.byteLength(text));
  return new Request(url(opts.memoId), {
    method,
    headers,
    ...(text !== undefined ? { body: text } : {}),
  });
}

async function snapshot(res: Response): Promise<MemoDraftSnapshot> {
  return (await res.json()) as MemoDraftSnapshot;
}

let redis: Redis;

beforeEach(async () => {
  for (const [k, v] of Object.entries({
    API_INTERNAL_URL: 'http://api:3001',
    OIDC_ISSUER: 'https://auth.test',
    OIDC_CLIENT_ID: 'c',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
    OIDC_AUDIENCE: 'p',
    WORKSPACE_PUBLIC_URL: ORIGIN,
    VALKEY_URL: 'redis://v:6379',
    SESSION_ENC_KEY: Buffer.alloc(32, 5).toString('base64'),
  })) {
    vi.stubEnv(k, v);
  }
  __resetEnvForTests();
  redis = new RedisMock();
  await redis.flushall();
  __setRedisForTests(redis);

  getSession.mockReset();
  getSession.mockResolvedValue(ALICE);
  getMemo.mockReset();
  getMemo.mockResolvedValue(memoOf());
  getMemoDirectory.mockReset();
  getMemoDirectory.mockResolvedValue({ currentUserId: ALICE_DB_ID });
});

afterEach(() => {
  __setRedisForTests(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const keysInValkey = () => redis.keys('ws:memo-draft:*');

describe('transport rules', () => {
  it('refuses a write from the wrong or a missing origin before it looks at the session or the API', async () => {
    for (const origin of ['https://evil.test', 'http://app.test', null]) {
      for (const method of ['PUT', 'DELETE'] as const) {
        const res = await (method === 'PUT' ? PUT : DELETE)(
          call(method, { body: { revision: null, values: FIELDS }, origin }),
        );
        expect(res.status).toBe(403);
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
    }
    expect(getSession).not.toHaveBeenCalled();
    expect(getMemoDirectory).not.toHaveBeenCalled();
    expect(await keysInValkey()).toEqual([]);
  });

  it('answers 401 without a session and 403 for a non-staff session, touching nothing', async () => {
    getSession.mockResolvedValueOnce(null);
    expect((await GET(call('GET'))).status).toBe(401);
    getSession.mockResolvedValueOnce({ ...ALICE, orgKind: 'customer' });
    expect((await PUT(call('PUT', { body: { revision: null, values: FIELDS } }))).status).toBe(403);
    expect(getMemoDirectory).not.toHaveBeenCalled();
    expect(await keysInValkey()).toEqual([]);
  });

  it('refuses a memoId that is not exactly one UUID', async () => {
    for (const bad of ['../x', 'new', `${MEMO}&memoId=${MEMO}`, '%00']) {
      const res = await GET(new Request(`${ORIGIN}/api/memos/working-draft?memoId=${bad}`));
      expect(res.status).toBe(400);
    }
    expect(getMemo).not.toHaveBeenCalled();
  });

  it('sends no-store on every answer and bounds the payload', async () => {
    const ok = await PUT(call('PUT', { body: { revision: null, values: FIELDS } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');

    // Announced too large: refused before any API call. Not announced: 411.
    getMemoDirectory.mockClear();
    const announced = await PUT(
      call('PUT', { raw: '{}', length: MEMO_DRAFT_LIMITS.requestBytes + 1 }),
    );
    expect(announced.status).toBe(413);
    const unannounced = new Request(url(), {
      method: 'PUT',
      headers: { origin: ORIGIN },
      body: '{}',
    });
    unannounced.headers.delete('content-length');
    expect((await PUT(unannounced)).status).toBe(411);
    expect(getMemoDirectory).not.toHaveBeenCalled();

    // A body longer than it announced is cut off while reading.
    const lying = await PUT(
      call('PUT', { raw: 'x'.repeat(MEMO_DRAFT_LIMITS.requestBytes + 10), length: 5 }),
    );
    expect(lying.status).toBe(413);

    // A field over its limit, and an unknown field, are 400.
    const longBody = await PUT(
      call('PUT', {
        body: {
          revision: null,
          values: { ...FIELDS, body: 'x'.repeat(MEMO_DRAFT_LIMITS.body + 1) },
        },
      }),
    );
    expect(longBody.status).toBe(400);
    const extra = await PUT(
      call('PUT', { body: { revision: null, values: { ...FIELDS, owner: 'bob' } } }),
    );
    expect(extra.status).toBe(400);
    const badRevision = await PUT(call('PUT', { body: { revision: 'nope', values: FIELDS } }));
    expect(badRevision.status).toBe(400);
    expect((await PUT(call('PUT', { raw: '{not json' }))).status).toBe(400);
  });
});

describe('new-memo draft: owner comes from the session', () => {
  it('round-trips a draft and keeps it per account', async () => {
    expect(await snapshot(await GET(call('GET')))).toEqual({
      revision: null,
      values: null,
      updatedAt: null,
    });

    const saved = await PUT(
      call('PUT', {
        body: { revision: null, values: { ...FIELDS, template: '{"rows":[{"id":"x"}]}' } },
      }),
    );
    expect(saved.status).toBe(200);
    const savedBody = await snapshot(saved);
    expect(savedBody.revision).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(savedBody.values?.template).toBe('{"rows":[{"id":"x"}]}');

    // Same account, later (a refresh, or a new login: the session id is not part of the key).
    getSession.mockResolvedValue({ ...ALICE, id: 'B'.repeat(43) });
    expect(await snapshot(await GET(call('GET')))).toMatchObject({
      revision: savedBody.revision,
      values: { body: 'Partly typed body' },
    });

    // Another account on the same browser sees nothing, and cannot reach Alice's draft by any request detail.
    getSession.mockResolvedValue(BOB);
    getMemoDirectory.mockResolvedValue({ currentUserId: BOB_DB_ID });
    const forged = new Request(`${url()}?sub=alice&orgId=${ALICE.orgId}&owner=alice`, {
      headers: { 'x-user-id': 'alice', 'x-bos-draft-account': memoDraftAccount(BOB) },
    });
    expect(await snapshot(await GET(forged))).toMatchObject({ revision: null, values: null });
  });

  it('refuses reads and writes from a tab left open by the previous account', async () => {
    getSession.mockResolvedValue(BOB);
    expect((await GET(call('GET'))).status).toBe(403);
    expect((await PUT(call('PUT', { body: { revision: null, values: FIELDS } }))).status).toBe(403);
    expect((await DELETE(call('DELETE', { body: { revision: null } }))).status).toBe(403);
    expect(getMemoDirectory).not.toHaveBeenCalled();
    expect(await keysInValkey()).toEqual([]);
  });

  it('checks memo.create through the directory on every call and fails closed without it', async () => {
    getMemoDirectory.mockRejectedValue(
      new ApiError(403, 'forbidden', { error: { code: 'forbidden' } }),
    );
    expect((await GET(call('GET'))).status).toBe(403);
    expect((await PUT(call('PUT', { body: { revision: null, values: FIELDS } }))).status).toBe(403);
    expect((await DELETE(call('DELETE', { body: { revision: null } }))).status).toBe(403);

    getMemoDirectory.mockRejectedValue(new Error('api down'));
    expect((await GET(call('GET'))).status).toBe(502);
    expect((await PUT(call('PUT', { body: { revision: null, values: FIELDS } }))).status).toBe(502);
    expect(await keysInValkey()).toEqual([]);
  });
});

describe('memo draft: must be the creator and able to update, checked on every call', () => {
  const save = () => PUT(call('PUT', { memoId: MEMO, body: { revision: null, values: FIELDS } }));

  it('stores under the memo scope, apart from the new-memo draft', async () => {
    const saved = await save();
    expect(saved.status).toBe(200);
    expect(getMemo).toHaveBeenCalledWith(ALICE, MEMO);
    expect((await snapshot(await GET(call('GET', { memoId: MEMO })))).values?.title).toBe('Budget');
    expect(await snapshot(await GET(call('GET')))).toMatchObject({ revision: null });
    expect(await keysInValkey()).toHaveLength(1);
  });

  it('refuses a memo the caller did not create, as not found, and stores nothing', async () => {
    getMemo.mockResolvedValue(memoOf({ ownerUserId: BOB_DB_ID }));
    expect((await save()).status).toBe(404);
    expect((await GET(call('GET', { memoId: MEMO }))).status).toBe(404);
    expect((await DELETE(call('DELETE', { memoId: MEMO, body: { revision: null } }))).status).toBe(
      404,
    );
    expect(await keysInValkey()).toEqual([]);
  });

  it('refuses reading and saving when the memo is no longer editable, but still lets its creator delete', async () => {
    const saved = await snapshot(await save());
    getMemo.mockResolvedValue(memoOf({ canUpdate: false, status: 'submitted' }));

    expect((await save()).status).toBe(403);
    expect((await GET(call('GET', { memoId: MEMO }))).status).toBe(403);

    const gone = await DELETE(call('DELETE', { memoId: MEMO, body: { revision: saved.revision } }));
    expect(gone.status).toBe(200);
    expect(await snapshot(gone)).toMatchObject({ values: null });
  });

  it('answers what the API says about the memo and denies when it cannot tell', async () => {
    getMemo.mockRejectedValue(new ApiError(404, 'not found', { error: { code: 'not_found' } }));
    expect((await save()).status).toBe(404);
    getMemo.mockRejectedValue(new ApiError(403, 'forbidden', { error: { code: 'forbidden' } }));
    expect((await save()).status).toBe(403);
    getMemo.mockRejectedValue(new ApiError(500, 'boom', undefined));
    expect((await save()).status).toBe(502);

    getMemo.mockResolvedValue(memoOf());
    getMemoDirectory.mockRejectedValue(
      new ApiError(403, 'forbidden', { error: { code: 'forbidden' } }),
    );
    expect((await save()).status).toBe(403);
    getMemoDirectory.mockRejectedValue(new Error('api down'));
    expect((await save()).status).toBe(502);
    expect(await keysInValkey()).toEqual([]);
  });
});

describe('conflicts and tombstones over HTTP', () => {
  it('returns 409 with the current snapshot when a tab writes from a stale revision', async () => {
    const first = await snapshot(
      await PUT(call('PUT', { body: { revision: null, values: { ...FIELDS, body: 'one' } } })),
    );
    const second = await snapshot(
      await PUT(
        call('PUT', { body: { revision: first.revision, values: { ...FIELDS, body: 'two' } } }),
      ),
    );

    const stale = await PUT(
      call('PUT', { body: { revision: first.revision, values: { ...FIELDS, body: 'stale' } } }),
    );
    expect(stale.status).toBe(409);
    const conflict = (await stale.json()) as {
      error: { code: string };
      current: MemoDraftSnapshot;
    };
    expect(conflict.error.code).toBe('conflict');
    expect(conflict.current).toMatchObject({ revision: second.revision, values: { body: 'two' } });
    expect((await snapshot(await GET(call('GET')))).values?.body).toBe('two');
  });

  it('deletes into a revisioned tombstone that a stale tab cannot write back over', async () => {
    const saved = await snapshot(
      await PUT(call('PUT', { body: { revision: null, values: FIELDS } })),
    );
    const del = await DELETE(call('DELETE', { body: { revision: saved.revision } }));
    expect(del.status).toBe(200);
    const tomb = await snapshot(del);
    expect(tomb.values).toBeNull();
    expect(tomb.revision).not.toBeNull();
    expect(tomb.revision).not.toBe(saved.revision);

    const resurrect = await PUT(
      call('PUT', { body: { revision: saved.revision, values: { ...FIELDS, body: 'zombie' } } }),
    );
    expect(resurrect.status).toBe(409);
    expect(((await resurrect.json()) as { current: MemoDraftSnapshot }).current).toMatchObject({
      revision: tomb.revision,
      values: null,
    });
    expect(await snapshot(await GET(call('GET')))).toMatchObject({
      revision: tomb.revision,
      values: null,
    });

    // A stale delete cannot erase a newer draft either; a new draft starts over the tombstone.
    const fresh = await PUT(
      call('PUT', { body: { revision: tomb.revision, values: { ...FIELDS, body: 'again' } } }),
    );
    expect(fresh.status).toBe(200);
    const staleDelete = await DELETE(call('DELETE', { body: { revision: saved.revision } }));
    expect(staleDelete.status).toBe(409);
    expect((await snapshot(await GET(call('GET')))).values?.body).toBe('again');
  });

  it('turns a Valkey outage into 503 and says nothing about the content', async () => {
    const broken = new RedisMock();
    vi.spyOn(broken, 'hmget').mockRejectedValue(new Error('draft body in the error'));
    vi.spyOn(broken, 'eval').mockRejectedValue(new Error('draft body in the error'));
    __setRedisForTests(broken);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    for (const res of [
      await GET(call('GET')),
      await PUT(call('PUT', { body: { revision: null, values: FIELDS } })),
      await DELETE(call('DELETE', { body: { revision: null } })),
    ]) {
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain('draft body');
    }
  });
});
