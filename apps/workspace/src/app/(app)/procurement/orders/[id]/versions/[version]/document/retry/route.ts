import { pdfRetryResponse } from '@/lib/pdf-retry-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A version number: a positive whole number (the API parses it as an integer). */
const VERSION = /^[1-9]\d{0,8}$/;

/**
 * Staff ask for the PDF of one purchase order version whose render was given up to be rendered again (round 4,
 * R4c2; pdf-retry-route.ts). The API needs `procurement.po.issue`, like the download, and answers 409
 * `purchase_order_pdf_retry_not_needed` unless the render was given up.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; version: string }> },
): Promise<Response> {
  const { id, version } = await params;
  const path =
    UUID.test(id) && VERSION.test(version)
      ? `/v1/procurement/purchase-orders/${encodeURIComponent(id)}/versions/${version}/document/retry`
      : null;
  return pdfRetryResponse(req, path, 'That is not a purchase order version.');
}
