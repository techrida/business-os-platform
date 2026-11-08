import { listNotifications } from '@/lib/api-kernel';
import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The bell's list. Times are formatted here, in Kathmandu time, so the browser bundle does not
 * need the locale package and every screen shows the same clock.
 */
export async function GET(): Promise<Response> {
  const session = await routeSession();
  if (session instanceof Response) return session;
  try {
    const notifications = await listNotifications(session, { limit: 30 });
    return jsonResponse({
      items: notifications.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        link: n.link,
        readAt: n.readAt,
        createdLabel: when(n.createdAt),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
