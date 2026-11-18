// The browser side of the memo working-draft routes, and nothing else: the URL, the account header and what each
// HTTP answer means. If the route contract changes, this is the one file that follows. Server shapes live in
// '@/lib/memo-working-draft-types' (client-safe: no server-only imports).
import type { MemoDraftSnapshot, MemoDraftValues } from '@/lib/memo-working-draft-types';

/** Binds an open editor to the account that rendered it, so a tab left over from another account cannot write. */
export const DRAFT_ACCOUNT_HEADER = 'x-bos-draft-account';

/** Why a request could not be used. `unavailable` is worth retrying; the others need a person. */
export type DraftFailure =
  | { kind: 'signed-out'; message: string }
  /** 403/404/other refusals, including "the signed-in account changed". Retrying cannot help. */
  | { kind: 'denied'; message: string }
  | { kind: 'too-large'; message: string }
  | { kind: 'unavailable'; message: string };

export type DraftLoad = { kind: 'ok'; snapshot: MemoDraftSnapshot } | DraftFailure;
export type DraftWrite =
  | { kind: 'ok'; snapshot: MemoDraftSnapshot }
  | { kind: 'conflict'; current: MemoDraftSnapshot }
  | DraftFailure;

/** What the sync engine needs from the network. Tests pass a fake. */
export interface DraftTransport {
  load(): Promise<DraftLoad>;
  save(revision: string | null, values: MemoDraftValues, keepalive: boolean): Promise<DraftWrite>;
  discard(revision: string | null): Promise<DraftWrite>;
}

const UNAVAILABLE = 'Saving is paused. Your text is still on this page.';

export function draftUrl(memoId: string | undefined): string {
  return memoId
    ? `/api/memos/working-draft?memoId=${encodeURIComponent(memoId)}`
    : '/api/memos/working-draft';
}

async function messageOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
  const message = body?.error?.message;
  return typeof message === 'string' && message ? message : fallback;
}

async function failureOf(res: Response): Promise<DraftFailure> {
  if (res.status === 401) {
    return { kind: 'signed-out', message: await messageOf(res, 'Sign in to continue.') };
  }
  if (res.status === 413) {
    return { kind: 'too-large', message: await messageOf(res, 'That draft is too large to save.') };
  }
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    return { kind: 'unavailable', message: UNAVAILABLE };
  }
  return { kind: 'denied', message: await messageOf(res, 'This draft cannot be saved.') };
}

const isSnapshot = (value: unknown): value is MemoDraftSnapshot =>
  typeof value === 'object' &&
  value !== null &&
  'revision' in value &&
  (typeof value.revision === 'string' || value.revision === null) &&
  'values' in value;

async function writeResult(res: Response): Promise<DraftWrite> {
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { current?: unknown } | null;
    if (body && isSnapshot(body.current)) return { kind: 'conflict', current: body.current };
    return { kind: 'unavailable', message: UNAVAILABLE };
  }
  if (!res.ok) return failureOf(res);
  const body: unknown = await res.json().catch(() => null);
  return isSnapshot(body)
    ? { kind: 'ok', snapshot: body }
    : { kind: 'unavailable', message: UNAVAILABLE };
}

/** A transport over `fetch`. `account` is the opaque binding the page was rendered with. */
export function createDraftTransport(options: {
  memoId?: string | undefined;
  account: string;
  fetchImpl?: typeof fetch;
}): DraftTransport {
  const url = draftUrl(options.memoId);
  const send = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const headers = (json: boolean): Record<string, string> => ({
    [DRAFT_ACCOUNT_HEADER]: options.account,
    ...(json ? { 'content-type': 'application/json' } : {}),
  });

  async function guarded(run: () => Promise<DraftWrite>): Promise<DraftWrite> {
    try {
      return await run();
    } catch {
      return { kind: 'unavailable', message: UNAVAILABLE };
    }
  }

  return {
    async load() {
      try {
        const res = await send(url, { method: 'GET', headers: headers(false), cache: 'no-store' });
        if (!res.ok) return await failureOf(res);
        const body: unknown = await res.json().catch(() => null);
        return isSnapshot(body)
          ? { kind: 'ok', snapshot: body }
          : { kind: 'unavailable', message: UNAVAILABLE };
      } catch {
        return { kind: 'unavailable', message: UNAVAILABLE };
      }
    },
    save(revision, values, keepalive) {
      return guarded(async () =>
        writeResult(
          await send(url, {
            method: 'PUT',
            headers: headers(true),
            body: JSON.stringify({ revision, values }),
            keepalive,
          }),
        ),
      );
    },
    discard(revision) {
      return guarded(async () =>
        writeResult(
          await send(url, {
            method: 'DELETE',
            headers: headers(true),
            body: JSON.stringify({ revision }),
            keepalive: true,
          }),
        ),
      );
    },
  };
}

/**
 * Deletes a saved memo draft through the BFF. Resolves null on success (204) or the message to show. The same
 * account header guards it, so a stale tab cannot discard another account's memo.
 */
export async function discardSavedMemo(
  memoId: string,
  account: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<string | null> {
  try {
    const res = await fetchImpl(`/api/memos/${encodeURIComponent(memoId)}/discard`, {
      method: 'POST',
      headers: { [DRAFT_ACCOUNT_HEADER]: account },
    });
    if (res.status === 204 || res.ok) return null;
    if (res.status === 401) return 'Your session ended. Sign in again, then delete the draft.';
    return await messageOf(res, 'The draft could not be deleted. Try again.');
  } catch {
    return 'The draft could not be deleted. Check your connection and try again.';
  }
}
