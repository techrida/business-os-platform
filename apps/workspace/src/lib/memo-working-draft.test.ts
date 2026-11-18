import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from './env';
import {
  DRAFT_TTL_SECONDS,
  DraftStoreUnavailableError,
  draftKey,
  readDraft,
  TOMBSTONE_TTL_SECONDS,
  tombstoneDraft,
  writeDraft,
} from './memo-working-draft';
import type { MemoDraftValues } from './memo-working-draft-types';
import { __setRedisForTests } from './session';
import { type Keyring, openSessionValue } from './session-crypto';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('./oidc', () => ({ refreshTokens: vi.fn() }));

// ioredis-mock has no reachable types (see session.test.ts), so it is loaded through require.
const RedisMock = createRequire(import.meta.url)('ioredis-mock') as new () => Redis;

const ENC_KEY = Buffer.alloc(32, 7);
const RING: Keyring = { currentId: 'k1', keys: new Map([['k1', ENC_KEY]]) };
const ENV = {
  OIDC_ISSUER: 'https://auth.test',
  OIDC_CLIENT_ID: 'client-123',
  OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
  OIDC_AUDIENCE: 'proj-42',
  WORKSPACE_PUBLIC_URL: 'https://app.test',
  API_INTERNAL_URL: 'http://api:3001',
  VALKEY_URL: 'redis://valkey.test:6379',
  SESSION_ENC_KEY: ENC_KEY.toString('base64'),
  SESSION_ENC_KEY_ID: 'k1',
};

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const MEMO = '11111111-1111-4111-8111-111111111111';
const ALICE = { orgId: ORG_A, sub: 'alice' };
const BOB = { orgId: ORG_A, sub: 'bob' };
const ALICE_ORG_B = { orgId: ORG_B, sub: 'alice' };

const values = (body: string, extra: Partial<MemoDraftValues> = {}): MemoDraftValues => ({
  title: 'Budget',
  body,
  amount: '120.50',
  currency: 'NPR',
  ...extra,
});

let redis: Redis;

beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  __resetEnvForTests();
  redis = new RedisMock();
  await redis.flushall(); // ioredis-mock instances share data
  __setRedisForTests(redis);
});

