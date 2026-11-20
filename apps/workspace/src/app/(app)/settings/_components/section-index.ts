import 'server-only';

import { redirect } from 'next/navigation';

import { getPermissionCheck } from '@/lib/live-permissions';
import {
  firstAllowedInGroup,
  firstAllowedSection,
  settingsGroup,
  type SettingsGroupId,
} from '@/lib/settings-nav';

import { requireSession } from '../guard';

/**
 * Resolves a section index URL (such as `/settings/organisation`) to the first sub-tab in that
 * section the signed-in person may open using live grants. Falls back to their first allowed
 * sub-tab elsewhere in Settings, or `/settings/denied` when none opens.
 */
export async function redirectToSectionStart(id: SettingsGroupId): Promise<never> {
  const group = settingsGroup(id);
  const session = await requireSession(group.href);
  const can = await getPermissionCheck(session);
  redirect(
    firstAllowedInGroup(id, can)?.href ?? firstAllowedSection(can)?.href ?? '/settings/denied',
  );
}
