import { issuePoDocumentLink } from '@/lib/api-purchase-orders';
import { signedFileResponse } from '@/lib/signed-file-route';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A version number: a positive whole number (the API parses it as an integer). */
const VERSION = /^[1-9]\d{0,8}$/;

/**
 * Both endpoints read the PDF of one issued purchase order version. The API answers 409 while the
 * file is being prepared (the viewer keeps checking), 424 once its render was given up (the viewer
 * offers Retry) and 404 when there is none; each becomes a plain sentence. Each request asks for at
 * most one single-use link.
 */
export async function purchaseOrderFileResponse(
  id: string,
  version: string,
  mode: 'download' | 'preview',
): Promise<Response> {
  let invalid: string | null = null;
  if (!UUID.test(id)) invalid = 'That is not a purchase order id.';
  else if (!VERSION.test(version)) invalid = 'That is not a version number.';
  return signedFileResponse({
    mode,
    invalid,
    issueLink: (session) => issuePoDocumentLink(session, id, Number(version)),
  });
}
