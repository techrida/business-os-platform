import { IMAGE_MIME } from '@bos/contracts';

import { ImageError, openImage } from '@/lib/api-images';
import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A picture's bytes never change for a document id (one version per upload), so the browser keeps it a day. */
const IMAGE_CACHE = 'private, max-age=86400, immutable';

/**
 * `GET /api/images/:documentId`: the same-origin proxy of `GET /v1/images/:documentId`, so `<img src>` stays under
 * CSP `img-src 'self'` and the token never reaches the browser. The folder is `[key]` because Next requires one slug
 * name per level and `/api/images/:ownerType/:ownerId` (upload, remove) shares it. Any failure is JSON with a 4xx or
 * 502, never an image, so an `<img>` falls back to its initials through `onError`. A picture still being scanned,
 * removed or of another tenant is a 404 from the API.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  const { key: documentId } = await params;
  if (!UUID.test(documentId)) {
    return jsonResponse({ error: { message: 'That is not a picture id.' } }, 400);
  }

  try {
    const file = await openImage(
      session,
      documentId,
      request.headers.get('if-none-match') ?? undefined,
    );
    const etag = file.headers.get('etag');

    if (file.status === 304) {
      await file.body?.cancel();
      const headers = new Headers({ 'cache-control': IMAGE_CACHE });
      if (etag !== null) headers.set('etag', etag);
      return new Response(null, { status: 304, headers });
    }

    const mime = (file.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!file.body || !(IMAGE_MIME as readonly string[]).includes(mime)) {
      await file.body?.cancel();
      return jsonResponse({ error: { message: 'This file is not a picture.' } }, 415);
    }

    const headers = new Headers({
      'cache-control': IMAGE_CACHE,
      'content-disposition': 'inline',
      'content-type': mime,
      'x-content-type-options': 'nosniff',
    });
    const length = file.headers.get('content-length');
    if (length !== null) headers.set('content-length', length);
    if (etag !== null) headers.set('etag', etag);
    return new Response(file.body, { status: 200, headers });
  } catch (err) {
    if (err instanceof ImageError) {
      return jsonResponse({ error: { message: err.message } }, err.status);
    }
    return errorResponse(err);
  }
}
