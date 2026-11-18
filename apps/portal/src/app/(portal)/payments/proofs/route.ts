import { ApiError } from '@/lib/api';
import { uploadPaymentProof } from '@/lib/api.billing';
import { getEnv } from '@/lib/env';
import { SessionUnavailableError, SESSION_UNAVAILABLE_MESSAGE } from '@/lib/session-unavailable';
import { getSession, type Session } from '@/lib/session';

import { proofProblem } from '../_components/proof-rules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function reply(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Receives one proof file from the payment form and stores it through the API's portal upload. It
 * is a route handler, not a server action, because a server action's request body is capped far
 * below the 25 MB file limit. The file is the raw request body with its own content type, and the
 * name travels percent-encoded in `x-file-name`; the body is streamed on, never buffered. Route
 * handlers run no layout, so this checks the session and the Origin itself (the cookie is
 * SameSite=Lax, and the Origin check is the second wall, as on sign-out).
 */
export async function POST(req: Request): Promise<Response> {
  if (req.headers.get('origin') !== new URL(getEnv().PORTAL_PUBLIC_URL).origin) {
    return reply({ error: 'Forbidden' }, 403);
  }
  let session: Session | null;
  try {
    session = await getSession();
  } catch (err) {
    if (!(err instanceof SessionUnavailableError)) throw err;
    const response = reply({ error: SESSION_UNAVAILABLE_MESSAGE }, 503);
    response.headers.set('retry-after', '1');
    return response;
  }
  if (!session) return reply({ error: 'Sign in to upload proof of payment.' }, 401);

  let filename = '';
  try {
    filename = decodeURIComponent(req.headers.get('x-file-name') ?? '');
  } catch {
    return reply({ error: 'The file name could not be read.' }, 400);
  }
  const mime = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const size = Number(req.headers.get('content-length') ?? '');
  if (!Number.isSafeInteger(size)) return reply({ error: 'The file size is missing.' }, 411);
  const problem = proofProblem({ name: filename, type: mime, size });
  if (problem !== null) return reply({ error: problem }, 422);
  if (req.body === null) return reply({ error: 'The file is empty.' }, 422);

  try {
    const documentId = await uploadPaymentProof(session, {
      filename,
      mime,
      size,
      body: req.body,
    });
    return reply({ documentId, filename }, 200);
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 0;
    if (status === 401) return reply({ error: 'Sign in to upload proof of payment.' }, 401);
    if (status === 413) return reply({ error: 'That file is too large.' }, 413);
    if (status === 415) {
      return reply({ error: 'That file type is not accepted. Use a PDF or a picture.' }, 415);
    }
    if (status >= 400 && status < 500) {
      return reply({ error: 'That file was not accepted. Try another file.' }, 422);
    }
    return reply({ error: 'We could not upload that file just now. Please try again.' }, 502);
  }
}