afterEach(() => {
  __setRedisForTests(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function must(
  outcome: ReturnType<typeof writeDraft>,
): Promise<{ revision: string | null; values: MemoDraftValues | null }> {
  const result = await outcome;
  if (!result.ok) throw new Error('expected the write to apply');
  return result.snapshot;
}

describe('draft key and ownership', () => {
  it('is derived from org, subject and scope, and reveals none of them', () => {
    const key = draftKey(ALICE, null);
    expect(key).toBe(
      `ws:memo-draft:${createHash('sha256').update(`${ORG_A}\0alice\0new`).digest('hex')}`,
    );
    expect(key).not.toContain('alice');
    expect(draftKey(ALICE, MEMO)).toBe(draftKey(ALICE, MEMO.toUpperCase()));
    const keys = new Set([
      key,
      draftKey(BOB, null),
      draftKey(ALICE_ORG_B, null),
      draftKey(ALICE, MEMO),
    ]);
    expect(keys.size).toBe(4);
  });

  it("never serves one account's draft to another account, another org or another scope", async () => {
    await must(writeDraft(ALICE, null, null, values('alice secret body')));

    expect((await readDraft(BOB, null)).values).toBeNull();
    expect((await readDraft(ALICE_ORG_B, null)).values).toBeNull();
    expect((await readDraft(ALICE, MEMO)).values).toBeNull();
    expect((await readDraft(ALICE, null)).values?.body).toBe('alice secret body');

    // Bob's own draft never touches Alice's.
    await must(writeDraft(BOB, null, null, values('bob body')));
    expect((await readDraft(ALICE, null)).values?.body).toBe('alice secret body');
    expect((await readDraft(BOB, null)).values?.body).toBe('bob body');
  });

  it('keeps the new-memo draft and a memo draft apart for the same account', async () => {
    await must(writeDraft(ALICE, null, null, values('new memo text')));
    await must(writeDraft(ALICE, MEMO, null, values('edit memo text')));
    expect((await readDraft(ALICE, null)).values?.body).toBe('new memo text');
    expect((await readDraft(ALICE, MEMO)).values?.body).toBe('edit memo text');
  });
});

describe('at rest', () => {
  it('stores the content sealed, bound to its key and revision, with a sliding 30-day TTL', async () => {
    const saved = await must(
      writeDraft(ALICE, null, null, values('confidential body', { template: '{"signers":[1]}' })),
    );
    const key = draftKey(ALICE, null);
    const stored = await redis.hgetall(key);

    expect(stored.rev).toBe(saved.revision);
    expect(stored.del).toBe('0');
    expect(JSON.stringify(stored)).not.toContain('confidential body');
    expect(JSON.stringify(stored)).not.toContain('signers');
    expect(await redis.ttl(key)).toBe(DRAFT_TTL_SECONDS);

    const aad = `${key}|${saved.revision}`;
    const opened = openSessionValue(stored.data ?? '', aad, RING);
    expect(JSON.parse(opened ?? 'null')).toMatchObject({ body: 'confidential body' });
    // Another key or another revision does not open it.
    expect(
      openSessionValue(stored.data ?? '', `${draftKey(BOB, null)}|${saved.revision}`, RING),
    ).toBeNull();
    expect(openSessionValue(stored.data ?? '', `${key}|AAAAAAAAAAAA`, RING)).toBeNull();
  });

  it("serves a sealed value copied under another account as nothing, not as that account's content", async () => {
    await must(writeDraft(ALICE, null, null, values('alice secret body')));
    const alice = await redis.hgetall(draftKey(ALICE, null));
    // A Valkey-level copy of Alice's record into Bob's key.
    await redis.hset(draftKey(BOB, null), alice);

    const seen = await readDraft(BOB, null);
    expect(seen.values).toBeNull();
    expect(JSON.stringify(seen)).not.toContain('alice secret body');
  });
});

describe('no lost writes', () => {
  it('lets exactly one of two concurrent first writes win and hands the loser the winner', async () => {
    const [one, two] = await Promise.all([
      writeDraft(ALICE, null, null, values('from tab one')),
      writeDraft(ALICE, null, null, values('from tab two')),
    ]);
    const wins = [one, two].filter((r) => r.ok);
    const losses = [one, two].filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);

    const stored = await readDraft(ALICE, null);
    const winner = wins[0];
    const loser = losses[0];
    if (!winner?.ok || !loser || loser.ok) throw new Error('unreachable');
    expect(stored.revision).toBe(winner.snapshot.revision);
    expect(loser.current).toEqual(stored);
    expect(loser.current.values?.body).toBe(winner.snapshot.values?.body);
  });

  it('refuses a stale revision and accepts the same write once it has seen the current one', async () => {
    const first = await must(writeDraft(ALICE, null, null, values('v1')));
    const second = await must(writeDraft(ALICE, null, first.revision, values('v2')));

    const stale = await writeDraft(ALICE, null, first.revision, values('v1 edited in a stale tab'));
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.current.revision).toBe(second.revision);
    expect(stale.current.values?.body).toBe('v2');
    expect((await readDraft(ALICE, null)).values?.body).toBe('v2');

    const retry = await writeDraft(ALICE, null, stale.current.revision, values('v2 plus my edit'));
    expect(retry.ok).toBe(true);
    expect((await readDraft(ALICE, null)).values?.body).toBe('v2 plus my edit');
  });

  it('gives every write a new revision, even for identical content', async () => {
    const a = await must(writeDraft(ALICE, null, null, values('same')));
    const b = await must(writeDraft(ALICE, null, a.revision, values('same')));
    expect(b.revision).not.toBe(a.revision);
    expect(b.revision).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it('refuses a first write over an existing draft', async () => {
    await must(writeDraft(ALICE, null, null, values('already here')));
    const outcome = await writeDraft(ALICE, null, null, values('a tab that saw nothing'));
    expect(outcome.ok).toBe(false);
    expect((await readDraft(ALICE, null)).values?.body).toBe('already here');
  });
});

describe('delete is a versioned tombstone', () => {
  it('removes the content, keeps a revision and blocks a stale tab from writing the draft back', async () => {
    const saved = await must(writeDraft(ALICE, null, null, values('to be deleted')));
    const gone = await must(tombstoneDraft(ALICE, null, saved.revision));

    expect(gone.values).toBeNull();
    expect(gone.revision).not.toBeNull();
    expect(gone.revision).not.toBe(saved.revision);
    const stored = await redis.hgetall(draftKey(ALICE, null));
    expect(stored.del).toBe('1');
    expect(stored.data).toBe('');
    expect(JSON.stringify(stored)).not.toContain('to be deleted');
    expect(await redis.ttl(draftKey(ALICE, null))).toBe(TOMBSTONE_TTL_SECONDS);
    expect(await readDraft(ALICE, null)).toMatchObject({ revision: gone.revision, values: null });

    // The stale tab still holds `saved.revision`, and so does a tab that never saw anything.
    const stale = await writeDraft(ALICE, null, saved.revision, values('stale tab resurrects it'));
    const blank = await writeDraft(ALICE, null, null, values('blank tab'));
    for (const outcome of [stale, blank]) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.current).toMatchObject({ revision: gone.revision, values: null });
    }
    expect((await readDraft(ALICE, null)).values).toBeNull();
  });

  it('lets a new draft start over the tombstone by naming its revision', async () => {
    const saved = await must(writeDraft(ALICE, null, null, values('old')));
    const gone = await must(tombstoneDraft(ALICE, null, saved.revision));
    const fresh = await must(writeDraft(ALICE, null, gone.revision, values('new draft')));
    expect((await readDraft(ALICE, null)).values?.body).toBe('new draft');
    expect(await redis.ttl(draftKey(ALICE, null))).toBe(DRAFT_TTL_SECONDS);

    // And the tombstone's revision is now stale too.
    const late = await writeDraft(ALICE, null, gone.revision, values('late'));
    expect(late.ok).toBe(false);
    expect(fresh.revision).not.toBe(gone.revision);
  });

  it('refuses to delete a revision it has not seen, so a stale tab cannot erase a newer edit', async () => {
    const first = await must(writeDraft(ALICE, null, null, values('v1')));
    await must(writeDraft(ALICE, null, first.revision, values('v2 from another tab')));
    const outcome = await tombstoneDraft(ALICE, null, first.revision);
    expect(outcome.ok).toBe(false);
    expect((await readDraft(ALICE, null)).values?.body).toBe('v2 from another tab');
  });

  it('writes a tombstone for a scope with nothing stored when told it saw nothing', async () => {
    const gone = await must(tombstoneDraft(ALICE, MEMO, null));
    expect(gone.revision).not.toBeNull();
    expect((await writeDraft(ALICE, MEMO, null, values('x'))).ok).toBe(false);
  });
});

describe('valkey failures', () => {
  it('throw the one unavailable error instead of serving or saving blind', async () => {
    const broken = new RedisMock();
    vi.spyOn(broken, 'hmget').mockRejectedValue(new Error('connection lost'));
    vi.spyOn(broken, 'eval').mockRejectedValue(new Error('connection lost'));
    __setRedisForTests(broken);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(readDraft(ALICE, null)).rejects.toBeInstanceOf(DraftStoreUnavailableError);
    await expect(writeDraft(ALICE, null, null, values('x'))).rejects.toBeInstanceOf(
      DraftStoreUnavailableError,
    );
    await expect(tombstoneDraft(ALICE, null, null)).rejects.toBeInstanceOf(
      DraftStoreUnavailableError,
    );
  });
});
