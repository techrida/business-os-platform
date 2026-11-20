import 'server-only';

import { redirect } from 'next/navigation';

import { permissionChecker } from '@/components/p2/customers/permissions';
import { getPermissionCheck } from '@/lib/live-permissions';
import type { Session } from '@/lib/session';
import { firstAllowedSection } from '@/lib/settings-nav';

import { requireSession } from '../../../guard';

/** Either one opens the Access screens; only the second changes anything. */
const READ_ACCESS = ['admin.roles.read', 'admin.roles.write'] as const;
const WRITE_ACCESS = 'admin.roles.write';

export interface AccessViewer {
  session: Session;
  /** False for a viewer who may only look (spec 4, "View only"). The API still refuses writes. */
  canWrite: boolean;
}

/**
 * The By role and Check a person pages, and their Server Actions, call this first. Pages and the
 * Access layout render in parallel and an action is its own request, so none can rely on another's
 * check. Deny by default: a person without either permission goes to the first Settings section they
 * may open, or to the denied page. `redirect` throws, so call it outside any try block.
 */
export async function requireAccess(returnTo: string): Promise<AccessViewer> {
  const session = await requireSession(returnTo);
  const can = await getPermissionCheck(session);
  if (!READ_ACCESS.some((permission) => can(permission))) {
    redirect(firstAllowedSection(can)?.href ?? '/settings/denied');
  }
  // Changing access stays Founder-only, so the write flag keeps reading the role defaults.
  return { session, canWrite: permissionChecker(session.roles)(WRITE_ACCESS) };
}
