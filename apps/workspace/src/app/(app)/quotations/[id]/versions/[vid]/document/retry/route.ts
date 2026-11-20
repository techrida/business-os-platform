import { pdfRetryResponse } from '@/lib/pdf-retry-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Staff ask for a quotation PDF whose render was given up to be rendered again (pdf-retry-route.ts). The API needs
 * `quotation.send` and answers 409 `quotation_pdf_retry_not_needed` unless the render was given up.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; vid: string }> },
): Promise<Response> {
  const { id, vid } = await params;
  const path =
    UUID.test(id) && UUID.test(vid)
      ? `/v1/quotations/${encodeURIComponent(id)}/versions/${encodeURIComponent(vid)}/document/retry`
      : null;
  return pdfRetryResponse(req, path, 'That is not a quotation id.');
}
