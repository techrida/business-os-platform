import { removeEvidenceDocument } from '@/lib/api-kernel';
import {
  errorResponse,
  forbiddenOrigin,
  isSameOrigin,
  jsonResponse,
  routeSession,
} from '@/lib/bff';
import { EVIDENCE_KINDS, type EvidenceKind } from '@/lib/evidence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Removes an evidence file of one record that its uploader abandoned before saving (Remove in the
 * upload control, or closing the dialog unsaved), through the record's own API route, so a caller
 * with that record's permission but no `documents.upload` (the Accountant, Finance) can. The API
 * removes only the uploader's own unused file while the record still takes evidence, and answers
 * 204 again for a file already removed.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = { params: Promise<{ kind: string; ownerId: string; documentId: string }> };

function isKind(value: string): value is EvidenceKind {
  return (EVIDENCE_KINDS as readonly string[]).includes(value);
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const session = await routeSession();
  if (session instanceof Response) return session;
  const { kind, ownerId, documentId } = await params;
  if (!isKind(kind) || ![ownerId, documentId].every((value) => UUID.test(value))) {
    return jsonResponse({ error: { message: 'That is not a record or document id.' } }, 400);
  }
  try {
    await removeEvidenceDocument(session, kind, ownerId, documentId);
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return errorResponse(err, 'remove');
  }
}
