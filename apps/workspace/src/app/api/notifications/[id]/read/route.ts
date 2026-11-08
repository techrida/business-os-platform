import { markNotificationRead } from '@/lib/api-kernel';
import { errorResponse, forbiddenOrigin, isSameOrigin, routeSession } from '@/lib/bff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Marks one notification read. The API answers 404 for another user's id, which passes through. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const session = await routeSession();
  if (session instanceof Response) return session;
  const { id } = await params;
  try {
    await markNotificationRead(session, id);
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return errorResponse(err);
  }
}
