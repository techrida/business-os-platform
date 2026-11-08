import 'server-only';

import { redirect } from 'next/navigation';

import { getSession, type Session } from '@/lib/session';

/**
 * Every admin page and Server Action calls this first. Layouts and pages render in parallel and an
 * action is a separate request, so none of them can lean on another one's session check.
 * `redirect` throws, so call this outside any try block.
 */
export async function requireSession(returnTo: string): Promise<Session> {
  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  // Customer and vendor users have a valid session but no business in the admin area.
  if (session.orgKind !== 'staff') redirect('/staff-only');
  return session;
}
