import { CreateDocumentBodySchema, MAX_UPLOAD_BYTES } from '@bos/contracts';

import { createDocument, getMemo, uploadDocumentContent } from '@/lib/api-kernel';
import {
  errorResponse,
  forbiddenOrigin,
  isSameOrigin,
  jsonResponse,
  routeSession,
} from '@/lib/bff';
import { baseMime, decodeFileName, toAttachmentView } from '@/lib/kernel-ui';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The only owner type the memo screens attach to; the API checks the caller may touch this memo. */
const MEMO_OWNER_TYPE = 'test_memo';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (message: string, status = 400): Response =>
  jsonResponse({ error: { message } }, status);

/** The scan-status poll: the memo's attachments as the browser needs them. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  const { id } = await params;
  if (!UUID.test(id)) return bad('That is not a memo id.');
  try {
    const memo = await getMemo(session, id);
    return jsonResponse({ items: memo.attachments.map(toAttachmentView) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Upload one attachment. The browser sends the raw file as the request body, with the file's own
 * Content-Type and its name in `x-file-name` (no multipart: this route would have to buffer a
 * 25 MB form to unpack it). Two API calls follow: reserve the document, then stream the bytes.
 * The body is piped through without being read here, so memory stays flat whatever the size.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const session = await routeSession();
  if (session instanceof Response) return session;
  const { id } = await params;
  if (!UUID.test(id)) return bad('That is not a memo id.');

  const lengthHeader = req.headers.get('content-length');
  if (lengthHeader === null || !/^\d{1,12}$/.test(lengthHeader)) {
    return bad('The upload must announce its size.', 411);
  }
  const length = Number(lengthHeader);
  if (length === 0) return bad('That file is empty.');
  // Refuse before any API call: a 25 MB+ upload costs the API a reserved row for nothing.
  if (length > MAX_UPLOAD_BYTES) return bad('That file is larger than 25 MB.', 413);
  if (req.body === null) return bad('The upload had no content.');

  const filename = decodeFileName(req.headers.get('x-file-name'));
  const contentType = baseMime(req.headers.get('content-type'));
  const parsed = CreateDocumentBodySchema.safeParse({
    ownerType: MEMO_OWNER_TYPE,
    ownerId: id,
    filename,
    declaredMime: contentType,
    sizeBytes: length,
  });
  if (!parsed.success) return bad('That file name or type is not allowed.');

  try {
    const created = await createDocument(session, parsed.data);
    const version = await uploadDocumentContent(session, created, {
      body: req.body,
      contentLength: length,
      contentType,
    });
    return jsonResponse({ item: toAttachmentView(version) }, 201);
  } catch (err) {
    return errorResponse(err, 'upload');
  }
}
