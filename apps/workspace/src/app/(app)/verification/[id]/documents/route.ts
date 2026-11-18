import { CreateDocumentBodySchema, MAX_UPLOAD_BYTES } from '@bos/contracts';

import { getDocument } from '@/components/p2/crm/verification-api';
import { projectVersion } from '@/components/p2/crm/verification-file';
import { getVerificationCase } from '@/components/p2/customers/api';
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
 * The owner type the verification service looks for when an attach names a document: it lists the
 * documents owned by `verification_case` + the case id and refuses (422) any other. The API also
 * checks that the caller may upload to this case, so no extra lookup is needed here.
 */
const OWNER_TYPE = 'verification_case';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (message: string, status = 400): Response =>
  jsonResponse({ error: { message } }, status);

/** Fresh scan metadata for one version belonging to this case, including an upload awaiting Save. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  const { id } = await params;
  const query = new URL(req.url).searchParams;
  const documentId = query.get('documentId') ?? '';
  const versionId = query.get('versionId') ?? '';
  if (![id, documentId, versionId].every((value) => UUID.test(value))) {
    return bad('That is not a case, document or file version id.');
  }

  try {
    await getVerificationCase(session, id);
    const document = await getDocument(session, documentId);
    if (
      document.ownerType !== OWNER_TYPE ||
      document.ownerId !== id ||
      document.id !== documentId
    ) {
      return bad('File not found.', 404);
    }
    const version = document.versions.find(
      (v) => v.id === versionId && v.documentId === documentId,
    );
    return version === undefined
      ? bad('File not found.', 404)
      : jsonResponse(projectVersion(version));
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Upload one document for a verification case; the browser then attaches it to a checklist item
 * with the `attachDocumentAction`. Same wire format as the memo upload: the raw file is the request
 * body, with the file's own Content-Type and its name in `x-file-name` (no multipart, so a 25 MB
 * form is never buffered here). Two API calls follow: reserve the document, then stream the bytes.
 * Answers 201 with the ids the attach needs.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const session = await routeSession();
  if (session instanceof Response) return session;
  const { id } = await params;
  if (!UUID.test(id)) return bad('That is not a verification case id.');

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
    return jsonResponse(projectVersion(version), 201);
  } catch (err) {
    return errorResponse(err, 'upload');
  }
}
