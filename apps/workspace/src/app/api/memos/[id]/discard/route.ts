import { ApiError, apiFetch } from '@/lib/api';
import {
  errorResponse,
  forbiddenOrigin,
  isSameOrigin,
  jsonResponse,
  routeSession,
} from '@/lib/bff';
import { memoDraftAccount } from '@/lib/memo-working-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Delete draft: the creator discards their own draft or returned memo. A soft discard in the API (the memo's number,
 * audit trail and attachment evidence stay; nothing reads or changes it afterwards), so there is no payload and no
 * body to send: the memo id in the path is the whole request. The `x-bos-draft-account` header (as on the working-draft
 * route) must match the signed-in account. The API decides who may do it and in which status,
 * with the caller's own session: 404 for a memo the caller cannot open or one already discarded, 403 for a reader
 * who is not the creator, 409 once the memo was submitted. Success is 204 and nothing else.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const session = await routeSession();
  if (session instanceof Response) return session;
  // The memo form sends the account it was opened under. A tab left open across an account switch must not
  // discard a memo as the new account, so a missing or different value is refused before any API call.
  if (req.headers.get('x-bos-draft-account') !== memoDraftAccount(session)) {
    return jsonResponse(
      { error: { message: 'The signed-in account changed. Reopen this memo to continue.' } },
      403,
    );
  }
  const { id } = await params;
  if (!UUID.test(id)) return jsonResponse({ error: { message: 'That is not a memo id.' } }, 400);
  try {
    const res = await apiFetch(session, `/v1/test-memos/${encodeURIComponent(id)}/discard`, {
      method: 'POST',
    });
    if (!res.ok) {
      const text = await res.text();
      let body: unknown = text === '' ? undefined : text;
      try {
        body = text === '' ? undefined : (JSON.parse(text) as unknown);
      } catch {
        // keep the raw text: failureOf only reads a body that matches the error contract
      }
      throw new ApiError(res.status, `POST discard failed with ${res.status}`, body);
    }
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return errorResponse(err);
  }
}
