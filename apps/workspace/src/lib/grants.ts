import 'server-only';

import type { Permission, Scope } from '@bos/contracts';
import { cache } from 'react';

import { getMe } from './api';
import type { Session } from './session';

/** The caller's live grants: each permission they hold, with the widest scope their roles give it. */
export type Grants = ReadonlyMap<Permission, Scope>;

const NONE: Grants = new Map();

/**
 * One `GET /v1/me` per render (React `cache` keys on the access token). Server Actions and Route Handlers are not
 * a render pass, so there it is a plain call per use (Next docs, data security). A failed call answers "no
 * grants": a control the API would refuse stays hidden, and the API still decides every request.
 */
const grantsFor = cache(async (accessToken: string): Promise<Grants> => {
  try {
    const me = await getMe({ accessToken });
    return new Map((me.permissions ?? []).map((g) => [g.permission, g.scope]));
  } catch {
    return NONE;
  }
});

/**
 * The session user's effective grants, from the API's live role rows (not `DEFAULT_ROLE_PERMISSIONS`), so a grant
 * an admin added or removed in the roles screen shows at once. Server-side only.
 */
export function getGrants(session: Pick<Session, 'accessToken'>): Promise<Grants> {
  return grantsFor(session.accessToken);
}

/**
 * Whether the user holds `permission` at any scope: a page-level answer (show "New customer", the nav entry).
 * An `own` grant says nothing about one record; a control on a record gates on that record's `can` flags.
 */
export function hasGrant(grants: Grants, permission: Permission): boolean {
  return grants.has(permission);
}

/** The scope the user holds `permission` at, or undefined without it. */
export function grantScope(grants: Grants, permission: Permission): Scope | undefined {
  return grants.get(permission);
}
