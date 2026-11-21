import 'server-only';

import type { AccessScope, Permission } from '@bos/contracts';

import { getMeOrNull, liveGrantRows } from './live-permissions';
import type { Session } from './session';

/** The caller's live grants: each permission they hold, with the widest scope their roles give it. */
export type Grants = ReadonlyMap<Permission, AccessScope>;

const NONE: Grants = new Map();

/**
 * The session user's effective grants, from the API's live role rows (not `DEFAULT_ROLE_PERMISSIONS`), so a grant
 * an admin added or removed in the roles screen shows at once. Reads the shared per-render `getMeOrNull`; when
 * that read fails or sends no list it answers no grants, so action controls hide (`liveGrantRows`). Server-side
 * only.
 */
export async function getGrants(session: Pick<Session, 'accessToken'>): Promise<Grants> {
  const rows = liveGrantRows(await getMeOrNull(session.accessToken));
  if (rows === undefined) return NONE;
  return new Map(rows.map((g) => [g.permission, g.scope]));
}

/**
 * Whether the user holds `permission` at any scope: a page-level answer (show "New customer", the nav entry).
 * An `own` grant says nothing about one record; a control on a record gates on that record's `can` flags.
 */
export function hasGrant(grants: Grants, permission: Permission): boolean {
  return grants.has(permission);
}

/** The scope the user holds `permission` at, or undefined without it. */
export function grantScope(grants: Grants, permission: Permission): AccessScope | undefined {
  return grants.get(permission);
}
