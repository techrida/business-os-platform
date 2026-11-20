import { getInboxPage } from '@/lib/api-kernel';
import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The sidebar's Inbox badge reads this on every page change, on focus and every 15 s: the app layout
 * persists across navigation, so the count it read on the server goes stale. It returns only
 * `{ count }` (the inbox total; one row is fetched); the token never leaves the server. A failed or
 * refused read is an error, never a zero.
 */
export async function GET(): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  try {
    const page = await getInboxPage(session, { limit: 1 });
    return jsonResponse({ count: page.total });
  } catch (err) {
    return errorResponse(err);
  }
}
