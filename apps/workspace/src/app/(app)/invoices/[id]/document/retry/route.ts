import { invoiceDocumentPath } from '@/lib/api-billing';
import { pdfRetryResponse } from '@/lib/pdf-retry-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Staff ask for an invoice PDF whose render was given up to be rendered again (round 4, R4c2; pdf-retry-route.ts).
 * The API needs `invoice.issue` (issuing triggers the render) and answers 409 `invoice_pdf_retry_not_needed` unless
 * the render was given up.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const path = UUID.test(id) ? `${invoiceDocumentPath(id)}/retry` : null;
  return pdfRetryResponse(req, path, 'That is not an invoice id.');
}
