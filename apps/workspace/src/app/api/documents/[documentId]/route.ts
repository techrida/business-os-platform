import { removeDocument } from '@/lib/api-kernel';
import {
  errorResponse,
  forbiddenOrigin,
  isSameOrigin,
  jsonResponse,
  routeSession,
} from '@/lib/bff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Soft-removes a document on an editable owner via `DELETE /v1/documents/:id`. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const session = await routeSession();
  if (session instanceof Response) return session;
  const { documentId } = await params;
  if (!UUID.test(documentId)) {
    return jsonResponse({ error: { message: 'That is not a document id.' } }, 400);
  }
  try {
    await removeDocument(session, documentId);
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return errorResponse(err, 'remove');
  }
}
