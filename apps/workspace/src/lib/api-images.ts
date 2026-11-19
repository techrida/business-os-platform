import 'server-only';

import type { ImageOwnerType, SetImageBody } from '@bos/contracts';

import { ApiError, apiFetch } from './api';
import type { Session } from './session';

/**
 * Server-only calls for record pictures (company logo, profile picture, customer and vendor logos; D33).
 * A picture is a document of an image owner type: `POST /v1/images/:ownerType/:ownerId` uploads it and points the
 * record at it in one call, `PUT` on the same path removes it, and reading goes through `GET /v1/images/:documentId`.
 */

/** One path segment from a caller-supplied id: encoded, so `../` can never climb out of the route. */
const seg = (id: string): string => encodeURIComponent(id);

/**
 * A failure a route can show as is: `message` is written for the person uploading, `status` is the HTTP status
 * to answer with. It never carries the API's body, so no server detail reaches the browser.
 */
export class ImageError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ImageError';
    this.status = status;
  }
}

const MESSAGES: Readonly<Record<number, string>> = {
  403: 'You do not have permission to change this picture.',
  404: 'The picture or the record it belongs to was not found.',
  409: 'This picture was changed at the same time. Reload the page and try again.',
  413: 'The picture is too large. Use one up to 512 KB.',
  415: 'Only PNG, JPEG or WebP pictures can be used.',
};

/**
 * Maps a picture-related API failure to an `ImageError`. Statuses outside the list stay as they were (an
 * `ApiError` or a network error), so the usual `errorResponse` handling (sign in again, API down) still applies.
 */
function toImageError(err: unknown): unknown {
  if (err instanceof ApiError) {
    const message = MESSAGES[err.status];
    if (message !== undefined) return new ImageError(err.status, message);
  }
  return err;
}

async function failed(res: Response, label: string): Promise<ApiError> {
  // Drain the body so the connection is released; it is never put in the error.
  await res.body?.cancel();
  return new ApiError(res.status, `${label} failed with ${res.status}`);
}

/** `PUT /v1/images/:ownerType/:ownerId`: make a document the record's current picture, or null to remove it. */
async function setImage(
  session: Session,
  ownerType: ImageOwnerType,
  ownerId: string,
  documentId: string | null,
): Promise<void> {
  const path = `/v1/images/${seg(ownerType)}/${seg(ownerId)}`;
  const body: SetImageBody = { documentId };
  const res = await apiFetch(session, path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failed(res, `PUT /v1/images/${seg(ownerType)}`);
  await res.body?.cancel();
}

/**
 * Uploads a picture and makes it the record's current one in one call: `POST /v1/images/:ownerType/:ownerId` with
 * the raw bytes. The API creates the document, checks the type and size (415, 413), scans it and moves the pointer;
 * until the scan is clean the picture reads as 404. If any step after creating the document fails, the API removes
 * that document itself, so there is nothing to clean up here.
 */
export async function uploadImage(
  session: Session,
  ownerType: ImageOwnerType,
  ownerId: string,
  file: { bytes: Uint8Array | ArrayBuffer; name: string; mime: string },
): Promise<{ documentId: string }> {
  const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
  const label = `POST /v1/images/${seg(ownerType)}`;
  let res: Response;
  try {
    res = await apiFetch(session, `/v1/images/${seg(ownerType)}/${seg(ownerId)}`, {
      method: 'POST',
      headers: {
        // The file's own type: the API's JSON and form parsers only act on their own types.
        'content-type': file.mime,
        // Encoded, so a name outside ASCII (or with a newline) is still a valid header value.
        'x-file-name': encodeURIComponent(file.name),
      },
      body: bytes as Uint8Array<ArrayBuffer>,
    });
  } catch (err) {
    throw toImageError(err);
  }
  if (!res.ok) throw toImageError(await failed(res, label));

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const documentId =
    typeof body === 'object' && body !== null
      ? (body as { documentId?: unknown }).documentId
      : undefined;
  if (typeof documentId !== 'string' || documentId === '') {
    // 502: the upstream answered, but not with the shape we agreed on. The body is not kept.
    throw new ApiError(502, `${label} returned an invalid body`);
  }
  return { documentId };
}

/** Removes the record's current picture (`PUT` with `documentId: null`); the API soft-removes the old document. */
export async function removeImage(
  session: Session,
  ownerType: ImageOwnerType,
  ownerId: string,
): Promise<void> {
  try {
    await setImage(session, ownerType, ownerId, null);
  } catch (err) {
    throw toImageError(err);
  }
}

/**
 * `GET /v1/images/:documentId`, unbuffered: the caller streams `res.body` on and copies the caching headers.
 * `If-None-Match` is passed through, and a 304 is returned as a valid answer like a 200.
 */
export async function openImage(
  session: Session,
  documentId: string,
  ifNoneMatch?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;
  const res = await apiFetch(session, `/v1/images/${seg(documentId)}`, { method: 'GET', headers });
  if (res.ok || res.status === 304) return res;
  throw toImageError(await failed(res, 'GET /v1/images'));
}
