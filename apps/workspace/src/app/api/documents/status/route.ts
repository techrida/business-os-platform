import { QuotationVersionDtoSchema } from '@bos/contracts';

import { pdfLinkFor } from '@/components/p2/quotations/document-link';
import { ApiError, apiFetch } from '@/lib/api';
import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether the customer PDF of one quotation version is still being prepared: `GET ?quotationId&versionId` answers
 * `{ preparing }`. It makes one API read (`GET /v1/quotations/:id/versions/:vid`) and never issues a signed link, so the
 * "Preparing PDF" words can check every second or two without costing a link or a whole page render. `preparing: false`
 * means the page now has something else to show (the link, "could not be prepared" or other words) and should refresh.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  const params = new URL(request.url).searchParams;
  const quotationId = params.get('quotationId') ?? '';
  const versionId = params.get('versionId') ?? '';
  if (!UUID.test(quotationId) || !UUID.test(versionId)) {
    return jsonResponse({ error: { message: 'That is not a quotation id.' } }, 400);
  }
  const path = `/v1/quotations/${encodeURIComponent(quotationId)}/versions/${encodeURIComponent(versionId)}`;
  try {
    const res = await apiFetch(session, path, { method: 'GET' });
    const text = await res.text();
    const body: unknown = text === '' ? undefined : JSON.parse(text);
    if (!res.ok) throw new ApiError(res.status, `GET ${path} failed with ${res.status}`, body);
    const parsed = QuotationVersionDtoSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(502, `GET ${path} returned an invalid body`, parsed.error.issues);
    }
    const pdf = pdfLinkFor(quotationId, parsed.data);
    return jsonResponse({ preparing: pdf.kind === 'words' && pdf.text === 'Preparing PDF' });
  } catch (error) {
    return errorResponse(error);
  }
}
