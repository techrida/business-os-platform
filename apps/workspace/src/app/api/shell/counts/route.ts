import { ApiError } from '@/lib/api';
import { getInboxCount, getUnreadCount } from '@/lib/api-kernel';
import { errorResponse, jsonResponse, routeSession } from '@/lib/bff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type ShellCounts = { inbox: number | null; notifications: number | null };

/**
 * The shell's one poll: the sidebar's Inbox badge and the bell's unread count, read together on every page
 * change, on focus and every 15 s. Each field stands alone: a refused or failed read of one is `null` for that
 * field only (a non-approver's inbox 403 must not hide the bell), and `null` is never shown as a zero. The
 * one exception is an upstream 401: both reads carry the same token, so the whole answer is 401 and the
 * browser sends the user to sign in. The token never leaves the server.
 */
export async function GET(): Promise<Response> {
  const session = await routeSession({ slide: false });
  if (session instanceof Response) return session;

  const [inbox, notifications] = await Promise.allSettled([
    getInboxCount(session),
    getUnreadCount(session),
  ]);

  for (const result of [inbox, notifications]) {
    if (
      result.status === 'rejected' &&
      result.reason instanceof ApiError &&
      result.reason.status === 401
    ) {
      return errorResponse(result.reason);
    }
  }

  const body: ShellCounts = {
    inbox: inbox.status === 'fulfilled' ? inbox.value.count : null,
    notifications: notifications.status === 'fulfilled' ? notifications.value.count : null,
  };
  return jsonResponse(body);
}
