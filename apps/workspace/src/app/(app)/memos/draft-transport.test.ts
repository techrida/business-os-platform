import { describe, expect, it, vi } from 'vitest';

import {
  createDraftTransport,
  discardSavedMemo,
  draftUrl,
  DRAFT_ACCOUNT_HEADER,
} from './draft-transport';

const MEMO = '11111111-1111-4111-8111-111111111111';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const values = { title: 't', body: 'b', amount: '1', currency: 'NPR' };

function transport(reply: () => Response | Promise<Response>, memoId?: string) {
  const fetchImpl = vi.fn((..._args: Parameters<typeof fetch>) => Promise.resolve(reply()));
  return { fetchImpl, t: createDraftTransport({ account: 'acct', memoId, fetchImpl }) };
}

describe('the draft routes, as the browser calls them', () => {
  it('a new memo has no memoId; a saved one names it', () => {
    expect(draftUrl(undefined)).toBe('/api/memos/working-draft');
    expect(draftUrl(MEMO)).toBe(`/api/memos/working-draft?memoId=${MEMO}`);
  });

  it('sends the account binding on every method', async () => {
    const { fetchImpl, t } = transport(() =>
      json({ revision: 'r', values: null, updatedAt: null }),
    );
    await t.load();
    await t.save(null, values, true);
    await t.discard('r');
    expect(
      fetchImpl.mock.calls.map(([, init]) => [
        init?.method,
        (init?.headers as Record<string, string>)[DRAFT_ACCOUNT_HEADER],
      ]),
    ).toEqual([
      ['GET', 'acct'],
      ['PUT', 'acct'],
      ['DELETE', 'acct'],
    ]);
  });

  it('PUT carries {revision, values} and DELETE {revision}; both keep going if the page is leaving', async () => {
    const { fetchImpl, t } = transport(() => json({ revision: 'r2', values, updatedAt: null }));
    await t.save('r1', values, true);
    await t.discard('r2');
    const put = fetchImpl.mock.calls[0]?.[1];
    const del = fetchImpl.mock.calls[1]?.[1];
    expect(JSON.parse(put?.body as string)).toEqual({ revision: 'r1', values });
    expect(put?.keepalive).toBe(true);
    expect(JSON.parse(del?.body as string)).toEqual({ revision: 'r2' });
    expect(del?.keepalive).toBe(true);
  });

  it("reads a 409 as the server's current snapshot", async () => {
    const current = { revision: 'r9', values, updatedAt: null };
    const { t } = transport(() =>
      json({ error: { code: 'conflict', message: 'x' }, current }, 409),
    );
    expect(await t.save('r1', values, true)).toEqual({ kind: 'conflict', current });
  });

  it.each([
    [401, 'signed-out'],
    [403, 'denied'],
    [404, 'denied'],
    [413, 'too-large'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])("maps %i to %s, and shows the server's own message for refusals", async (status, kind) => {
    const { t } = transport(() => json({ error: { message: 'Why not.' } }, status));
    const result = await t.save(null, values, true);
    expect(result.kind).toBe(kind);
    if (kind === 'denied') expect(result).toMatchObject({ message: 'Why not.' });
  });

  it('a network failure is "unavailable", never a thrown error', async () => {
    const t = createDraftTransport({
      account: 'a',
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    expect((await t.load()).kind).toBe('unavailable');
    expect((await t.save(null, values, true)).kind).toBe('unavailable');
  });

  it('a 200 that is not a snapshot is not trusted', async () => {
    const { t } = transport(() => json({ hello: 'world' }));
    expect((await t.load()).kind).toBe('unavailable');
  });
});

describe('discarding a saved memo', () => {
  it('POSTs with the account binding and treats 204 as done', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    expect(await discardSavedMemo(MEMO, 'acct', fetchImpl)).toBeNull();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/memos/${MEMO}/discard`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)[DRAFT_ACCOUNT_HEADER]).toBe('acct');
  });

  it('returns the reason on a refusal or a lost connection', async () => {
    expect(
      await discardSavedMemo(MEMO, 'a', () =>
        Promise.resolve(json({ error: { message: 'Not yours.' } }, 403)),
      ),
    ).toBe('Not yours.');
    expect(await discardSavedMemo(MEMO, 'a', () => Promise.reject(new TypeError('x')))).toMatch(
      /connection/,
    );
  });
});
