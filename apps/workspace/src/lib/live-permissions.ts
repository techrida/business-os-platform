import 'server-only';

import { DEFAULT_ROLE_PERMISSIONS, type MeResponse } from '@bos/contracts';
import { cache } from 'react';

import { getMe } from './api';
import type { Session } from './session';

/**
 * The one `GET /v1/me` per render (React `cache` keys on the access token); null when it fails. Server Actions
 * and Route Handlers are not a render pass, so there it is a plain call per use (Next docs, data security).
 * `getGrants` and `getPermissions` both derive from it; read the failure rule on `liveGrantRows`.
 */
export const getMeOrNull = cache(async (accessToken: string): Promise<MeResponse | null> => {
  try {
    return await getMe({ accessToken });
  } catch {
    return null;
  }
});

/**
 * The live grant rows `/v1/me` reported, or undefined when that read failed or sent no list. Every caller that
 * gates on `/v1/me` handles undefined the same way (Kuu, leftovers Q5 = c):
 * - action controls hide: `getGrants` answers no grants, so a button the API might refuse is not offered;
 * - sidebar entries and page entry keep the built-in role defaults (`permissionsFrom`), so an outage does not
 *   shut everyone out of the pages they normally reach.
 * The API still decides every request.
 */
export function liveGrantRows(
  me: Pick<MeResponse, 'permissions'> | null,
): MeResponse['permissions'] {
  return me?.permissions;
}

function roleDefaults(roles: readonly string[]): readonly string[] {
  const defaults = DEFAULT_ROLE_PERMISSIONS as Record<string, object | undefined>;
  return [
    ...new Set(
      roles.flatMap((role) => {
        const granted = Object.hasOwn(defaults, role) ? defaults[role] : undefined;
        return granted === undefined ? [] : Object.keys(granted);
      }),
    ),
  ];
}

/**
 * The permissions to gate on: the live grants `/v1/me` reports (the rows Settings > Access edits, which the API
 * enforces). Only when that read fails or sends no list do the built-in role defaults stand in (`liveGrantRows`).
 */
export function permissionsFrom(
  me: Pick<MeResponse, 'permissions'> | null,
  roles: readonly string[],
): readonly string[] {
  const rows = liveGrantRows(me);
  if (rows === undefined) return roleDefaults(roles);
  return [...new Set(rows.map((grant) => grant.permission))];
}

/** `permissionsFrom` for the session user. Server-side only. */
export async function getPermissions(
  session: Pick<Session, 'accessToken' | 'roles'>,
): Promise<readonly string[]> {
  return permissionsFrom(await getMeOrNull(session.accessToken), session.roles);
}

/** `getPermissions` as the predicate the nav and settings helpers take. */
export async function getPermissionCheck(
  session: Pick<Session, 'accessToken' | 'roles'>,
): Promise<(permission: string) => boolean> {
  const held = new Set(await getPermissions(session));
  return (permission) => held.has(permission);
}
