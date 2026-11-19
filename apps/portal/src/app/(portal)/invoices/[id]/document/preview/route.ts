import { openSignedFile } from '@/lib/api';
import { getPortalInvoiceLink } from '@/lib/api.billing';
import { handleSignedFile } from '@/lib/signed-file-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Inline preview of the frozen invoice PDF, for the document viewer's iframe. Same session,
 * ownership and not-found handling as the download route next to it; only a PDF is served, inline,
 * without the API's sandbox CSP. `next.config.ts` lets this one path be framed by the app itself.
 */
export function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleSignedFile({
    mode: 'preview',
    orgKind: 'customer',
    notFound: 'Invoice not found.',
    signIn: 'Sign in to view this invoice.',
    isId: (id) => UUID.test(id),
    params,
    getLink: getPortalInvoiceLink,
    openFile: openSignedFile,
  });
}
