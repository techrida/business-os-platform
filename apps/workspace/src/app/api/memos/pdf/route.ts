import { forbiddenOrigin, isSameOrigin, jsonResponse, routeSession } from '@/lib/bff';
import { memoPdfResponse } from '@/lib/memo-pdf-response';
import { memoPdfFileName } from '@/lib/memo-pdf';
import { MemoPdfInputSchema } from '@/lib/memo-pdf-input';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A memo is at most 10,000 characters of body plus 20 signers: 256 KB is generous and still bounds the work. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * The values currently in the memo form as a real PDF, so a draft can be downloaded before it is saved. The body
 * is bounded, validated field by field and drawn as text only; it is not stored and goes nowhere but back to the
 * caller. Needs a staff session, like every memo screen.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const session = await routeSession();
  if (session instanceof Response) return session;

  const length = Number(req.headers.get('content-length') ?? '');
  if (!Number.isFinite(length) || length <= 0) {
    return jsonResponse({ error: { message: 'The request must announce its size.' } }, 411);
  }
  if (length > MAX_BODY_BYTES) {
    return jsonResponse({ error: { message: 'That memo is too large to export.' } }, 413);
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: { message: 'The memo could not be read.' } }, 400);
  }
  const parsed = MemoPdfInputSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse(
      { error: { message: 'Check the memo: a field is missing or too long to export.' } },
      400,
    );
  }
  return memoPdfResponse(parsed.data, memoPdfFileName(null, parsed.data.title));
}
