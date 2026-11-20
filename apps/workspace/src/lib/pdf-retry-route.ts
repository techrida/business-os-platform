import { ApiError, apiFetch } from '@/lib/api';
import { failureOf } from '@/lib/api-kernel';
import { forbiddenOrigin, isSameOrigin, jsonResponse, routeSession } from '@/lib/bff';

const reply = (message: string, status: number): Response =>
  jsonResponse({ error: { message } }, status);

/**
 * Staff ask for a generated PDF whose render was given up to be rendered again (round 4, R4c2: F1-Q13). One handler
 * for the quotation, invoice and purchase order retry routes. The API answers 202 `{ state: 'queued' }`, and 409 when
 * the render was not given up, so a double click is refused harmlessly. A route handler gets no layout, so this checks
 * the Origin and the staff session itself, like the other state-changing handlers; the API checks the grant (the
 * permission of the action that triggers the render) and the entity again. Error text is ours, never the API's.
 *
 * `apiPath` is null when the route's ids did not validate; `invalid` is then the 400 message.
 */
export async function pdfRetryResponse(
  req: Request,
  apiPath: string | null,
  invalid: string,
): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  if (apiPath === null) return reply(invalid, 400);
  const session = await routeSession();
  if (session instanceof Response) return session;

  try {
    const res = await apiFetch(session, apiPath, { method: 'POST' });
    if (res.status === 202) return jsonResponse({ state: 'queued' }, 202);
    await res.body?.cancel();
    throw new ApiError(res.status, `POST ${apiPath} failed with ${res.status}`);
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 409) return reply('This PDF does not need another try.', 409);
    if (f.status === 403) return reply('You cannot ask for this PDF to be prepared again.', 403);
    if (f.status === 404) return reply('This PDF is not available.', 404);
    return reply('The retry could not be requested.', 502);
  }
}
