import { getVendorPurchaseOrderLink, openVendorFile } from '@/lib/api.vendor';
import { handleSignedFile } from '@/lib/signed-file-route';

import { isUuid } from '../../../load';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Download the issued PDF of one purchase order. Route handlers run no layout, so the shared
 * handler checks the session itself. The API hands out a short-lived signed link as a relative
 * `/v1/files/<token>` path, and the portal has no public API address (CSP `connect-src 'self'`),
 * so the bytes are fetched over the internal URL and streamed on. The token never reaches the
 * browser, and only the API's safe headers (type, attachment, length, sandbox CSP) are passed on.
 *
 * A bad id, a 404 and a 403 all answer the same "Purchase order not found": the vendor must not
 * learn whether an order that is not theirs, or not yet issued, exists.
 */
export function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleSignedFile({
    mode: 'download',
    orgKind: 'vendor',
    notFound: 'Purchase order not found.',
    signIn: 'Sign in to download this purchase order.',
    isId: isUuid,
    params,
    getLink: getVendorPurchaseOrderLink,
    openFile: openVendorFile,
  });
}
