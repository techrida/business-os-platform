import { openSignedFile } from '@/lib/api';
import { getPortalInvoiceLink } from '@/lib/api.billing';
import { handleSignedFile } from '@/lib/signed-file-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Download the frozen PDF of one invoice. Same handling as the quotation PDF route: the shared
 * handler checks the session itself, the API hands out a short-lived signed link, and the bytes are
 * fetched over the internal URL and streamed on, so no token or API address reaches the browser. A
 * bad id, a 404 and a 403 all answer the same "Invoice not found.".
 */
export function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleSignedFile({
    mode: 'download',
    orgKind: 'customer',
    notFound: 'Invoice not found.',
    signIn: 'Sign in to download this invoice.',
    isId: (id) => UUID.test(id),
    params,
    getLink: getPortalInvoiceLink,
    openFile: openSignedFile,
  });
}
