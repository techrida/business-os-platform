import { VitalsSchema } from '@bos/contracts';

import { apiFetch } from '@/lib/api';
import { getSession, type Session } from '@/lib/session';
import { SessionUnavailableError, sessionUnavailableResponse } from '@/lib/session-unavailable';

// The session lives in Valkey (ioredis), which needs the Node.js runtime.
export const runtime = 'nodejs';

/** A vitals sample is four short fields. Anything bigger is not a vitals sample. */
const MAX_BODY_BYTES = 2048;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

/**
 * Reads the request body but gives up as soon as it passes the limit. The Content-Length
 * header is only a claim (it can be missing or wrong), so the real byte count decides.
 * Returns null when the body is too large.
 */
async function readLimitedBody(req: Request): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Browser to workspace to API. The browser never talks to the API directly: the workspace
 * holds the access token, validates the sample, and forwards it with the user's identity.
 */
export async function POST(req: Request): Promise<Response> {
  // Auth first, so an anonymous caller cannot make us read or parse anything.
  let session: Session | null;
  try {
    session = await getSession({ slide: false });
  } catch (err) {
    // The store did not answer: not a sign-out, and nothing to accept. The cookie stays.
    if (err instanceof SessionUnavailableError) return sessionUnavailableResponse();
    throw err;
  }
  if (!session) return json(401, { error: 'unauthenticated' });

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json(413, { error: 'payload_too_large' });
  }

  const text = await readLimitedBody(req);
  if (text === null) return json(413, { error: 'payload_too_large' });

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid_body' });
  }

  const parsed = VitalsSchema.safeParse(raw);
  if (!parsed.success) return json(400, { error: 'invalid_body' });

  try {
    const upstream = await apiFetch(session, '/v1/telemetry/vitals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Re-serialise the validated object: unknown fields from the browser never reach the API.
      body: JSON.stringify(parsed.data),
    });
    if (!upstream.ok) return json(502, { error: 'upstream_rejected' });
  } catch {
    return json(502, { error: 'upstream_unavailable' });
  }

  return json(202, { accepted: true });
}
