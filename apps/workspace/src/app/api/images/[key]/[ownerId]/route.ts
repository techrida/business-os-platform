import { IMAGE_MAX_BYTES, IMAGE_MIME, isImageOwnerType, type ImageOwnerType } from '@bos/contracts';

import { ImageError, removeImage, uploadImage } from '@/lib/api-images';
import {
  errorResponse,
  forbiddenOrigin,
  isSameOrigin,
  jsonResponse,
  routeSession,
} from '@/lib/bff';
import type { Session } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Room for the multipart boundaries and part headers around one file of at most `IMAGE_MAX_BYTES`. */
const MULTIPART_OVERHEAD = 16_384;
const MAX_BODY = IMAGE_MAX_BYTES + MULTIPART_OVERHEAD;

// Same wording as `ImageError` in lib/api-images, so a refusal reads the same whether it is ours or the API's.
const TOO_LARGE = 'The picture is too large. Use one up to 512 KB.';
const WRONG_TYPE = 'Only PNG, JPEG or WebP pictures can be used.';

const fail = (status: number, message: string): Response =>
  jsonResponse({ error: { message } }, status);

/**
 * `/api/images/:ownerType/:ownerId`: set (POST) or remove (DELETE) the picture of a record: `entity_logo`,
 * `user_avatar`, `customer_logo` or `vendor_logo`. The first folder is `[key]` because Next requires one slug name
 * per level and `/api/images/:documentId` (GET) shares it. Route handlers get no origin check from Next, so both
 * methods check the Origin before anything else (the cookie is `SameSite=Lax`; this is the second wall). The API
 * decides who may change which record, and checks type, size and scan again.
 */

type Target = { session: Session; ownerType: ImageOwnerType; ownerId: string };

/** Origin, session, then the path. A Response means stop and return it. */
async function gate(
  req: Request,
  params: Promise<{ key: string; ownerId: string }>,
): Promise<Target | Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const session = await routeSession();
  if (session instanceof Response) return session;
  const { key: ownerType, ownerId } = await params;
  if (!isImageOwnerType(ownerType)) return fail(404, 'There is no picture of that kind.');
  if (!UUID.test(ownerId)) return fail(400, 'That is not a record id.');
  return { session, ownerType, ownerId: ownerId.toLowerCase() };
}

function failure(err: unknown, context: 'upload' | 'remove'): Response {
  if (err instanceof ImageError) return fail(err.status, err.message);
  return errorResponse(err, context);
}

/** Reads the body up to `max` bytes. Null when it is longer, so a lying Content-Length cannot buy memory. */
async function readBounded(req: Request, max: number): Promise<Uint8Array | null> {
  if (req.body === null) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Upload: `multipart/form-data` with one field `file`. The type and size are checked here before any API call, then
 * the picture is uploaded, scanned and made current. Answers `{ documentId }`; until the scan is clean,
 * `GET /api/images/:documentId` is a 404.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string; ownerId: string }> },
): Promise<Response> {
  const target = await gate(req, params);
  if (target instanceof Response) return target;

  const contentType = req.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    return fail(415, 'Send the picture as a file upload.');
  }
  const lengthHeader = req.headers.get('content-length');
  if (lengthHeader === null || !/^\d{1,12}$/.test(lengthHeader)) {
    return fail(411, 'The picture size is missing.');
  }
  if (Number(lengthHeader) > MAX_BODY) return fail(413, TOO_LARGE);

  const raw = await readBounded(req, MAX_BODY);
  if (raw === null) return fail(413, TOO_LARGE);
  let form: FormData;
  try {
    form = await new Response(raw as Uint8Array<ArrayBuffer>, {
      headers: { 'content-type': contentType },
    }).formData();
  } catch {
    return fail(400, 'The upload could not be read.');
  }

  const file = form.get('file');
  if (!(file instanceof File)) return fail(400, 'Choose a picture to upload.');
  const mime = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!(IMAGE_MIME as readonly string[]).includes(mime)) return fail(415, WRONG_TYPE);
  if (file.size > IMAGE_MAX_BYTES) return fail(413, TOO_LARGE);
  if (file.size === 0) return fail(400, 'The picture is empty.');

  try {
    const { documentId } = await uploadImage(target.session, target.ownerType, target.ownerId, {
      bytes: await file.arrayBuffer(),
      name: file.name || 'picture',
      mime,
    });
    return jsonResponse({ documentId }, 200);
  } catch (err) {
    return failure(err, 'upload');
  }
}

/** Removes the record's current picture. Answers 204, the record then shows its initials. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ key: string; ownerId: string }> },
): Promise<Response> {
  const target = await gate(req, params);
  if (target instanceof Response) return target;
  try {
    await removeImage(target.session, target.ownerType, target.ownerId);
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return failure(err, 'remove');
  }
}
