import { CreateDocumentBodySchema, MAX_UPLOAD_BYTES } from '@bos/contracts';

import { createDocument, uploadDocumentContent } from '@/lib/api-kernel';
import {
  errorResponse,
  forbiddenOrigin,
  isSameOrigin,
  jsonResponse,
  routeSession,
} from '@/lib/bff';
import { baseMime, decodeFileName } from '@/lib/kernel-ui';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The owner type the bank verify looks for: it lists the documents owned by `vendor_bank_account`
 * plus the account id and accepts only one of those, scanned clean, as the call-back evidence.
 * The API also checks that the caller may upload, so no extra lookup is needed here.
 */
const OWNER_TYPE = 'vendor_bank_account';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (message: string, status = 400): Response =>
  jsonResponse({ error: { message } }, status);

/**
 * Upload the call-back evidence for one proposed bank account; the browser then sends the returned
 * document id with the verify action. Same wire format as the verification upload: the raw file is
 * the request body with its own Content-Type and its name in `x-file-name` (no multipart, so a
 * 25 MB file is never buffered here). Answers 201 with the ids.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; accountId: string }> },
): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const session = await routeSession();
  if (session instanceof Response) return session;
  const { id, accountId } = await params;
  if (!UUID.test(id) || !UUID.test(accountId)) return bad('That is not a vendor bank account.');

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
    ownerType: OWNER_TYPE,
    ownerId: accountId,
    filename,
    declaredMime: contentType,
    sizeBytes: length,
  });
  if (!parsed.success) return bad('That file name or type is not allowed.');

  try {
    const created = await createDocument(session, parsed.data);
    await uploadDocumentContent(session, created, {
      body: req.body,
      contentLength: length,
      contentType,
    });
    return jsonResponse({ documentId: created.documentId, versionId: created.versionId }, 201);
  } catch (err) {
    return errorResponse(err, 'upload');
  }
}
