import { handleVendorUpload } from '../../../_upload/route-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A KYC file: declared on the vendor's own onboarding case, then streamed to the API. */
export function POST(req: Request): Promise<Response> {
  return handleVendorUpload(req, 'kyc-documents');
}
