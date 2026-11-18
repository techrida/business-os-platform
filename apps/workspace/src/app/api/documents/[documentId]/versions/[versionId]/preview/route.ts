import { z } from 'zod';

import { normalizeMime, previewKind } from '@/components/ui/file-preview-model';
import { issueDocumentLink, openSignedFile } from '@/lib/api-kernel';
import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const fileId = z.uuid();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ documentId: string; versionId: string }> },
): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  const { documentId, versionId } = await params;
  if (!fileId.safeParse(documentId).success || !fileId.safeParse(versionId).success) {
    return jsonResponse({ error: { message: 'That is not a file id.' } }, 400);
  }

  try {
    const link = await issueDocumentLink(session, documentId, versionId);
    const file = await openSignedFile(session, link);
    const mimeType = normalizeMime(file.headers.get('content-type') ?? '');
    if (!file.body || previewKind(mimeType) === 'unsupported') {
      await file.body?.cancel();
      return jsonResponse({ error: { message: 'This file cannot be previewed.' } }, 415);
    }

    const headers = new Headers({
      'cache-control': 'private, no-store',
      'content-disposition': 'inline',
      'content-type': mimeType,
      'x-content-type-options': 'nosniff',
    });
    const length = file.headers.get('content-length');
    if (length !== null) headers.set('content-length', length);
    return new Response(file.body, { status: 200, headers });
  } catch (error) {
    return errorResponse(error);
  }
}
