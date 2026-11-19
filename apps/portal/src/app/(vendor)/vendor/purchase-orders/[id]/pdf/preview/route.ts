import { getVendorPurchaseOrderLink, openVendorFile } from '@/lib/api.vendor';
import { handleSignedFile } from '@/lib/signed-file-route';

import { isUuid } from '../../../../load';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Inline preview of the issued purchase order PDF, for the document viewer's iframe. Same session,
 * ownership and not-found handling as the download route next to it; only a PDF is served, inline,
 * without the API's sandbox CSP. `next.config.ts` lets this one path be framed by the app itself.
 */
export function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleSignedFile({
    mode: 'preview',
    orgKind: 'vendor',
    notFound: 'Purchase order not found.',
    signIn: 'Sign in to view this purchase order.',
    isId: isUuid,
    params,
    getLink: getVendorPurchaseOrderLink,
    openFile: openVendorFile,
  });
}
