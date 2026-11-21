import { ApiError } from '@/lib/api';
import { dbBusyOf, forbiddenOrigin, isSameOrigin, jsonResponse, routeSession } from '@/lib/bff';
import { getPermissionCheck } from '@/lib/live-permissions';

import { proofProblem } from '../new/proof-rules';

import { uploadStaffPaymentProof } from './proof-upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reply = (message: string, status: number): Response =>
  jsonResponse({ error: { message } }, status);

/**
 * Receives one proof file from the Record payment form and stores it through the API's two-step
 * upload. It is a route handler, not a server action, because a server action's request body is
 * capped far below the 25 MB file limit. The file is the raw request body with its own content
 * type; the name travels percent-encoded in `x-file-name` and the customer the proof is for in
 * `x-customer-id`. The body is streamed on, never buffered. Route handlers run no layout, so this
 * checks the Origin and the session itself (the cookie is `SameSite=Lax`, and the Origin check is
 * the second wall), and the `payment.record` grant (the API checks it again). Error text is ours,
 * never the API's: its detail could name internal ids or rules.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const session = await routeSession();
  if (session instanceof Response) return session;
  if (!(await getPermissionCheck(session))('payment.record')) {
    return reply('Your roles do not include recording payments.', 403);
  }

  const customerId = req.headers.get('x-customer-id') ?? '';
  if (!UUID.test(customerId)) return reply('Choose the customer before adding proof.', 400);

  let filename = '';
  try {
    filename = decodeURIComponent(req.headers.get('x-file-name') ?? '');
  } catch {
    return reply('The file name could not be read.', 400);
  }
  const mime = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const lengthHeader = req.headers.get('content-length');
  if (lengthHeader === null || !/^\d{1,12}$/.test(lengthHeader)) {
    return reply('The file size is missing.', 411);
  }
  const size = Number(lengthHeader);
  const problem = proofProblem({ name: filename, type: mime, size });
  if (problem !== null) return reply(problem, 422);
  if (req.body === null) return reply('The file is empty.', 422);

  try {
    const documentId = await uploadStaffPaymentProof(session, {
      customerId,
      filename,
      mime,
      size,
      body: req.body,
    });
    return jsonResponse({ documentId, filename }, 200);
  } catch (err) {
    const busy = dbBusyOf(err);
    if (busy !== null) {
      const res = reply('Busy, please try again.', 503);
      res.headers.set('retry-after', String(busy.retryAfterSeconds));
      return res;
    }
    const status = err instanceof ApiError ? err.status : 0;
    if (status === 401) return reply('Sign in again to upload proof of payment.', 401);
    if (status === 403) return reply('Your roles do not include recording payments.', 403);
    if (status === 404) return reply('We could not find that customer. Reload the page.', 404);
    if (status === 413) return reply('That file is too large.', 413);
    if (status === 415) {
      return reply('That file type is not accepted. Use a PDF or a picture.', 415);
    }
    if (status >= 400 && status < 500) {
      return reply('That file was not accepted. Try another file.', 422);
    }
    return reply('We could not upload that file just now. Please try again.', 502);
  }
}
