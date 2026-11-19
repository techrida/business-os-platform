import 'server-only';

import { redirect } from 'next/navigation';

import { permissionChecker } from '@/components/p2/customers/permissions';
import { getSession, type Session } from '@/lib/session';
import {
  canOpenSection,
  firstAllowedSection,
  settingsSection,
  type SettingsSectionId,
} from '@/lib/settings-nav';

/**
 * Every settings page and Server Action calls this first. Layouts and pages render in parallel and an
 * action is a separate request, so none of them can lean on another one's session check.
 * `redirect` throws, so call this outside any try block.
 */
export async function requireSession(returnTo: string): Promise<Session> {
  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  // Customer and vendor users have a valid session but no business in the settings area.
  if (session.orgKind !== 'staff') redirect('/staff-only');
  return session;
}

/**
 * `requireSession`, then the section's own permission (deny by default). A person without it is
 * sent to the first section they may open, or to the Settings denied page when there is none. The API
 * still enforces every call; this keeps the page, and the actions behind it, shut to people
 * whose role does not open the section. Call it outside any try block.
 */
export async function requireSection(id: SettingsSectionId, returnTo?: string): Promise<Session> {
  const section = settingsSection(id);
  const session = await requireSession(returnTo ?? section.href);
  const can = permissionChecker(session.roles);
  if (!canOpenSection(section, can)) {
    redirect(firstAllowedSection(can)?.href ?? '/settings/denied');
  }
  return session;
}
