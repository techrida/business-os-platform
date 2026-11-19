import { invoiceDocumentPath } from '@/lib/api-billing';
import { fetchSignedLink, signedFileResponse } from '@/lib/signed-file-route';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Both endpoints read the same clean issued original under invoice.read. `GET
 * /v1/invoices/:id/document` issues a 60-second, single-use signed link, so each request issues
 * exactly one.
 */
export async function invoiceFileResponse(
  id: string,
  mode: 'download' | 'preview',
): Promise<Response> {
  return signedFileResponse({
    mode,
    invalid: UUID.test(id) ? null : 'That is not an invoice id.',
    issueLink: (session) => fetchSignedLink(session, invoiceDocumentPath(id)),
  });
}
