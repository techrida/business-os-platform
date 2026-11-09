import { handleVendorUpload } from '../../../../_upload/route-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A quotation file: declared on the vendor's own party, then streamed to the API. */
export function POST(req: Request): Promise<Response> {
  return handleVendorUpload(req, 'quotation-submissions');
}
