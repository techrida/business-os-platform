import { CreateDocumentBodySchema, ErrorBodySchema, MAX_UPLOAD_BYTES } from '@bos/contracts';

import { projectVersion } from '@/components/p2/crm/verification-file';
import { ApiError } from '@/lib/api';
import {
  createEvidenceDocument,
  getEvidenceDocument,
  removeEvidenceDocument,
  uploadEvidenceContent,
} from '@/lib/api-kernel';
import {
  errorResponse,
  forbiddenOrigin,
  isSameOrigin,
  jsonResponse,
  routeSession,
} from '@/lib/bff';
import { EVIDENCE_KINDS, EVIDENCE_OWNER_TYPE, type EvidenceKind } from '@/lib/evidence';
import { baseMime, decodeFileName } from '@/lib/kernel-ui';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Evidence for one record (a sales order's billable step, a vendor bill's match exception, an RFQ
 * quotation): the file is uploaded in the dialog that needs it, through the record's own
 * `/evidence-documents` API route (owned by `evidence` + the record's id, with that record's
 * permission), and the form then posts the new document id. On save the API checks the document is
 * evidence of that record in the caller's entity (422 `invalid_evidence_document` otherwise).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = { params: Promise<{ kind: string; ownerId: string }> };

const bad = (message: string, status = 400): Response =>
  jsonResponse({ error: { message } }, status);

/**
 * This route's words for the refusals the shared upload wording gives to a memo: any record kind
 * takes evidence here (an order, a bill, an RFQ), so the sentence names none of them.
 */
function evidenceRefusal(err: unknown): Response | undefined {
  if (!(err instanceof ApiError)) return undefined;
  if (err.status === 409) {
    return jsonResponse(
      {
        error: {
          message: 'This record no longer takes evidence files. Reload it to see where it stands.',
          reload: true,
        },
      },
      409,
    );
  }
  const parsed = ErrorBodySchema.safeParse(err.body);
  if (
    err.status === 422 &&
    parsed.success &&
    parsed.data.error.code === 'invalid_evidence_document'
  ) {
    return jsonResponse(
      {
        error: {
          message: 'This file could not be kept as evidence for this record. Upload it again.',
          reload: false,
        },
      },
      422,
    );
  }
  return undefined;
}

function isKind(value: string): value is EvidenceKind {
  return (EVIDENCE_KINDS as readonly string[]).includes(value);
}

/** Fresh scan metadata for one version of an evidence file of this record, including one awaiting Save. */
export async function GET(req: Request, { params }: Params): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  const { kind, ownerId } = await params;
  const query = new URL(req.url).searchParams;
  const documentId = query.get('documentId') ?? '';
  const versionId = query.get('versionId') ?? '';
  if (!isKind(kind) || ![ownerId, documentId, versionId].every((value) => UUID.test(value))) {
    return bad('That is not a record, document or file version id.');
  }

  try {
    const document = await getEvidenceDocument(session, kind, ownerId, documentId);
    if (
      document.ownerType !== EVIDENCE_OWNER_TYPE ||
      document.ownerId !== ownerId ||
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
 * Upload one evidence file. Same wire format as the verification case upload: the raw file is the
 * request body, with its own Content-Type and its name in `x-file-name` (no multipart, so a 25 MB
 * file is never buffered here). Reserves the document, streams the bytes, and answers 201 with the
 * new version's `FileView` (status `quarantined` until the scan finishes). When the bytes fail, the
 * reserved file is removed again through the record's route. The owner fields are
 * checked with the generic document schema; the API route takes only the file fields.
 */
export async function POST(req: Request, { params }: Params): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const session = await routeSession();
  if (session instanceof Response) return session;
  const { kind, ownerId } = await params;
  if (!isKind(kind) || !UUID.test(ownerId)) return bad('That is not a record id.');

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
    ownerType: EVIDENCE_OWNER_TYPE,
    ownerId,
    filename,
    declaredMime: contentType,
    sizeBytes: length,
  });
  if (!parsed.success) return bad('That file name or type is not allowed.');

  let reserved: string | undefined;
  try {
    const { filename: name, declaredMime, sizeBytes } = parsed.data;
    const created = await createEvidenceDocument(session, kind, ownerId, {
      filename: name,
      declaredMime,
      sizeBytes,
    });
    reserved = created.documentId;
    const version = await uploadEvidenceContent(session, kind, ownerId, created, {
      body: req.body,
      contentLength: length,
      contentType,
    });
    return jsonResponse(projectVersion(version), 201);
  } catch (err) {
    // The browser never learns the reserved id, so a file whose bytes failed would stay unusable on
    // the record: remove it on the record's own route, best effort, and keep the upload's failure.
    if (reserved !== undefined) {
      await removeEvidenceDocument(session, kind, ownerId, reserved).catch(() => undefined);
    }
    return evidenceRefusal(err) ?? errorResponse(err, 'upload');
  }
}
