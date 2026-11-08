import { getUnreadCount } from '@/lib/api-kernel';
import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The bell polls this every 15 s. It returns only `{ count }`; the token never leaves the server. */
export async function GET(): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  try {
    return jsonResponse(await getUnreadCount(session));
  } catch (err) {
    return errorResponse(err);
  }
}
