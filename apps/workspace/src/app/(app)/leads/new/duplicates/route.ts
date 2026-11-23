import { LeadDuplicatesResponseSchema } from '@bos/contracts';

import { ApiError, apiFetch } from '@/lib/api';
import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FIELDS = ['company'] as const;

/**
 * The New lead company field's list (BOS-UI-002; it began as the F1-Q54 a duplicate hint):
 * `GET /leads/new/duplicates?company=` forwards the typed text to `GET /v1/leads/duplicates` as the signed-in user and
 * answers `{ matches }` (customers and open leads). The API returns only
 * records the user may read; the token never leaves the server. The browser aborts a stale lookup, and the abort is
 * passed on upstream. Any failure is an error status the hint treats as "nothing to show": it never blocks a save.
 */
export async function GET(req: Request): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;

  const from = new URL(req.url).searchParams;
  const query = new URLSearchParams();
  for (const field of FIELDS) {
    const value = from.get(field)?.trim();
    if (value) query.set(field, value);
  }
  try {
    const res = await apiFetch(session, `/v1/leads/duplicates?${query.toString()}`, {
      signal: req.signal,
    });
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok)
      throw new ApiError(res.status, `GET /v1/leads/duplicates failed with ${res.status}`, body);
    const parsed = LeadDuplicatesResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        502,
        'GET /v1/leads/duplicates returned an invalid body',
        parsed.error.issues,
      );
    }
    return jsonResponse(parsed.data);
  } catch (err) {
    return errorResponse(err);
  }
}
