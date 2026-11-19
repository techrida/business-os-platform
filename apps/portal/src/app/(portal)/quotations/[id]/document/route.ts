import { getPortalQuotationLink, openSignedFile } from '@/lib/api';
import { handleSignedFile } from '@/lib/signed-file-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Download the frozen PDF of one quotation. Route handlers run no layout, so the shared handler
 * checks the session itself. The API hands out a short-lived signed link as a relative
 * `/v1/files/<token>` path, and the portal has no public API address (CSP `connect-src 'self'`),
 * so the bytes are fetched over the internal URL and streamed on. The token never reaches the
 * browser, and only the API's safe headers (type, attachment, length, sandbox CSP) are passed on.
 *
 * A bad id, a 404 and a 403 all answer the same "Quotation not found": the customer must not learn
 * whether a quotation that is not theirs, or not yet sent, exists.
 */
export function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleSignedFile({
    mode: 'download',
    orgKind: 'customer',
    notFound: 'Quotation not found.',
    signIn: 'Sign in to download this quotation.',
    isId: (id) => UUID.test(id),
    params,
    getLink: getPortalQuotationLink,
    openFile: openSignedFile,
  });
}
