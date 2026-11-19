import { CreateDocumentBodySchema, MAX_UPLOAD_BYTES } from '@bos/contracts';

import { isGuid } from '@/components/p2/customers/format';
import {
  createBillDocument,
  replaceBillDocument,
  uploadBillDocumentContent,
} from '@/lib/api-payables';
import {
  errorResponse,
  forbiddenOrigin,
  isSameOrigin,
  jsonResponse,
  routeSession,
} from '@/lib/bff';
import { getGrants, hasGrant } from '@/lib/grants';
import { baseMime, decodeFileName } from '@/lib/kernel-ui';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FileSchema = CreateDocumentBodySchema.pick({
  filename: true,
  declaredMime: true,
  sizeBytes: true,
});
const bad = (message: string, status = 400) => jsonResponse({ error: { message } }, status);

export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const session = await routeSession();
  if (session instanceof Response) return session;
  // Live grants, as the new-bill page that uploads here is gated on (not the role defaults).
  if (!hasGrant(await getGrants(session), 'payables.bill.enter'))
    return bad('Your roles do not allow invoice uploads for vendor bills.', 403);
  const vendorId = req.headers.get('x-vendor-id') ?? '';
  const documentId = req.headers.get('x-document-id');
  if (documentId !== null && !isGuid(documentId))
    return bad('That invoice document is not valid. Reload the bill.');
  if (documentId === null && !isGuid(vendorId))
    return bad('Choose a vendor before uploading the invoice.');
  const announced = req.headers.get('content-length');
  if (announced === null || !/^\d{1,12}$/.test(announced))
    return bad('The upload must announce its size.', 411);
  const length = Number(announced);
  if (length === 0) return bad('The invoice file is empty.');
  if (length > MAX_UPLOAD_BYTES) return bad('The invoice file must be at most 25 MB.', 413);
  if (req.body === null) return bad('The upload had no content.');
  const contentType = baseMime(req.headers.get('content-type'));
  const parsed = FileSchema.safeParse({
    filename: decodeFileName(req.headers.get('x-file-name')),
    declaredMime: contentType,
    sizeBytes: length,
  });
  if (!parsed.success) return bad('That invoice file name or type is not allowed.');
  try {
    const created =
      documentId === null
        ? await createBillDocument(session, vendorId, parsed.data)
        : await replaceBillDocument(session, documentId, parsed.data);
    await uploadBillDocumentContent(session, created, {
      body: req.body,
      contentLength: length,
      contentType,
    });
    return jsonResponse({ documentId: created.documentId, versionId: created.versionId }, 201);
  } catch (err) {
    return errorResponse(err, 'upload');
  }
}
