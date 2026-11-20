import 'server-only';

import { listUsers } from './api-admin';
import { getPermissionCheck } from './live-permissions';
import type { Session } from './session';

/** Names are a courtesy: denied or failed directory reads must not block business records. */
export async function userNames(session: Session): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  // The live grants decide, so a directory grant added or removed in Settings > Access applies at once.
  if (!(await getPermissionCheck(session))('admin.users.read')) return names;
  try {
    let after: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await listUsers(session, { limit: 200, ...(after ? { after } : {}) });
      for (const user of page.items) {
        const name = user.displayName?.trim() || 'Unnamed user';
        if (name) names.set(user.id, name);
      }
      after = page.nextAfter ?? undefined;
      if (after && seen.has(after)) break;
      if (after) seen.add(after);
    } while (after);
  } catch {
    // Keep any successfully loaded names; never substitute internal identifiers.
  }
  return names;
}
