import { ApiError, apiFetch } from '@/lib/api';
import { failureOf } from '@/lib/api-kernel';
import { forbiddenOrigin, isSameOrigin, jsonResponse, routeSession } from '@/lib/bff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reply = (message: string, status: number): Response =>
  jsonResponse({ error: { message } }, status);

/**
 * Staff ask for a failed quotation PDF to be rendered again. The API answers 202 `{ state: 'queued' }`, and 409
 * `quotation_pdf_retry_not_needed` when the render has not failed, so a double click is refused harmlessly. A
 * route handler gets no layout, so this checks the Origin and the staff session itself, like the other state-changing
 * handlers; the API checks the grant (`quotation.send`) and the entity again. Error text is ours, never the API's.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; vid: string }> },
): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const { id, vid } = await params;
  if (!UUID.test(id) || !UUID.test(vid)) return reply('That is not a quotation id.', 400);
  const session = await routeSession();
  if (session instanceof Response) return session;

  const path = `/v1/quotations/${encodeURIComponent(id)}/versions/${encodeURIComponent(vid)}/document/retry`;
  try {
    const res = await apiFetch(session, path, { method: 'POST' });
    if (res.status === 202) return jsonResponse({ state: 'queued' }, 202);
    await res.body?.cancel();
    throw new ApiError(res.status, `POST ${path} failed with ${res.status}`);
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 409) return reply('This PDF does not need another try.', 409);
    if (f.status === 403) return reply('You cannot ask for this PDF to be prepared again.', 403);
    if (f.status === 404) return reply('This PDF is not available.', 404);
    return reply('The retry could not be requested.', 502);
  }
}
