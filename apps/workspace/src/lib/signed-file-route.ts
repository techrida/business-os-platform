import { SignedLinkDtoSchema, type SignedLinkDto } from '@bos/contracts';

import { ApiError, apiFetch } from '@/lib/api';
import { failureOf, openSignedFile } from '@/lib/api-kernel';
import { routeSession } from '@/lib/bff';
import { dbBusyOf } from '@/lib/db-busy';
import type { Session } from '@/lib/session';
import { SESSION_UNAVAILABLE_MESSAGE } from '@/lib/session-unavailable';

/** A download is a page navigation, so a failure is plain text a person can read, not JSON. */
export function plain(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * `GET <path>` answers a 60-second, single-use signed link. The API answers 409 while a file is not
 * ready, 424 when it could not be prepared and 404 or 410 when there is none. Every call issues a new link, so call this once per click and
 * never to "check" a file.
 */
export async function fetchSignedLink(session: Session, path: string): Promise<SignedLinkDto> {
  const res = await apiFetch(session, path, { method: 'GET' });
  const body = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, `GET ${path} failed with ${res.status}`, body);
  const parsed = SignedLinkDtoSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `GET ${path} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

/** Plain words for the statuses that mean "no file to hand out", so a person never reads the scan or job state. */
const UNAVAILABLE_MESSAGES: Record<number, string> = {
  409: 'This PDF is still being prepared.',
  424: 'The PDF could not be prepared.',
  404: 'This PDF is not available.',
  410: 'This PDF is not available.',
};

export interface SignedFileOptions {
  mode: 'download' | 'preview';
  /** A message for input that is not valid. Checked before the session; answers 400 in plain text. */
  invalid?: string | null;
  /** Completes "Sign in to <verb> this file." for a signed-out visitor. Defaults to `mode`. */
  signInVerb?: string;
  /** Issues exactly one signed link, called once per request and only for a valid, signed-in call. */
  issueLink: (session: Session) => Promise<SignedLinkDto>;
}

/**
 * Stream one scan-approved PDF through the workspace. The API hands out a signed link as a relative
 * path and the workspace has no public API address (its CSP is `connect-src 'self'`), so this asks
 * for the link, fetches the bytes over the internal URL and streams them on. The signed token never
 * reaches the browser; the API's safe headers (attachment, nosniff, sandbox CSP, the detected type)
 * pass through. A preview is inline, so it drops the sandbox CSP and accepts only a PDF.
 */
export async function signedFileResponse(options: SignedFileOptions): Promise<Response> {
  const { mode, invalid, issueLink } = options;
  if (invalid) return plain(invalid, 400);

  const session = await routeSession();
  if (session instanceof Response) {
    if (session.status === 503) {
      const response = plain(SESSION_UNAVAILABLE_MESSAGE, 503);
      response.headers.set('retry-after', session.headers.get('retry-after') ?? '1');
      return response;
    }
    return plain(
      session.status === 401
        ? `Sign in to ${options.signInVerb ?? mode} this file.`
        : 'Staff only.',
      session.status,
    );
  }

  try {
    const link = await issueLink(session);
    const file = await openSignedFile(session, link);
    const contentType = file.headers.get('content-type');
    if (mode === 'preview' && (contentType !== 'application/pdf' || !file.body)) {
      await file.body?.cancel();
      return plain('This file cannot be previewed.', 415);
    }
    const headers = new Headers({
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    for (const name of [
      'content-type',
      'content-disposition',
      'content-length',
      'content-security-policy',
    ]) {
      const value = file.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    if (mode === 'preview') {
      // The browser can only frame this endpoint from the same origin (see next.config.ts).
      // The attachment's sandbox policy would also disable the browser's built-in PDF viewer.
      headers.delete('content-security-policy');
      headers.set('content-disposition', 'inline');
    }
    return new Response(file.body, { status: 200, headers });
  } catch (err) {
    // The API rolled back and says it is safe to retry (503 db_busy + Retry-After): a download is a navigation, so the
    // browser shows the plain 503 and its wait instead of reading the busy database as a gateway fault (502).
    const busy = dbBusyOf(err);
    if (busy !== null) {
      const response = plain('Busy, please try again.', 503);
      response.headers.set('retry-after', String(busy.retryAfterSeconds));
      return response;
    }
    const f = failureOf(err);
    return plain(
      UNAVAILABLE_MESSAGES[f.status] ?? f.message,
      f.status >= 400 && f.status < 500 ? f.status : 502,
    );
  }
}
