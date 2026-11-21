import { devToolsEnabled } from '@/dev/enabled';
import { getMe } from '@/lib/api';
import { getSession, type Session } from '@/lib/session';
import { SessionUnavailableError, sessionUnavailableResponse } from '@/lib/session-unavailable';

/**
 * Dev-only: who the DEV MENU widget is signed in as. It calls the same production functions
 * the app uses (`getSession`, `getMe`) and adds no way around them: no session, no answer.
 *
 * Three walls keep it out of production (risk R12, ADR-0009):
 *  1. The `.dev.ts` suffix: `pageExtensions` in next.config.ts only lists `dev.ts` in
 *     development, so a production build does not see `route.dev.ts` as a route.
 *  2. The devToolsEnabled() check below, for the day wall 1 is misconfigured.
 *  3. scripts/check-no-dev-routes.mjs fails CI if a /dev route or BOS_DEV_MENU is in `.next/`.
 */

// The session lives in Valkey (ioredis), which needs the Node.js runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function GET(): Promise<Response> {
  // Wall 2. A route handler cannot call `notFound()` like a page, so answer 404 directly.
  if (!devToolsEnabled()) return new Response(null, { status: 404 });

  let session: Session | null;
  try {
    session = await getSession();
  } catch (err) {
    if (err instanceof SessionUnavailableError) return sessionUnavailableResponse();
    throw err;
  }
  if (!session) return json(401, { error: 'signed_out' });

  let me;
  try {
    me = await getMe(session);
  } catch {
    return json(502, { error: 'api_unreachable' });
  }

  // An explicit allow-list: never spread `me` or `session`, which can carry secrets.
  return json(200, {
    userId: me.userId,
    tenantId: me.tenantId,
    organizationId: me.organizationId,
    correlationId: me.correlationId,
    orgKind: me.orgKind,
    roles: [...me.roles],
  });
}
